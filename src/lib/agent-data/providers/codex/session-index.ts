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
  sessionId?: string;
  parentThreadId?: string;
  forkedFromId?: string;
  agentNickname?: string;
  agentRole?: string;
  agentPath?: string;
}

export interface CodexLogicalSessionMember {
  fileInfo: CodexSessionFileInfo;
  depth: number;
  isSubagent: boolean;
}

export interface CodexLogicalSessionInfo {
  root: CodexSessionFileInfo;
  members: CodexLogicalSessionMember[];
  sourceSignature: { size: number; mtimeMs: number };
  signatureKey: string;
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
  let sessionId = '';
  let parentThreadId = '';
  let forkedFromId = '';
  let agentNickname = '';
  let agentRole = '';
  let agentPath = '';
  let hasSessionMetadata = false;

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
        if (!hasSessionMetadata) {
          const git = asRecord(payload?.git);
          nativeId = getOptionalString(payload, 'id') || nativeId;
          sessionId = getOptionalString(payload, 'session_id') || '';
          parentThreadId = getOptionalString(payload, 'parent_thread_id') || '';
          forkedFromId = getOptionalString(payload, 'forked_from_id') || '';
          agentNickname = getOptionalString(payload, 'agent_nickname') || '';
          agentRole = getOptionalString(payload, 'agent_role') || '';
          agentPath = getOptionalString(payload, 'agent_path') || '';
          cwd = getOptionalString(payload, 'cwd') || cwd;
          version = getOptionalString(payload, 'cli_version') || getOptionalString(payload, 'version') || version;
          gitBranch = getOptionalString(git, 'branch')
            || getOptionalString(payload, 'git_branch')
            || getOptionalString(payload, 'gitBranch')
            || gitBranch;
          createdAt = getOptionalString(payload, 'timestamp') || createdAt;
          updatedAt = timestamp || updatedAt || createdAt;
          hasSessionMetadata = true;
        }
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
    sessionId: sessionId || undefined,
    parentThreadId: parentThreadId || undefined,
    forkedFromId: forkedFromId || undefined,
    agentNickname: agentNickname || undefined,
    agentRole: agentRole || undefined,
    agentPath: agentPath || undefined,
  };
}

function isExplicitSubagent(fileInfo: CodexSessionFileInfo): boolean {
  return Boolean(
    fileInfo.parentThreadId
    || fileInfo.agentPath
    || fileInfo.agentRole
    || fileInfo.agentNickname,
  );
}

function buildLogicalSessions(files: CodexSessionFileInfo[]): CodexLogicalSessionInfo[] {
  const filesById = new Map<string, CodexSessionFileInfo[]>();
  for (const fileInfo of files) {
    const matches = filesById.get(fileInfo.nativeId) || [];
    matches.push(fileInfo);
    filesById.set(fileInfo.nativeId, matches);
  }

  const uniqueFileById = new Map<string, CodexSessionFileInfo>();
  for (const [nativeId, matches] of filesById) {
    if (matches.length === 1) uniqueFileById.set(nativeId, matches[0]);
  }

  const parentOf = (fileInfo: CodexSessionFileInfo): CodexSessionFileInfo | undefined => {
    if (!isExplicitSubagent(fileInfo)) return undefined;
    const parentId = fileInfo.parentThreadId
      || (fileInfo.sessionId !== fileInfo.nativeId ? fileInfo.sessionId : undefined);
    if (!parentId || parentId === fileInfo.nativeId) return undefined;
    return uniqueFileById.get(parentId);
  };

  const resolveRoot = (fileInfo: CodexSessionFileInfo): CodexSessionFileInfo => {
    const visited = new Set<string>([fileInfo.filePath]);
    let current = fileInfo;
    while (true) {
      const parent = parentOf(current);
      if (!parent) return current;
      if (visited.has(parent.filePath)) return fileInfo;
      visited.add(parent.filePath);
      current = parent;
    }
  };

  const groups = new Map<string, CodexLogicalSessionMember[]>();
  for (const fileInfo of files) {
    const root = resolveRoot(fileInfo);
    let depth = 0;
    let current = fileInfo;
    const visited = new Set<string>();
    while (current.filePath !== root.filePath && !visited.has(current.filePath)) {
      visited.add(current.filePath);
      const parent = parentOf(current);
      if (!parent) break;
      depth++;
      current = parent;
    }
    const members = groups.get(root.filePath) || [];
    members.push({ fileInfo, depth, isSubagent: isExplicitSubagent(fileInfo) });
    groups.set(root.filePath, members);
  }

  return Array.from(groups.entries()).map(([rootPath, members]) => {
    members.sort((left, right) => {
      if (left.fileInfo.filePath === rootPath) return -1;
      if (right.fileInfo.filePath === rootPath) return 1;
      return left.depth - right.depth
        || left.fileInfo.createdAt.localeCompare(right.fileInfo.createdAt)
        || left.fileInfo.nativeId.localeCompare(right.fileInfo.nativeId)
        || left.fileInfo.filePath.localeCompare(right.fileInfo.filePath);
    });
    const root = members.find(member => member.fileInfo.filePath === rootPath)?.fileInfo || members[0].fileInfo;
    const signatures = members.map(member => ({
      path: member.fileInfo.filePath,
      signature: getFileSignature(member.fileInfo.filePath),
    }));
    return {
      root,
      members,
      sourceSignature: {
        size: signatures.reduce((sum, item) => sum + item.signature.size, 0),
        mtimeMs: Math.max(0, ...signatures.map(item => item.signature.mtimeMs)),
      },
      signatureKey: signatures
        .map(item => `${item.path}:${signatureToString(item.signature)}`)
        .sort()
        .join('|'),
    };
  }).sort((left, right) => right.root.updatedAt.localeCompare(left.root.updatedAt));
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

export async function discoverCodexLogicalSessions(): Promise<CodexLogicalSessionInfo[]> {
  return buildLogicalSessions(await discoverCodexSessionFiles());
}

export function resetCodexSessionIndexCache(): void {
  discoveryCache.clear();
}

export function resetCodexSessionIndexCacheForTests(): void {
  resetCodexSessionIndexCache();
}
