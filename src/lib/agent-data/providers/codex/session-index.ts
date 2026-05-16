import fs from 'fs';
import path from 'path';
import { FIRST_LINE_READ_CAP, getCodexDir, getFileSignature, listCodexSessionFiles, signatureToString } from './io';
import { asRecord } from './schema';

export interface CodexSessionFileInfo {
  filePath: string;
  nativeId: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model?: string;
  gitBranch?: string;
  version?: string;
  title?: string;
  signature: string;
}

interface DiscoveryCacheEntry {
  signature: string;
  value: CodexSessionFileInfo[];
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

function getOptionalString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fallbackIdFromFilename(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  const uuidMatch = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return uuidMatch?.[0] || base;
}

function fallbackDateFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/sessions\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!match) return new Date(0).toISOString();
  return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
}

function readFilePrefix(filePath: string, maxBytes = FIRST_LINE_READ_CAP): { text: string; complete: boolean } {
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf-8'),
      complete: bytesRead >= stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function getCodexSessionIndexPath(): string {
  return path.join(getCodexDir(), 'session_index.jsonl');
}

export function readCodexSessionTitleHints(indexPath = getCodexSessionIndexPath()): Map<string, string> {
  const hints = new Map<string, string>();
  if (!fs.existsSync(indexPath)) return hints;

  for (const line of fs.readFileSync(indexPath, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const id = getOptionalString(record, 'id') || getOptionalString(record, 'session_id') || getOptionalString(record, 'thread_id');
      const title = getOptionalString(record, 'title') || getOptionalString(record, 'name') || getOptionalString(record, 'thread_name');
      if (id && title) hints.set(id, title);
    } catch {
      // Ignore malformed title hint lines.
    }
  }

  return hints;
}

function readSessionFileInfo(filePath: string, titleHints: Map<string, string>): CodexSessionFileInfo {
  const fileSignature = getFileSignature(filePath);
  const fallbackTimestamp = fallbackDateFromPath(filePath);
  const mtimeTimestamp = fileSignature.mtimeMs > 0 ? new Date(fileSignature.mtimeMs).toISOString() : fallbackTimestamp;
  let nativeId = fallbackIdFromFilename(filePath);
  let createdAt = '';
  let updatedAt = '';
  let cwd = '';
  let model = '';
  let gitBranch = '';
  let version = '';

  try {
    const prefix = readFilePrefix(filePath);
    for (const line of prefix.text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let envelope: { type?: unknown; timestamp?: unknown; payload?: unknown };
      try {
        envelope = JSON.parse(line);
      } catch {
        continue;
      }

      const payload = asRecord(envelope.payload);
      const type = typeof envelope.type === 'string' ? envelope.type : '';
      const timestamp = getOptionalString(envelope as Record<string, unknown>, 'timestamp') || getOptionalString(payload, 'timestamp');
      if (timestamp) {
        if (!createdAt) createdAt = timestamp;
        updatedAt = timestamp;
      }

      if (type === 'session_meta') {
        const git = asRecord(payload?.git);
        nativeId = getOptionalString(payload, 'id') || nativeId;
        cwd = getOptionalString(payload, 'cwd') || cwd;
        version = getOptionalString(payload, 'cli_version') || getOptionalString(payload, 'version') || version;
        gitBranch = getOptionalString(git, 'branch')
          || getOptionalString(payload, 'git_branch')
          || getOptionalString(payload, 'gitBranch')
          || gitBranch;
        createdAt = getOptionalString(payload, 'timestamp') || createdAt;
        updatedAt = timestamp || updatedAt || createdAt;
      }

      if (type === 'turn_context') {
        cwd = getOptionalString(payload, 'cwd') || cwd;
        model = getOptionalString(payload, 'model') || model;
      }
    }
    if (!prefix.complete) {
      updatedAt = mtimeTimestamp;
    }
  } catch {
    // Fall back to filename and file timestamps if prefix metadata cannot be read.
    if (!createdAt) {
      createdAt = fallbackTimestamp;
      updatedAt = mtimeTimestamp;
    }
  }

  createdAt ||= fallbackTimestamp;
  updatedAt ||= mtimeTimestamp || createdAt;

  return {
    filePath,
    nativeId,
    createdAt,
    updatedAt,
    cwd,
    model,
    gitBranch,
    version,
    title: titleHints.get(nativeId),
    signature: signatureToString(fileSignature),
  };
}

function buildDiscoverySignature(files: string[], indexPath: string): string {
  const parts = files.map(filePath => `${filePath}:${signatureToString(getFileSignature(filePath))}`);
  parts.push(`${indexPath}:${signatureToString(getFileSignature(indexPath))}`);
  return parts.join('|');
}

export async function discoverCodexSessionFiles(): Promise<CodexSessionFileInfo[]> {
  const codexDir = getCodexDir();
  const files = listCodexSessionFiles();
  if (files.length === 0) return [];

  const indexPath = getCodexSessionIndexPath();
  const signature = buildDiscoverySignature(files, indexPath);
  const cached = discoveryCache.get(codexDir);
  if (cached?.signature === signature) return cached.value;

  const titleHints = readCodexSessionTitleHints(indexPath);
  const value = files.map(filePath => readSessionFileInfo(filePath, titleHints));
  value.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  discoveryCache.set(codexDir, { signature, value });
  return value;
}

export function resetCodexSessionIndexCache(): void {
  discoveryCache.clear();
}

export function resetCodexSessionIndexCacheForTests(): void {
  resetCodexSessionIndexCache();
}
