import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getImportDir, setDataSource, setSelectedAgents } from '@/lib/claude-data/data-source';
import {
  AGENT_ARCHIVE_ROOT,
  LEGACY_CLAUDE_ARCHIVE_ROOT,
  countClaudeData,
  countCodexData,
  countCopilotData,
  countCursorData,
  getSafeImportTarget,
  type AgentArchiveMeta,
} from '@/lib/agent-data/archive';
import type { AgentKind } from '@/lib/agent-data/types';
import { getActiveProviders } from '@/lib/agent-data/registry';
import { resetAnalyticsMemo } from '@/lib/agent-data/analytics';
import { rebuildSessionIndex, resetSessionIndexer } from '@/lib/agent-data/indexer';

export const dynamic = 'force-dynamic';

function resetRuntimeCaches(): void {
  resetAnalyticsMemo();
  resetSessionIndexer();
  for (const provider of getActiveProviders()) provider.resetCache?.();
}

export const POST = withErrorHandler(async (request: Request) => {
  const formData = await request.formData();
  const file = formData.get('file') as File;

  if (!file) {
    apiError('No file provided', 400);
  }

  if (!file.name.endsWith('.zip')) {
    apiError('File must be a .zip archive', 400);
  }

  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const zipFileNames = Object.keys(zip.files);
  const hasAgentData = zipFileNames.some(f => f.startsWith(`${AGENT_ARCHIVE_ROOT}/`));
  const hasLegacyClaudeData = zipFileNames.some(f => f.startsWith(`${LEGACY_CLAUDE_ARCHIVE_ROOT}/`));
  if (!hasAgentData && !hasLegacyClaudeData) {
    apiError('Invalid archive: missing agent-data/ or claude-data/ directory.', 400);
  }

    const importDir = getImportDir();

    // Clean previous import
    if (fs.existsSync(importDir)) {
      fs.rmSync(importDir, { recursive: true, force: true });
    }
    fs.mkdirSync(importDir, { recursive: true });

    // Extract all files
    let fileCount = 0;
    let totalSize = 0;

    for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;

      const targetPath = getSafeImportTarget(importDir, relativePath);
      if (!targetPath) continue;
      const targetDir = path.dirname(targetPath);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const content = await zipEntry.async('nodebuffer');
      fs.writeFileSync(targetPath, content);
      fileCount++;
      totalSize += content.length;
    }

    // Read export metadata
    let exportMeta: Partial<AgentArchiveMeta> & { exportedAt?: string; exportedFrom?: string } = { exportedAt: 'unknown', exportedFrom: 'unknown' };
    const metaPath = hasAgentData
      ? path.join(importDir, AGENT_ARCHIVE_ROOT, 'export-meta.json')
      : path.join(importDir, LEGACY_CLAUDE_ARCHIVE_ROOT, 'export-meta.json');
    if (fs.existsSync(metaPath)) {
      exportMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    }

    const agents = (hasAgentData && Array.isArray(exportMeta.agents) ? exportMeta.agents : ['claude']) as AgentKind[];
    const agentCounts = exportMeta.agentCounts || {};
    if (!agentCounts.claude && (agents.includes('claude') || hasLegacyClaudeData)) {
      const claudeDir = hasAgentData
        ? path.join(importDir, AGENT_ARCHIVE_ROOT, 'claude')
        : path.join(importDir, LEGACY_CLAUDE_ARCHIVE_ROOT);
      agentCounts.claude = countClaudeData(claudeDir);
    }
    if (!agentCounts.codex && agents.includes('codex')) {
      agentCounts.codex = countCodexData(path.join(importDir, AGENT_ARCHIVE_ROOT, 'codex'));
    }
    if (!agentCounts.copilot && agents.includes('copilot')) {
      agentCounts.copilot = countCopilotData(path.join(importDir, AGENT_ARCHIVE_ROOT, 'copilot'));
    }
    if (!agentCounts.cursor && agents.includes('cursor')) {
      agentCounts.cursor = countCursorData(path.join(importDir, AGENT_ARCHIVE_ROOT, 'cursor'));
    }
    const projectCount = Object.values(agentCounts).reduce((sum, count) => sum + (count?.projectCount || 0), 0);
    const sessionCount = Object.values(agentCounts).reduce((sum, count) => sum + (count?.sessionCount || 0), 0);

    // Save import metadata
    const importMeta = {
      importedAt: new Date().toISOString(),
      exportedAt: exportMeta.exportedAt,
      exportedFrom: exportMeta.exportedFrom,
      projectCount,
      sessionCount,
      fileCount,
      totalSize,
      agents,
      agentCounts,
    };
    fs.writeFileSync(path.join(importDir, 'meta.json'), JSON.stringify(importMeta, null, 2));

    // Switch to imported data source
    setSelectedAgents(agents);
    setDataSource('imported');
    resetRuntimeCaches();
    void rebuildSessionIndex(getActiveProviders()).catch(() => {
      // Reconciliation resumes when a restarting sidecar becomes available.
    });

  return NextResponse.json({
    success: true,
    meta: importMeta,
  });
}, 'Import error', 'Failed to import data');

export const DELETE = withErrorHandler(async () => {
  const { clearImportedData, setDataSource: setSource } = await import('@/lib/claude-data/data-source');
  setSource('live');
  clearImportedData();
  return NextResponse.json({ success: true });
}, 'Clear import error', 'Failed to clear imported data');
