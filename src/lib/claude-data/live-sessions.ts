import fs from 'fs';
import os from 'os';
import path from 'path';
import type { LiveSessionInfo, LiveSessionStatus, SessionMessage } from './types';
import { getLiveClaudeDir } from './data-source';
import { isRecord } from './record-utils';
import { sessionMessageSchema } from './io';

const CACHE_TTL_MS = 5 * 60 * 1000;
const TRANSIENT_PARSE_GRACE_MS = 500;

interface LiveSessionCacheEntry {
  signature: string;
  parsedAtMs: number;
  value: LiveSessionInfo | null;
  lastValidValue: LiveSessionInfo | null;
}

interface TranscriptPreviewCacheEntry {
  signature: string;
  value: {
    messageCount: number;
    toolCallCount: number;
    lastPreview: string;
    activeToolName?: string;
    cacheLastActivityAtMs: number;
  };
}

const liveSessionCache = new Map<string, LiveSessionCacheEntry>();
const transcriptPreviewCache = new Map<string, TranscriptPreviewCacheEntry>();
const transcriptPathCache = new Map<string, string | null>();
let liveSessionsRevision = 0;
let watchedDir: string | null = null;
let dirWatcher: fs.FSWatcher | null = null;
const fileWatchers = new Map<string, fs.FSWatcher>();

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function getLiveSessionsDir(): string {
  const override = process.env.CLAUD_OMETER_LIVE_SESSIONS_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), '.claude', 'sessions');
}

function getLiveProjectsDir(): string {
  const override = process.env.CLAUD_OMETER_LIVE_PROJECTS_DIR?.trim();
  if (override) return override;
  return path.join(getLiveClaudeDir(), 'projects');
}

function getFileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function getOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toEpochMs(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = new Date(value).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function toIsoString(epochMs: number): string {
  const safeEpoch = Number.isFinite(epochMs) && epochMs > 0 ? epochMs : Date.now();
  return new Date(safeEpoch).toISOString();
}

function getProjectName(cwd: string | undefined, sessionId: string): string {
  if (!cwd) return sessionId.slice(0, 8);
  const normalized = normalizePath(cwd).replace(/\/$/, '');
  const basename = normalized.split('/').filter(Boolean).at(-1);
  return basename || sessionId.slice(0, 8);
}

function mapStatus(rawStatus: string | undefined): { status: LiveSessionStatus; reason: string } {
  const normalized = rawStatus?.toLowerCase();

  if (normalized === 'busy') {
    return { status: 'busy', reason: 'metadata status is busy' };
  }

  if (normalized === 'idle') {
    return { status: 'idle', reason: 'metadata status is idle' };
  }

  return {
    status: 'unknown',
    reason: rawStatus ? `unrecognized metadata status: ${rawStatus}` : 'metadata status is missing',
  };
}

function listLiveMetadataFiles(dirPath = getLiveSessionsDir()): string[] {
  if (!fs.existsSync(dirPath)) return [];

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function invalidateLiveSessionCache(filePath?: string): void {
  liveSessionsRevision += 1;
  if (filePath) {
    liveSessionCache.delete(filePath);
    return;
  }
  liveSessionCache.clear();
  transcriptPathCache.clear();
}

function watchLiveMetadataFile(filePath: string): void {
  if (fileWatchers.has(filePath) || !fs.existsSync(filePath)) return;

  try {
    const watcher = fs.watch(filePath, { persistent: false }, () => {
      invalidateLiveSessionCache(filePath);
    });
    watcher.on('error', () => {
      watcher.close();
      fileWatchers.delete(filePath);
    });
    fileWatchers.set(filePath, watcher);
  } catch {
    // Polling remains the fallback when fs.watch is unavailable.
  }
}

function syncWatchedFiles(dirPath: string): void {
  const files = new Set(listLiveMetadataFiles(dirPath));
  for (const filePath of files) watchLiveMetadataFile(filePath);

  for (const [filePath, watcher] of fileWatchers.entries()) {
    if (files.has(filePath)) continue;
    watcher.close();
    fileWatchers.delete(filePath);
    invalidateLiveSessionCache(filePath);
  }
}

export function ensureLiveSessionWatcher(): void {
  const dirPath = getLiveSessionsDir();
  if (watchedDir === dirPath && dirWatcher) {
    syncWatchedFiles(dirPath);
    return;
  }

  closeLiveSessionWatchers();
  watchedDir = dirPath;
  syncWatchedFiles(dirPath);

  if (!fs.existsSync(dirPath)) return;

  try {
    dirWatcher = fs.watch(dirPath, { persistent: false }, (_eventType, filename) => {
      if (filename) invalidateLiveSessionCache(path.join(dirPath, filename.toString()));
      else invalidateLiveSessionCache();
      syncWatchedFiles(dirPath);
    });
    dirWatcher.on('error', () => {
      dirWatcher?.close();
      dirWatcher = null;
    });
  } catch {
    // Polling remains the fallback when fs.watch is unavailable.
  }
}

function findTranscriptFileForSessionId(sessionId: string): string | null {
  if (transcriptPathCache.has(sessionId)) {
    const cachedPath = transcriptPathCache.get(sessionId) || null;
    if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
    if (cachedPath) transcriptPathCache.delete(sessionId);
  }

  const projectsDir = getLiveProjectsDir();
  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      transcriptPathCache.set(sessionId, candidate);
      return candidate;
    }
  }

  return null;
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts = content
    .map(block => {
      if (!isRecord(block)) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text.trim();
      if (block.type === 'tool_use' && typeof block.name === 'string') return `${block.name} tool call`;
      if (block.type === 'tool_result') return 'Tool result';
      return '';
    })
    .filter(Boolean);

  return parts.join(' ').trim();
}

function getMessagePreview(msg: SessionMessage): string {
  const content = msg.message?.content;
  const text = extractContentText(content);
  if (text) return text.replace(/\s+/g, ' ').slice(0, 160);

  if (msg.type === 'system' && msg.subtype) return msg.subtype;
  if (msg.type === 'attachment' && msg.attachment) return 'Attachment';
  return '';
}

function countToolCalls(msg: SessionMessage): number {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter(block => isRecord(block) && block.type === 'tool_use').length;
}

function getCacheActivityTimestampMs(msg: SessionMessage): number {
  if (msg.type !== 'user' && msg.type !== 'assistant') return 0;
  if (!msg.timestamp) return 0;
  return toEpochMs(msg.timestamp, 0);
}

function readTranscriptPreview(filePath: string | null): TranscriptPreviewCacheEntry['value'] & { signature?: string } {
  if (!filePath || !fs.existsSync(filePath)) {
    return { messageCount: 0, toolCallCount: 0, lastPreview: '', cacheLastActivityAtMs: 0 };
  }

  const signature = getFileSignature(filePath);
  const cached = transcriptPreviewCache.get(filePath);
  if (cached?.signature === signature) return { ...cached.value, signature };

  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  let toolCallCount = 0;
  let lastPreview = '';
  let activeToolName: string | undefined;
  let cacheLastActivityAtMs = 0;

  for (const line of lines) {
    try {
      const parsed = sessionMessageSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const msg = parsed.data as SessionMessage;
      cacheLastActivityAtMs = Math.max(cacheLastActivityAtMs, getCacheActivityTimestampMs(msg));
      const tools = countToolCalls(msg);
      toolCallCount += tools;
      if (tools > 0 && Array.isArray(msg.message?.content)) {
        const tool = msg.message.content.find(block => isRecord(block) && block.type === 'tool_use');
        activeToolName = isRecord(tool) && typeof tool.name === 'string' ? tool.name : activeToolName;
      }
      const preview = getMessagePreview(msg);
      if (preview) lastPreview = preview;
    } catch {
      // Ignore malformed transcript lines. The full reader does the same.
    }
  }

  const value = {
    messageCount: lines.length,
    toolCallCount,
    lastPreview,
    activeToolName,
    cacheLastActivityAtMs,
  };
  transcriptPreviewCache.set(filePath, { signature, value });
  return { ...value, signature };
}

function getEffectiveCacheExpiresAtMs(cacheLastActivityAtMs: number, status: LiveSessionStatus, nowMs: number): number {
  if (status === 'busy') return nowMs + CACHE_TTL_MS;
  return cacheLastActivityAtMs + CACHE_TTL_MS;
}

function getBusySinceAtMs(status: LiveSessionStatus, previous: LiveSessionInfo | null | undefined, fallbackMs: number): number | undefined {
  if (status !== 'busy') return undefined;
  if (previous?.status === 'busy' && previous.busySinceAtMs) return previous.busySinceAtMs;
  return fallbackMs;
}

function refreshLiveSessionTranscriptInfo(value: LiveSessionInfo): LiveSessionInfo {
  const nowMs = Date.now();
  const transcriptFilePath = findTranscriptFileForSessionId(value.sessionId) || undefined;
  const preview = readTranscriptPreview(transcriptFilePath || null);
  const mappedStatus = mapStatus(value.rawStatus);
  const cacheLastActivityAtMs = preview.cacheLastActivityAtMs || undefined;
  const cacheExpiresAtMs = cacheLastActivityAtMs
    ? getEffectiveCacheExpiresAtMs(cacheLastActivityAtMs, mappedStatus.status, nowMs)
    : undefined;
  const cachePaused = cacheLastActivityAtMs ? mappedStatus.status === 'busy' : undefined;
  const busySinceAtMs = getBusySinceAtMs(mappedStatus.status, value, value.updatedAtMs || nowMs);

  if (
    value.transcriptFilePath === transcriptFilePath
    && value.transcriptRevision === preview.signature
    && value.messageCount === preview.messageCount
    && value.toolCallCount === preview.toolCallCount
    && value.lastPreview === preview.lastPreview
    && value.status === mappedStatus.status
    && value.statusReason === mappedStatus.reason
    && value.cacheLastActivityAtMs === cacheLastActivityAtMs
    && value.cacheExpiresAtMs === cacheExpiresAtMs
    && value.cachePaused === cachePaused
    && value.busySinceAtMs === busySinceAtMs
  ) {
    return value;
  }

  return {
    ...value,
    transcriptFilePath,
    messageCount: preview.messageCount,
    toolCallCount: preview.toolCallCount,
    lastPreview: preview.lastPreview,
    activeToolName: mappedStatus.status === 'busy' ? preview.activeToolName : undefined,
    status: mappedStatus.status,
    statusReason: mappedStatus.reason,
    cacheLastActivityAt: cacheLastActivityAtMs ? toIsoString(cacheLastActivityAtMs) : undefined,
    cacheLastActivityAtMs,
    cacheExpiresAt: cacheExpiresAtMs ? toIsoString(cacheExpiresAtMs) : undefined,
    cacheExpiresAtMs,
    cachePaused,
    busySinceAt: busySinceAtMs ? toIsoString(busySinceAtMs) : undefined,
    busySinceAtMs,
    transcriptRevision: preview.signature,
  };
}

function parseLiveSessionFile(filePath: string, nowMs = Date.now()): LiveSessionInfo | null {
  const signature = getFileSignature(filePath);
  const cached = liveSessionCache.get(filePath);
  if (cached?.signature === signature) {
    if (!cached.value) return cached.value;
    const refreshed = refreshLiveSessionTranscriptInfo(cached.value);
    cached.value = refreshed;
    cached.lastValidValue = refreshed;
    return refreshed;
  }

  const previousValid = cached?.lastValidValue || null;
  const parsedAtMs = nowMs;

  try {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) throw new Error('empty live session metadata file');

    const metadata = JSON.parse(raw);
    if (!isRecord(metadata)) throw new Error('live session metadata is not an object');

    const fallbackId = path.basename(filePath);
    const sessionId = getOptionalString(metadata, 'sessionId') || fallbackId;
    const cwd = getOptionalString(metadata, 'cwd') || '';
    const rawStatus = getOptionalString(metadata, 'status');
    const startedAtMs = toEpochMs(metadata.startedAt, stat.birthtimeMs || stat.mtimeMs || nowMs);
    const updatedAtMs = toEpochMs(metadata.updatedAt, stat.mtimeMs || nowMs);
    const mappedStatus = mapStatus(rawStatus);
    const transcriptFilePath = findTranscriptFileForSessionId(sessionId) || undefined;
    const preview = readTranscriptPreview(transcriptFilePath || null);
    const cacheLastActivityAtMs = preview.cacheLastActivityAtMs || undefined;
    const cacheExpiresAtMs = cacheLastActivityAtMs
      ? getEffectiveCacheExpiresAtMs(cacheLastActivityAtMs, mappedStatus.status, nowMs)
      : undefined;
    const cachePaused = cacheLastActivityAtMs ? mappedStatus.status === 'busy' : undefined;
    const busySinceAtMs = getBusySinceAtMs(mappedStatus.status, previousValid, updatedAtMs || nowMs);

    const value: LiveSessionInfo = {
      id: sessionId,
      agentKind: 'claude',
      nativeId: sessionId,
      routeId: `claude:${sessionId}`,
      sessionId,
      metadataFilePath: filePath,
      transcriptFilePath,
      pid: getOptionalNumber(metadata, 'pid'),
      cwd,
      projectName: getProjectName(cwd, sessionId),
      version: getOptionalString(metadata, 'version'),
      kind: getOptionalString(metadata, 'kind'),
      entrypoint: getOptionalString(metadata, 'entrypoint'),
      startedAt: toIsoString(startedAtMs),
      lastActivityAt: toIsoString(updatedAtMs || stat.mtimeMs || nowMs),
      updatedAtMs,
      cacheLastActivityAt: cacheLastActivityAtMs ? toIsoString(cacheLastActivityAtMs) : undefined,
      cacheLastActivityAtMs,
      cacheExpiresAt: cacheExpiresAtMs ? toIsoString(cacheExpiresAtMs) : undefined,
      cacheExpiresAtMs,
      cachePaused,
      status: mappedStatus.status,
      rawStatus,
      statusReason: mappedStatus.reason,
      busySinceAt: busySinceAtMs ? toIsoString(busySinceAtMs) : undefined,
      busySinceAtMs,
      messageCount: preview.messageCount,
      toolCallCount: preview.toolCallCount,
      lastPreview: preview.lastPreview,
      activeToolName: mappedStatus.status === 'busy' ? preview.activeToolName : undefined,
      revision: `${signature}:${updatedAtMs}:${rawStatus || ''}:${liveSessionsRevision}`,
      transcriptRevision: preview.signature,
    };

    liveSessionCache.set(filePath, {
      signature,
      parsedAtMs,
      value,
      lastValidValue: value,
    });
    return value;
  } catch {
    const shouldKeepPrevious = previousValid && cached && nowMs - cached.parsedAtMs < TRANSIENT_PARSE_GRACE_MS;
    const value = shouldKeepPrevious ? previousValid : null;
    liveSessionCache.set(filePath, {
      signature,
      parsedAtMs,
      value,
      lastValidValue: previousValid,
    });
    return value;
  }
}

export function getLiveSessions(): LiveSessionInfo[] {
  ensureLiveSessionWatcher();

  return listLiveMetadataFiles()
    .map(filePath => parseLiveSessionFile(filePath))
    .filter((session): session is LiveSessionInfo => Boolean(session))
    .sort((left, right) => {
      const leftBusy = left.status === 'busy' ? 1 : 0;
      const rightBusy = right.status === 'busy' ? 1 : 0;
      return rightBusy - leftBusy
        || right.updatedAtMs - left.updatedAtMs
        || left.projectName.localeCompare(right.projectName);
    });
}

export function getLiveSessionBySessionId(sessionId: string): LiveSessionInfo | null {
  return getLiveSessions().find(session => session.sessionId === sessionId) || null;
}

export function getLiveSessionById(id: string): LiveSessionInfo | null {
  return getLiveSessions().find(session => session.id === id || session.sessionId === id) || null;
}

export function getLiveTranscriptFilePath(sessionId: string): string | null {
  return findTranscriptFileForSessionId(sessionId);
}

export function getLiveTranscriptRevision(sessionId: string): string | undefined {
  const filePath = findTranscriptFileForSessionId(sessionId);
  return filePath ? getFileSignature(filePath) : undefined;
}

export function closeLiveSessionWatchers(): void {
  dirWatcher?.close();
  dirWatcher = null;
  for (const watcher of fileWatchers.values()) watcher.close();
  fileWatchers.clear();
  watchedDir = null;
}

export function resetLiveSessionsForTests(): void {
  closeLiveSessionWatchers();
  liveSessionCache.clear();
  transcriptPreviewCache.clear();
  transcriptPathCache.clear();
  liveSessionsRevision = 0;
}
