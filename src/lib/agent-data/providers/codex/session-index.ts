import fs from 'fs';
import path from 'path';
import { readCodexPrefix, getCodexDir, getFileSignature, listCodexSessionFiles, signatureToString } from './io';
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
  historyBase?: { threadId: string; endByteOffset: number };
  rolloutSegments?: Array<{ filePath: string; endOffset?: number }>;
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
  byFile: Map<string, { signature: string; info: CodexSessionFileInfo | null }>;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

function getOptionalString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fallbackIdFromFilename(filePath: string): string {
  const base = path.basename(filePath).replace(/\.jsonl(?:\.zst)?$/, '');
  // Replacement rollouts append _<file UUID> after the original thread UUID.
  const uuidMatch = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuidMatch?.[0] || base;
}

function fallbackDateFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/sessions\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!match) return new Date(0).toISOString();
  return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
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

async function readSessionFileInfo(filePath: string, fileSignature: ReturnType<typeof getFileSignature>): Promise<CodexSessionFileInfo | null> {
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
  let historyBase: CodexSessionFileInfo['historyBase'];

  try {
    // Most historical rollouts identify the workspace in the header. Keep
    // compressed discovery cheap, expanding the prefix for oversized headers.
    let prefix = await readCodexPrefix(filePath, filePath.endsWith('.zst') ? 128 * 1024 : undefined);
    if (!prefix.complete && !prefix.text.includes('\n')) prefix = await readCodexPrefix(filePath);
    const firstLine = prefix.text.split('\n', 1)[0];
    const header = JSON.parse(firstLine);
    if (header?.type !== 'session_meta' || typeof header.payload?.originator !== 'string'
      || !header.payload.originator.toLowerCase().startsWith('codex')) return null;
    if (!prefix.complete && filePath.endsWith('.zst') && !getOptionalString(header.payload, 'cwd')) {
      prefix = await readCodexPrefix(filePath);
    }
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
          const spawn = asRecord(asRecord(asRecord(payload?.source)?.subagent)?.thread_spawn);
          nativeId = getOptionalString(payload, 'id') || nativeId;
          sessionId = getOptionalString(payload, 'session_id') || '';
          parentThreadId = getOptionalString(payload, 'parent_thread_id') || getOptionalString(spawn, 'parent_thread_id') || '';
          forkedFromId = getOptionalString(payload, 'forked_from_id') || '';
          agentNickname = getOptionalString(payload, 'agent_nickname') || getOptionalString(spawn, 'agent_nickname') || '';
          agentRole = getOptionalString(payload, 'agent_role') || getOptionalString(spawn, 'agent_role') || '';
          agentPath = getOptionalString(payload, 'agent_path') || getOptionalString(spawn, 'agent_path') || '';
          const base = asRecord(payload?.history_base);
          const baseThread = getOptionalString(base, 'thread_id');
          if (baseThread && Number.isSafeInteger(base?.end_byte_offset) && (base?.end_byte_offset as number) >= 0) {
            historyBase = { threadId: baseThread, endByteOffset: base?.end_byte_offset as number };
          }
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
    return null;
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
    signature: signatureToString(fileSignature),
    sessionId: sessionId || undefined,
    parentThreadId: parentThreadId || undefined,
    forkedFromId: forkedFromId || undefined,
    agentNickname: agentNickname || undefined,
    agentRole: agentRole || undefined,
    agentPath: agentPath || undefined,
    historyBase,
  };
}

export function codexSessionFilePaths(fileInfo: CodexSessionFileInfo): string[] {
  return Array.from(new Set([fileInfo.filePath, ...(fileInfo.rolloutSegments || []).map(segment => segment.filePath)]));
}

function coalesceRolloutFiles(files: CodexSessionFileInfo[]): CodexSessionFileInfo[] {
  const byId = new Map<string, CodexSessionFileInfo[]>();
  for (const file of files) {
    const group = byId.get(file.nativeId) || [];
    group.push(file);
    byId.set(file.nativeId, group);
  }
  return Array.from(byId.values()).map(matches => {
    if (matches.length === 1) return matches[0];
    matches.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.updatedAt.localeCompare(right.updatedAt)
      || left.filePath.localeCompare(right.filePath));
    const selected = matches.at(-1)!;
    const segmentsFor = (index: number, endOffset?: number): NonNullable<CodexSessionFileInfo['rolloutSegments']> => {
      const file = matches[index];
      const base = file.historyBase;
      const segments: NonNullable<CodexSessionFileInfo['rolloutSegments']> = [];
      if (base?.threadId === file.nativeId && base.endByteOffset > 0) {
        const previous = index - 1;
        if (previous < 0) throw new Error(`Missing Codex history base for ${file.filePath}`);
        segments.push(...segmentsFor(previous, base.endByteOffset));
      }
      segments.push({ filePath: file.filePath, ...(endOffset == null ? {} : { endOffset }) });
      return segments;
    };
    const rolloutSegments = segmentsFor(matches.length - 1);
    const first = matches.find(file => file.filePath === rolloutSegments[0].filePath)!;
    return {
      ...selected,
      // Keep the original source key when a rollout is replaced; otherwise the
      // existing row still owns this route until discovery finalization.
      filePath: matches[0].filePath,
      createdAt: first.createdAt,
      rolloutSegments,
    };
  });
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
  files = coalesceRolloutFiles(files);
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
    const signatures = members.flatMap(member => codexSessionFilePaths(member.fileInfo).map(filePath => ({
      path: filePath,
      signature: getFileSignature(filePath),
    })));
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

export async function discoverCodexSessionFiles(): Promise<CodexSessionFileInfo[]> {
  const codexDir = getCodexDir();
  const files = listCodexSessionFiles().map(filePath => ({ filePath, stat: getFileSignature(filePath) }));
  if (files.length === 0) return [];

  const indexPath = getCodexSessionIndexPath();
  const signature = files.map(({ filePath, stat }) => `${filePath}:${signatureToString(stat)}`)
    .concat(`${indexPath}:${signatureToString(getFileSignature(indexPath))}`).join('|');
  const cached = discoveryCache.get(codexDir);
  if (cached?.signature === signature) return cached.value;

  const titleHints = readCodexSessionTitleHints(indexPath);
  const byFile: DiscoveryCacheEntry['byFile'] = new Map();
  const value: CodexSessionFileInfo[] = [];
  for (let offset = 0; offset < files.length; offset += 8) {
    const batch = await Promise.all(files.slice(offset, offset + 8).map(async ({ filePath, stat }) => {
      const fileSignature = signatureToString(stat);
      const previous = cached?.byFile.get(filePath);
      const entry = previous?.signature === fileSignature ? previous
        : { signature: fileSignature, info: await readSessionFileInfo(filePath, stat) };
      byFile.set(filePath, entry);
      return entry.info;
    }));
    for (const info of batch) {
      if (info) value.push({ ...info, title: titleHints.get(info.nativeId) });
    }
  }
  // During compression both encodings may briefly exist. Prefer the live
  // JSONL and keep distinct replacement segments of the same thread.
  const paths = new Set(value.map(info => info.filePath));
  const unique = value.filter(info => !info.filePath.endsWith('.zst') || !paths.has(info.filePath.slice(0, -4)));
  unique.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  discoveryCache.set(codexDir, { signature, value: unique, byFile });
  return unique;
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
