import fs from 'fs';
import path from 'path';
import {
  asRecord,
  forEachCopilotJsonlLineSync,
  getCopilotDir,
  getCopilotWorkspaceStorageDir,
  getFileSignature,
  listCopilotChatSessionFiles,
  listCopilotTranscriptFiles,
  signatureToString,
} from './io';
import { getCopilotChatSessionSummary, isCopilotChatSessionFile } from './chat-session';

export interface CopilotSessionFileInfo {
  filePath: string;
  transcriptFilePath?: string;
  chatSessionFilePath?: string;
  nativeId: string;
  routeNativeId: string;
  workspaceHash: string;
  workspaceDir: string;
  workspaceJsonPath: string;
  nativeProjectId: string;
  projectName: string;
  cwd: string;
  workspaceUri?: string;
  createdAt: string;
  updatedAt: string;
  producer?: string;
  version?: string;
  vscodeVersion?: string;
  title?: string;
  signature: string;
  sourceSignature: { mtimeMs: number; size: number };
}

interface WorkspaceInfo {
  workspaceHash: string;
  workspaceDir: string;
  workspaceJsonPath: string;
  cwd: string;
  projectName: string;
  workspaceUri?: string;
}

interface DiscoveryCacheEntry {
  signature: string;
  value: CopilotSessionFileInfo[];
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

function getOptionalString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function decodeFileUri(value: string): string {
  if (!value.startsWith('file:')) return value;

  try {
    const url = new URL(value);
    let decoded = decodeURIComponent(url.pathname);
    if (process.platform === 'win32') {
      decoded = decoded.replace(/^\/([A-Za-z]:)/, '$1');
    }
    return path.normalize(decoded);
  } catch {
    return value;
  }
}

function basenameFromPath(value: string, fallback: string): string {
  const normalized = value.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || fallback;
}

function readWorkspaceInfo(workspaceDir: string): WorkspaceInfo {
  const workspaceHash = path.basename(workspaceDir);
  const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
  let workspaceUri: string | undefined;
  let cwd = '';

  if (fs.existsSync(workspaceJsonPath)) {
    try {
      const parsed = asRecord(JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8')));
      const workspace = parsed ? asRecord(parsed.workspace) : null;
      workspaceUri = getOptionalString(parsed, 'folder')
        || getOptionalString(parsed, 'workspace')
        || getOptionalString(workspace, 'folder')
        || getOptionalString(workspace, 'uri');
      cwd = workspaceUri ? decodeFileUri(workspaceUri) : '';
    } catch {
      cwd = '';
    }
  }

  return {
    workspaceHash,
    workspaceDir,
    workspaceJsonPath,
    cwd,
    workspaceUri,
    projectName: cwd ? basenameFromPath(cwd, workspaceHash) : workspaceHash,
  };
}

function fallbackIdFromFilename(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function getChatSessionFilePath(workspaceDir: string, nativeId: string): string | undefined {
  const filePath = path.join(workspaceDir, 'chatSessions', `${nativeId}.jsonl`);
  return fs.existsSync(filePath) ? filePath : undefined;
}

function combineSignatures(paths: string[]): { mtimeMs: number; size: number } {
  return paths.reduce(
    (combined, filePath) => {
      const signature = getFileSignature(filePath);
      return {
        size: combined.size + signature.size,
        mtimeMs: Math.max(combined.mtimeMs, signature.mtimeMs),
      };
    },
    { mtimeMs: 0, size: 0 },
  );
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function getWorkspaceDirFromSessionFile(filePath: string): string {
  if (filePath.replace(/\\/g, '/').includes('/GitHub.copilot-chat/transcripts/')) {
    return path.dirname(path.dirname(path.dirname(filePath)));
  }
  return path.dirname(path.dirname(filePath));
}

function getSessionNativeId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function getTranscriptFilePath(workspaceDir: string, nativeId: string): string | undefined {
  const filePath = path.join(workspaceDir, 'GitHub.copilot-chat', 'transcripts', `${nativeId}.jsonl`);
  return fs.existsSync(filePath) ? filePath : undefined;
}

function readSessionFileInfo(filePath: string, transcriptFilePath?: string, chatSessionFilePath?: string): CopilotSessionFileInfo {
  const workspaceDir = getWorkspaceDirFromSessionFile(filePath);
  const workspaceInfo = readWorkspaceInfo(workspaceDir);
  const chatSummary = chatSessionFilePath ? getCopilotChatSessionSummary(chatSessionFilePath) : undefined;

  let nativeId = fallbackIdFromFilename(filePath);
  let createdAt = chatSummary?.createdAt || '';
  let updatedAt = chatSummary?.updatedAt || '';
  let producer = '';
  let version = chatSummary?.version || '';
  let vscodeVersion = '';
  let title = chatSummary?.title || '';

  if (transcriptFilePath) {
    try {
      forEachCopilotJsonlLineSync(transcriptFilePath, record => {
      const data = asRecord(record.data) || {};
      const timestamp = record.timestamp || getOptionalString(data, 'timestamp');
      if (timestamp) {
        if (!createdAt) createdAt = timestamp;
        updatedAt = timestamp;
      }

      if (record.type === 'session.start') {
        nativeId = getOptionalString(data, 'sessionId') || nativeId;
        producer = getOptionalString(data, 'producer') || producer;
        version = getOptionalString(data, 'copilotVersion') || version;
        vscodeVersion = getOptionalString(data, 'vscodeVersion') || vscodeVersion;
        createdAt = getOptionalString(data, 'startTime') || createdAt || timestamp || '';
        updatedAt = timestamp || createdAt || updatedAt;
      } else if (record.type === 'user.message' && !title) {
        title = firstLine(getOptionalString(data, 'content') || '');
      }
    });
    } catch {
      // Fall back to transcript/chat session file metadata.
    }
  }

  nativeId = chatSummary?.nativeId || nativeId;
  chatSessionFilePath ||= getChatSessionFilePath(workspaceInfo.workspaceDir, nativeId)
    || getChatSessionFilePath(workspaceInfo.workspaceDir, fallbackIdFromFilename(filePath));
  const signaturePaths = [
    transcriptFilePath || filePath,
    workspaceInfo.workspaceJsonPath,
    ...(chatSessionFilePath ? [chatSessionFilePath] : []),
  ];
  const sourceSignature = combineSignatures(signaturePaths);
  const primarySignature = getFileSignature(filePath);
  const fallbackTimestamp = primarySignature.mtimeMs > 0
    ? new Date(primarySignature.mtimeMs).toISOString()
    : new Date(0).toISOString();
  createdAt ||= fallbackTimestamp;
  updatedAt ||= fallbackTimestamp;

  return {
    filePath,
    transcriptFilePath,
    chatSessionFilePath,
    nativeId,
    routeNativeId: `${workspaceInfo.workspaceHash}:${nativeId}`,
    workspaceHash: workspaceInfo.workspaceHash,
    workspaceDir: workspaceInfo.workspaceDir,
    workspaceJsonPath: workspaceInfo.workspaceJsonPath,
    nativeProjectId: workspaceInfo.workspaceHash,
    projectName: workspaceInfo.projectName,
    cwd: workspaceInfo.cwd,
    workspaceUri: workspaceInfo.workspaceUri,
    createdAt,
    updatedAt,
    producer,
    version,
    vscodeVersion,
    title,
    signature: signatureToString(sourceSignature),
    sourceSignature,
  };
}

function buildDiscoverySignature(files: string[]): string {
  return files
    .map(filePath => {
      const workspaceDir = getWorkspaceDirFromSessionFile(filePath);
      const nativeId = getSessionNativeId(filePath);
      const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
      const transcriptFilePath = getTranscriptFilePath(workspaceDir, nativeId);
      const chatSessionFilePath = getChatSessionFilePath(workspaceDir, nativeId);
      return [
        filePath,
        signatureToString(getFileSignature(filePath)),
        workspaceJsonPath,
        signatureToString(getFileSignature(workspaceJsonPath)),
        transcriptFilePath || '',
        transcriptFilePath ? signatureToString(getFileSignature(transcriptFilePath)) : '',
        chatSessionFilePath || '',
        chatSessionFilePath ? signatureToString(getFileSignature(chatSessionFilePath)) : '',
      ].join(':');
    })
    .join('|');
}

export async function discoverCopilotSessionFiles(): Promise<CopilotSessionFileInfo[]> {
  const copilotDir = getCopilotDir();
  const workspaceStorageDir = getCopilotWorkspaceStorageDir(copilotDir);
  const transcriptFiles = listCopilotTranscriptFiles(workspaceStorageDir);
  const chatSessionFiles = listCopilotChatSessionFiles(workspaceStorageDir).filter(isCopilotChatSessionFile);
  const sourceFilesBySession = new Map<string, { filePath: string; transcriptFilePath?: string; chatSessionFilePath?: string }>();

  for (const filePath of transcriptFiles) {
    const workspaceDir = getWorkspaceDirFromSessionFile(filePath);
    const nativeId = getSessionNativeId(filePath);
    const key = `${workspaceDir}:${nativeId}`;
    sourceFilesBySession.set(key, {
      filePath,
      transcriptFilePath: filePath,
      chatSessionFilePath: getChatSessionFilePath(workspaceDir, nativeId),
    });
  }

  for (const filePath of chatSessionFiles) {
    const workspaceDir = getWorkspaceDirFromSessionFile(filePath);
    const nativeId = getSessionNativeId(filePath);
    const key = `${workspaceDir}:${nativeId}`;
    const existing = sourceFilesBySession.get(key);
    sourceFilesBySession.set(key, {
      filePath: existing?.filePath || filePath,
      transcriptFilePath: existing?.transcriptFilePath || getTranscriptFilePath(workspaceDir, nativeId),
      chatSessionFilePath: filePath,
    });
  }

  const files = Array.from(sourceFilesBySession.values());
  if (files.length === 0) return [];

  const signature = buildDiscoverySignature(files.map(source => source.filePath));
  const cached = discoveryCache.get(copilotDir);
  if (cached?.signature === signature) return cached.value;

  const value = files.map(source => readSessionFileInfo(source.filePath, source.transcriptFilePath, source.chatSessionFilePath));
  value.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  discoveryCache.set(copilotDir, { signature, value });
  return value;
}

export function resetCopilotSessionIndexCacheForTests(): void {
  discoveryCache.clear();
}
