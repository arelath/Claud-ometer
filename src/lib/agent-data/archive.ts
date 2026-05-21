import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentKind } from './types';
import { getLiveCursorUserDir } from './data-source';
import { discoverCursorChatSessions } from './providers/cursor/state-db';

export const AGENT_ARCHIVE_ROOT = 'agent-data';
export const LEGACY_CLAUDE_ARCHIVE_ROOT = 'claude-data';

export interface AgentArchiveMeta {
  exportVersion: number;
  exportedAt: string;
  exportedFrom: string;
  platform: string;
  agents: AgentKind[];
  agentCounts: Partial<Record<AgentKind, { projectCount: number; sessionCount: number }>>;
}

const CODEX_EXCLUDED_NAMES = new Set([
  'auth.json',
  'cap_sid',
  'installation_id',
  'logs_2.sqlite',
]);

const CODEX_EXCLUDED_DIRS = new Set([
  '.sandbox',
  '.sandbox-bin',
  '.tmp',
  'tmp',
  'plugins',
  'skills',
]);

const COPILOT_EXCLUDED_NAMES = new Set([
  'api.json',
  'codebase-external.sqlite',
  'local-index.db',
  'workspace-chunks.db',
]);

const COPILOT_EXCLUDED_DIRS = new Set([
  'debug-logs',
  'memory-tool',
]);

const CURSOR_EXCLUDED_NAMES = new Set([
  'ai-code-tracking.db',
  'state.vscdb.options.json',
  'storage.json',
  'settings.json',
]);

const CURSOR_EXCLUDED_DIRS = new Set([
  'agent-tools',
  'assets',
  'cache',
  'extensions',
  'History',
  'mcps',
]);

export function toZipPath(...parts: string[]): string {
  return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function isExcludedCodexExportPath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const fileName = parts.at(-1) || '';
  if (CODEX_EXCLUDED_NAMES.has(fileName)) return true;
  if (fileName.endsWith('.sqlite') || fileName.endsWith('.sqlite3') || fileName.endsWith('.db')) return true;
  return parts.some(part => CODEX_EXCLUDED_DIRS.has(part));
}

export function isExcludedCopilotExportPath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const fileName = parts.at(-1) || '';
  if (COPILOT_EXCLUDED_NAMES.has(fileName)) return true;
  if (fileName.endsWith('.sqlite') || fileName.endsWith('.sqlite3') || fileName.endsWith('.db')) return true;
  if (/embeddings/i.test(fileName)) return true;
  return parts.some(part => COPILOT_EXCLUDED_DIRS.has(part));
}

export function isExcludedCursorExportPath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const fileName = parts.at(-1) || '';
  const normalized = parts.join('/');
  if (normalized === 'globalStorage/state.vscdb') return false;
  if (/^workspaceStorage\/[^/]+\/(?:state\.vscdb|workspace\.json)$/.test(normalized)) return false;
  if (fileName === 'state.vscdb') return true;
  if (CURSOR_EXCLUDED_NAMES.has(fileName)) return true;
  if (fileName.endsWith('.sqlite') || fileName.endsWith('.sqlite3') || fileName.endsWith('.db')) return true;
  return parts.some(part => CURSOR_EXCLUDED_DIRS.has(part));
}

export function getSafeImportTarget(importDir: string, relativePath: string): string | null {
  const normalizedRelative = path.normalize(relativePath);
  if (path.isAbsolute(normalizedRelative) || normalizedRelative.startsWith('..')) return null;
  const targetPath = path.join(importDir, normalizedRelative);
  const resolvedImportDir = path.resolve(importDir);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedImportDir && !resolvedTarget.startsWith(`${resolvedImportDir}${path.sep}`)) {
    return null;
  }
  return targetPath;
}

export function countClaudeData(claudeDir: string): { projectCount: number; sessionCount: number } {
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return { projectCount: 0, sessionCount: 0 };

  let projectCount = 0;
  let sessionCount = 0;
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    projectCount++;
    sessionCount += fs.readdirSync(path.join(projectsDir, entry.name)).filter(file => file.endsWith('.jsonl')).length;
  }
  return { projectCount, sessionCount };
}

function normalizeCodexProjectId(source: string): string {
  return source.replace(/^[A-Za-z]:/, match => match[0]).replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '') || 'codex';
}

function readFilePrefix(filePath: string, maxBytes = 128 * 1024): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function getOptionalString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getCodexProjectIdFromSessionFile(filePath: string, sessionsDir: string): string {
  for (const line of readFilePrefix(filePath).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const payload = asRecord(record?.payload);
      if (record?.type === 'session_meta' || record?.type === 'turn_context') {
        const cwd = getOptionalString(payload, 'cwd');
        if (cwd) return normalizeCodexProjectId(cwd);
      }
    } catch {
      // Ignore malformed or truncated lines in the metadata prefix.
    }
  }

  const fallback = path.relative(sessionsDir, path.dirname(filePath)) || path.dirname(filePath);
  return normalizeCodexProjectId(fallback);
}

export function countCodexData(codexDir: string): { projectCount: number; sessionCount: number } {
  const sessionsDir = path.join(codexDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return { projectCount: 0, sessionCount: 0 };

  let sessionCount = 0;
  const projectIds = new Set<string>();
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        sessionCount++;
        projectIds.add(getCodexProjectIdFromSessionFile(entryPath, sessionsDir));
      }
    }
  }

  return { projectCount: projectIds.size, sessionCount };
}

function getCopilotWorkspaceStorageDir(copilotDir: string): string {
  return path.basename(copilotDir).toLowerCase() === 'workspacestorage'
    ? copilotDir
    : path.join(copilotDir, 'workspaceStorage');
}

function getCopilotLegacySessionStateDir(copilotDir: string): string {
  if (path.basename(copilotDir).toLowerCase() === 'session-state') return copilotDir;
  const nested = path.join(copilotDir, 'session-state');
  if (fs.existsSync(nested) || copilotDir.replace(/\\/g, '/').includes('/agent-data/copilot')) return nested;

  const explicit = process.env.AGENT_SCOPE_COPILOT_LEGACY_DIR?.trim();
  if (explicit) {
    return path.basename(explicit).toLowerCase() === 'session-state'
      ? explicit
      : path.join(explicit, 'session-state');
  }

  if (process.env.AGENT_SCOPE_COPILOT_DIR?.trim() || process.env.AGENT_SCOPE_COPILOT_VSCODE_USER_DIR?.trim()) {
    return nested;
  }
  if (fs.existsSync(nested)) return nested;
  return path.join(os.homedir(), '.copilot', 'session-state');
}

function isCopilotChatSessionPrefix(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(32 * 1024);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return /GitHub Copilot|copilot\//i.test(buffer.subarray(0, bytesRead).toString('utf-8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function countCopilotData(copilotDir: string): { projectCount: number; sessionCount: number } {
  const workspaceStorageDir = getCopilotWorkspaceStorageDir(copilotDir);
  let projectCount = 0;
  let sessionCount = 0;
  const legacySessionStateDir = getCopilotLegacySessionStateDir(copilotDir);

  if (fs.existsSync(legacySessionStateDir)) {
    const legacyProjectIds = new Set<string>();
    for (const session of fs.readdirSync(legacySessionStateDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const eventsPath = path.join(legacySessionStateDir, session.name, 'events.jsonl');
      if (!fs.existsSync(eventsPath)) continue;
      sessionCount++;
      const workspaceYamlPath = path.join(legacySessionStateDir, session.name, 'workspace.yaml');
      let projectId = session.name;
      if (fs.existsSync(workspaceYamlPath)) {
        try {
          const match = fs.readFileSync(workspaceYamlPath, 'utf-8').match(/^cwd:\s*(.+)$/m);
          projectId = match?.[1]?.replace(/\s*#.*$/, '').replace(/^['"]|['"]$/g, '').trim() || projectId;
        } catch {
          projectId = session.name;
        }
      }
      legacyProjectIds.add(projectId);
    }
    projectCount += legacyProjectIds.size;
  }

  if (!fs.existsSync(workspaceStorageDir)) return { projectCount, sessionCount };

  for (const workspace of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const sessionIds = new Set<string>();
    const workspaceDir = path.join(workspaceStorageDir, workspace.name);
    const transcriptsDir = path.join(workspaceStorageDir, workspace.name, 'GitHub.copilot-chat', 'transcripts');
    if (fs.existsSync(transcriptsDir)) {
      for (const entry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          sessionIds.add(path.basename(entry.name, '.jsonl'));
        }
      }
    }

    const chatSessionsDir = path.join(workspaceDir, 'chatSessions');
    if (fs.existsSync(chatSessionsDir)) {
      for (const entry of fs.readdirSync(chatSessionsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(chatSessionsDir, entry.name);
        if (isCopilotChatSessionPrefix(filePath)) {
          sessionIds.add(path.basename(entry.name, '.jsonl'));
        }
      }
    }

    const workspaceSessions = sessionIds.size;
    if (workspaceSessions === 0) continue;
    projectCount++;
    sessionCount += workspaceSessions;
  }

  return { projectCount, sessionCount };
}

function getCursorProjectsDir(cursorDir: string): string {
  return path.basename(cursorDir).toLowerCase() === 'projects'
    ? cursorDir
    : path.join(cursorDir, 'projects');
}

export function countCursorData(cursorDir: string): { projectCount: number; sessionCount: number } {
  const projectsDir = getCursorProjectsDir(cursorDir);
  const projectIds = new Set<string>();
  let sessionCount = 0;

  if (fs.existsSync(projectsDir)) {
    for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const transcriptsDir = path.join(projectsDir, project.name, 'agent-transcripts');
      if (!fs.existsSync(transcriptsDir)) continue;

      let projectSessions = 0;
      const stack = [transcriptsDir];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(entryPath);
          else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.txt'))) {
            projectSessions++;
          }
        }
      }

      if (projectSessions === 0) continue;
      projectIds.add(project.name);
      sessionCount += projectSessions;
    }
  }

  const normalizedCursorDir = path.resolve(cursorDir);
  const importDir = path.resolve(process.env.AGENT_SCOPE_IMPORT_DIR?.trim() || path.join(process.cwd(), '.dashboard-data'));
  const isImportedCursorDir = normalizedCursorDir === importDir || normalizedCursorDir.startsWith(`${importDir}${path.sep}`);
  const colocatedDbPath = path.join(cursorDir, 'globalStorage', 'state.vscdb');
  const liveDbPath = path.join(getLiveCursorUserDir(), 'globalStorage', 'state.vscdb');
  const dbPath = fs.existsSync(colocatedDbPath) ? colocatedDbPath : isImportedCursorDir ? '' : liveDbPath;
  if (dbPath) {
    for (const session of discoverCursorChatSessions(dbPath)) {
      projectIds.add(session.nativeProjectId);
      sessionCount++;
    }
  }

  return { projectCount: projectIds.size, sessionCount };
}
