import fs from 'fs';
import path from 'path';
import type { AgentKind } from './types';

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
