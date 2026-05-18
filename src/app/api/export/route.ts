import { NextResponse } from 'next/server';
import archiver from 'archiver';
import fs from 'fs';
import os from 'os';
import { PassThrough } from 'stream';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { AGENT_ARCHIVE_ROOT, type AgentArchiveMeta, countClaudeData, countCodexData, countCopilotData, countCursorData, toZipPath } from '@/lib/agent-data/archive';
import { getAgentDataDir, getSelectedAgents } from '@/lib/agent-data/data-source';
import { addClaudeDataToArchive } from '@/lib/agent-data/providers/claude/export';
import { addCodexDataToArchive } from '@/lib/agent-data/providers/codex/export';
import { addCopilotDataToArchive } from '@/lib/agent-data/providers/copilot/export';
import { addCursorDataToArchive } from '@/lib/agent-data/providers/cursor/export';
import { addStandardizedDataToArchive } from '@/lib/agent-data/standardized-export';

export const dynamic = 'force-dynamic';

function hasExportableAgentData(agent: ReturnType<typeof getSelectedAgents>[number]): boolean {
  const agentDir = getAgentDataDir(agent);
  if (agent === 'cursor') return countCursorData(agentDir).sessionCount > 0;
  if (!fs.existsSync(agentDir)) return false;
  if (agent === 'copilot') return countCopilotData(agentDir).sessionCount > 0;
  return true;
}

export const GET = withErrorHandler(async () => {
  const agents = getSelectedAgents();
  const availableAgents = agents.filter(hasExportableAgentData);

  if (availableAgents.length === 0) {
    apiError('No selected agent data found', 404);
  }

    const passthrough = new PassThrough();
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.on('error', (err) => {
      throw err;
    });

    archive.pipe(passthrough);

    const agentCounts: AgentArchiveMeta['agentCounts'] = {};
    if (availableAgents.includes('claude')) {
      const claudeDir = getAgentDataDir('claude');
      addClaudeDataToArchive(archive, claudeDir, toZipPath(AGENT_ARCHIVE_ROOT, 'claude'));
      agentCounts.claude = countClaudeData(claudeDir);
    }
    if (availableAgents.includes('codex')) {
      const codexDir = getAgentDataDir('codex');
      addCodexDataToArchive(archive, codexDir, toZipPath(AGENT_ARCHIVE_ROOT, 'codex'));
      agentCounts.codex = countCodexData(codexDir);
    }
    if (availableAgents.includes('copilot')) {
      const copilotDir = getAgentDataDir('copilot');
      addCopilotDataToArchive(archive, copilotDir, toZipPath(AGENT_ARCHIVE_ROOT, 'copilot'));
      agentCounts.copilot = countCopilotData(copilotDir);
    }
    if (availableAgents.includes('cursor')) {
      const cursorDir = getAgentDataDir('cursor');
      addCursorDataToArchive(archive, cursorDir, toZipPath(AGENT_ARCHIVE_ROOT, 'cursor'));
      agentCounts.cursor = countCursorData(cursorDir);
    }

    const exportedAt = new Date().toISOString();
    await addStandardizedDataToArchive(archive, availableAgents, exportedAt);

    // Add raw export metadata
    const meta: AgentArchiveMeta = {
      exportVersion: 2,
      exportedAt,
      exportedFrom: os.hostname(),
      platform: process.platform,
      agents: availableAgents,
      agentCounts,
    };
    archive.append(JSON.stringify(meta, null, 2), { name: toZipPath(AGENT_ARCHIVE_ROOT, 'export-meta.json') });

    archive.finalize();

    // Collect all chunks
    const chunks: Buffer[] = [];
    for await (const chunk of passthrough) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `agent-data-${timestamp}.zip`;

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    },
  });
}, 'Export error', 'Failed to export data');
