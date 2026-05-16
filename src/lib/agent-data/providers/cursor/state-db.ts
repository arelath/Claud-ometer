import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import type { SessionMessageDisplay, TokenUsage } from '@/lib/claude-data/types';
import type { CachedModelUsage } from '@/lib/agent-data/session-summary';
import { blobToText, isSqliteAvailable, openDatabase, type SqliteDatabase } from '@/lib/sqlite';
import { asRecord, getCursorStateDbPath, getCursorWorkspaceStorageDir, getFileSignature, signatureToString } from './io';

export interface CursorConversationSummary {
  conversationId: string;
  title?: string;
  tldr?: string;
  model?: string;
  updatedAt?: string;
}

export interface CursorChatSessionInfo {
  sourceKind: 'chat';
  filePath: string;
  dbPath: string;
  nativeId: string;
  routeNativeId: string;
  projectId: string;
  projectDir: string;
  nativeProjectId: string;
  projectName: string;
  cwd: string;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  signature: string;
  sourceSignature: { mtimeMs: number; size: number };
  messages: SessionMessageDisplay[];
  tokenUsage: TokenUsage;
  model: string;
  models: string[];
  modelUsage: Record<string, CachedModelUsage>;
  toolsUsed: Record<string, number>;
  toolCallCount: number;
  searchTextPreview: string;
}

interface BubbleRow extends Record<string, unknown> {
  bubble_key: string;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  created_at: string | number | null;
  conversation_id: string | null;
  text: Uint8Array | string | null;
  text_length: number | null;
  bubble_type: number | null;
  code_blocks: Uint8Array | string | null;
}

interface AgentKvRow extends Record<string, unknown> {
  key: string;
  role: string | null;
  content: Uint8Array | string | null;
  request_id: string | null;
  content_length: number | null;
}

interface WorkspaceMeta {
  nativeProjectId: string;
  projectName: string;
  cwd: string;
}

interface MutableChatSession {
  conversationId: string;
  nativeProjectId: string;
  projectName: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messages: SessionMessageDisplay[];
  tokenUsage: TokenUsage;
  model: string;
  models: Set<string>;
  modelUsage: Record<string, CachedModelUsage>;
  toolsUsed: Record<string, number>;
  toolCallCount: number;
  searchableParts: string[];
}

interface DiscoveryCacheEntry {
  signature: string;
  sessions: CursorChatSessionInfo[];
  summaries: Map<string, CursorConversationSummary>;
}

const CHARS_PER_TOKEN = 4;
const SEARCH_PREVIEW_LIMIT = 8 * 1024;
const CURSOR_CHAT_DEFAULT_MODEL = 'cursor-auto';
const DEFAULT_PROJECT_ID = 'cursor';
const EMPTY_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const BUBBLE_QUERY = `
  SELECT
    key as bubble_key,
    COALESCE(json_extract(value, '$.tokenCount.inputTokens'), json_extract(value, '$.usage.input_tokens')) as input_tokens,
    COALESCE(json_extract(value, '$.tokenCount.outputTokens'), json_extract(value, '$.usage.output_tokens')) as output_tokens,
    COALESCE(
      json_extract(value, '$.modelInfo.modelName'),
      json_extract(value, '$.modelId'),
      json_extract(value, '$.model')
    ) as model,
    COALESCE(json_extract(value, '$.createdAt'), json_extract(value, '$.timestamp')) as created_at,
    json_extract(value, '$.conversationId') as conversation_id,
    CAST(json_extract(value, '$.text') AS BLOB) as text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
  ORDER BY ROWID ASC
`;

const AGENTKV_QUERY = `
  SELECT
    key,
    json_extract(value, '$.role') as role,
    CAST(json_extract(value, '$.content') AS BLOB) as content,
    json_extract(value, '$.providerOptions.cursor.requestId') as request_id,
    length(value) as content_length
  FROM cursorDiskKV
  WHERE key LIKE 'agentKv:blob:%'
    AND hex(substr(value, 1, 1)) = '7B'
  ORDER BY ROWID ASC
`;

const CONVERSATION_SUMMARY_QUERY = `
  SELECT conversationId, title, tldr, model, updatedAt
  FROM conversation_summaries
`;

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
let workspaceCacheKey = '';
let workspaceCache = new Map<string, WorkspaceMeta>();

function emptyUsage(): TokenUsage {
  return { ...EMPTY_USAGE };
}

export function estimateCursorTokens(charCountOrText: number | string): number {
  const charCount = typeof charCountOrText === 'string' ? charCountOrText.length : charCountOrText;
  return charCount > 0 ? Math.ceil(charCount / CHARS_PER_TOKEN) : 0;
}

export function resolveCursorModel(raw: string | null | undefined, defaultModel = CURSOR_CHAT_DEFAULT_MODEL): string {
  const trimmed = raw?.trim();
  return trimmed && trimmed !== 'default' ? trimmed : defaultModel;
}

function normalizeTimestamp(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return normalizeTimestamp(Number(trimmed));

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function parseComposerIdFromKey(key: string | undefined): string | null {
  if (!key) return null;
  const firstColon = key.indexOf(':');
  if (firstColon < 0) return null;
  const secondColon = key.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  const candidate = key.slice(firstColon + 1, secondColon);
  if (!candidate || /[\r\n\x00]/.test(candidate)) return null;
  return candidate;
}

function decodeWorkspaceUri(uri: string): string {
  if (!uri) return '';
  if (uri.startsWith('file://')) {
    try {
      const parsed = new URL(uri);
      let pathname = decodeURIComponent(parsed.pathname);
      if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
      return pathname.replace(/\//g, path.sep);
    } catch {
      return uri.replace(/^file:\/+/, '');
    }
  }

  return uri
    .replace(/^[^:]+:\/\//, '/')
    .replace(/\+/g, '-');
}

function encodeProjectIdFromPath(projectPath: string): string {
  const normalized = projectPath
    .replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
    .replace(/:/g, '')
    .replace(/[\\/]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_PROJECT_ID;
}

function workspaceMetaFromFolder(folder: string): WorkspaceMeta {
  const cwd = decodeWorkspaceUri(folder);
  const nativeProjectId = encodeProjectIdFromPath(cwd || folder);
  const parts = (cwd || folder).split(/[\\/]/).filter(Boolean);
  return {
    nativeProjectId,
    projectName: parts.at(-1) || nativeProjectId,
    cwd,
  };
}

function getWorkspaceMetadataSignature(dbPath: string): { mtimeMs: number; size: number; key: string } {
  const workspaceStorageDir = getCursorWorkspaceStorageDir(dbPath);
  if (!fs.existsSync(workspaceStorageDir)) return { mtimeMs: 0, size: 0, key: `${workspaceStorageDir}:missing` };

  const parts: string[] = [];
  let mtimeMs = 0;
  let size = 0;
  for (const entry of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = path.join(workspaceStorageDir, entry.name);
    for (const fileName of ['workspace.json', 'state.vscdb']) {
      const filePath = path.join(workspaceDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      const signature = getFileSignature(filePath);
      mtimeMs = Math.max(mtimeMs, signature.mtimeMs);
      size += signature.size;
      parts.push(`${filePath}:${signature.mtimeMs}:${signature.size}`);
    }
  }
  return { mtimeMs, size, key: parts.sort().join('|') };
}

function getCursorStateSignature(dbPath: string): { mtimeMs: number; size: number } {
  const dbSignature = getFileSignature(dbPath);
  const workspaceSignature = getWorkspaceMetadataSignature(dbPath);
  return {
    mtimeMs: Math.max(dbSignature.mtimeMs, workspaceSignature.mtimeMs),
    size: dbSignature.size + workspaceSignature.size,
  };
}

function collectComposerIds(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectComposerIds(item, found);
    return found;
  }

  const record = value as Record<string, unknown>;
  const composerId = record.composerId;
  if (typeof composerId === 'string' && composerId.trim()) found.add(composerId);
  for (const nested of Object.values(record)) collectComposerIds(nested, found);
  return found;
}

function loadWorkspaceMap(dbPath: string): Map<string, WorkspaceMeta> {
  const workspaceStorageDir = getCursorWorkspaceStorageDir(dbPath);
  const signature = getWorkspaceMetadataSignature(dbPath).key;
  if (workspaceCacheKey === signature) return workspaceCache;

  const map = new Map<string, WorkspaceMeta>();
  if (!fs.existsSync(workspaceStorageDir) || !isSqliteAvailable()) {
    workspaceCacheKey = signature;
    workspaceCache = map;
    return map;
  }

  for (const entry of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = path.join(workspaceStorageDir, entry.name);
    const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
    const workspaceDbPath = path.join(workspaceDir, 'state.vscdb');
    if (!fs.existsSync(workspaceJsonPath) || !fs.existsSync(workspaceDbPath)) continue;

    let folder = '';
    try {
      const parsed = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8'));
      folder = typeof parsed?.folder === 'string' ? parsed.folder : '';
    } catch {
      continue;
    }
    if (!folder) continue;

    let db: SqliteDatabase | null = null;
    try {
      db = openDatabase(workspaceDbPath);
      const rows = db.query<{ value: string }>("SELECT value FROM ItemTable WHERE key='composer.composerData'");
      const meta = workspaceMetaFromFolder(folder);
      for (const row of rows) {
        try {
          for (const composerId of collectComposerIds(JSON.parse(row.value))) {
            map.set(composerId, meta);
          }
        } catch {
          // Ignore malformed workspace metadata.
        }
      }
    } catch {
      // Workspace metadata is best-effort only.
    } finally {
      db?.close();
    }
  }

  workspaceCacheKey = signature;
  workspaceCache = map;
  return map;
}

function loadConversationSummaries(db: SqliteDatabase): Map<string, CursorConversationSummary> {
  const summaries = new Map<string, CursorConversationSummary>();
  try {
    const rows = db.query<{
      conversationId: string;
      title: string | null;
      tldr: string | null;
      model: string | null;
      updatedAt: string | number | null;
    }>(CONVERSATION_SUMMARY_QUERY);

    for (const row of rows) {
      if (!row.conversationId) continue;
      summaries.set(row.conversationId, {
        conversationId: row.conversationId,
        title: row.title || undefined,
        tldr: row.tldr || undefined,
        model: row.model || undefined,
        updatedAt: normalizeTimestamp(row.updatedAt) || undefined,
      });
    }
  } catch {
    // Older Cursor databases may not have this table.
  }
  return summaries;
}

function extractLanguages(codeBlocksJson: string): string[] {
  if (!codeBlocksJson.trim()) return [];
  try {
    const parsed = JSON.parse(codeBlocksJson);
    if (!Array.isArray(parsed)) return [];
    const languages = new Set<string>();
    for (const block of parsed) {
      const record = asRecord(block);
      const language = typeof record?.languageId === 'string' ? record.languageId : '';
      if (language && language !== 'plaintext') languages.add(language);
    }
    return Array.from(languages);
  } catch {
    return [];
  }
}

function addTool(toolsUsed: Record<string, number>, tool: string): void {
  toolsUsed[tool] = (toolsUsed[tool] || 0) + 1;
}

function addModelUsage(
  modelUsage: Record<string, CachedModelUsage>,
  model: string,
  inputTokens: number,
  outputTokens: number,
): void {
  const usage = modelUsage[model] || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
  };
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  modelUsage[model] = usage;
}

function updateSessionTime(session: MutableChatSession, timestamp: string): void {
  if (!timestamp) return;
  if (!session.createdAt || timestamp < session.createdAt) session.createdAt = timestamp;
  if (!session.updatedAt || timestamp > session.updatedAt) session.updatedAt = timestamp;
}

function createMutableSession(
  conversationId: string,
  workspaceMap: Map<string, WorkspaceMeta>,
  summaries: Map<string, CursorConversationSummary>,
  fallbackTimestamp: string,
): MutableChatSession {
  const workspace = workspaceMap.get(conversationId) || {
    nativeProjectId: DEFAULT_PROJECT_ID,
    projectName: 'Cursor',
    cwd: '',
  };
  const summary = summaries.get(conversationId);
  const model = resolveCursorModel(summary?.model, CURSOR_CHAT_DEFAULT_MODEL);
  return {
    conversationId,
    nativeProjectId: workspace.nativeProjectId,
    projectName: workspace.projectName,
    cwd: workspace.cwd,
    createdAt: summary?.updatedAt || fallbackTimestamp,
    updatedAt: summary?.updatedAt || fallbackTimestamp,
    title: summary?.title || summary?.tldr || '',
    messages: [],
    tokenUsage: emptyUsage(),
    model,
    models: new Set([model]),
    modelUsage: {},
    toolsUsed: {},
    toolCallCount: 0,
    searchableParts: [],
  };
}

function getSession(
  sessions: Map<string, MutableChatSession>,
  conversationId: string,
  workspaceMap: Map<string, WorkspaceMeta>,
  summaries: Map<string, CursorConversationSummary>,
  fallbackTimestamp: string,
): MutableChatSession {
  const existing = sessions.get(conversationId);
  if (existing) return existing;
  const created = createMutableSession(conversationId, workspaceMap, summaries, fallbackTimestamp);
  sessions.set(conversationId, created);
  return created;
}

function addBubbleRows(
  db: SqliteDatabase,
  sessions: Map<string, MutableChatSession>,
  workspaceMap: Map<string, WorkspaceMeta>,
  summaries: Map<string, CursorConversationSummary>,
  fallbackTimestamp: string,
): void {
  let rows: BubbleRow[];
  try {
    rows = db.query<BubbleRow>(BUBBLE_QUERY);
  } catch {
    return;
  }

  for (const row of rows) {
    const conversationId = parseComposerIdFromKey(row.bubble_key) || row.conversation_id || '';
    if (!conversationId) continue;

    const text = blobToText(row.text).trim();
    if (!text) continue;

    const role = row.bubble_type === 1 ? 'user' : 'assistant';
    let inputTokens = Number(row.input_tokens || 0);
    let outputTokens = Number(row.output_tokens || 0);
    const textLength = row.text_length || text.length;
    if (inputTokens === 0 && outputTokens === 0) {
      if (role === 'user') inputTokens = estimateCursorTokens(textLength);
      else outputTokens = estimateCursorTokens(textLength);
    }

    const timestamp = normalizeTimestamp(row.created_at) || fallbackTimestamp;
    const model = resolveCursorModel(row.model, summaries.get(conversationId)?.model ? resolveCursorModel(summaries.get(conversationId)?.model) : CURSOR_CHAT_DEFAULT_MODEL);
    const session = getSession(sessions, conversationId, workspaceMap, summaries, fallbackTimestamp);
    updateSessionTime(session, timestamp);
    session.model = session.model === CURSOR_CHAT_DEFAULT_MODEL ? model : session.model;
    session.models.add(model);
    session.tokenUsage.input_tokens += inputTokens;
    session.tokenUsage.output_tokens += outputTokens;
    addModelUsage(session.modelUsage, model, inputTokens, outputTokens);
    session.searchableParts.push(text);
    if (!session.title && role === 'user') session.title = firstLine(text);

    const languages = extractLanguages(blobToText(row.code_blocks));
    const toolCalls = languages.map(language => ({
      name: 'cursor:edit',
      id: `${row.bubble_key}:${language}`,
      summary: language,
      details: [{ key: 'language', label: 'Language', value: language }],
    }));
    if (toolCalls.length > 0) {
      addTool(session.toolsUsed, 'cursor:edit');
      for (const language of languages) addTool(session.toolsUsed, `lang:${language}`);
      session.toolCallCount += toolCalls.length;
    }

    session.messages.push({
      role,
      content: text,
      timestamp,
      model: role === 'assistant' ? model : undefined,
      usage: role === 'assistant' ? {
        ...EMPTY_USAGE,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      } : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
}

function extractContentText(contentText: string): { text: string; model?: string } {
  try {
    const parsed = JSON.parse(contentText);
    const parts = Array.isArray(parsed) ? parsed : [parsed];
    const textParts: string[] = [];
    let model: string | undefined;
    for (const part of parts) {
      if (typeof part === 'string') {
        textParts.push(part);
        continue;
      }
      const record = asRecord(part);
      if (!record) continue;
      if (typeof record.text === 'string') textParts.push(record.text);
      else if (typeof record.content === 'string') textParts.push(record.content);
      const providerOptions = asRecord(record.providerOptions);
      const cursor = asRecord(providerOptions?.cursor);
      if (typeof cursor?.modelName === 'string') model = cursor.modelName;
    }
    return { text: textParts.join('\n').trim(), model };
  } catch {
    return { text: contentText.trim() };
  }
}

function requestIdFromAgentKvKey(key: string): string {
  return key.split(':').filter(Boolean).at(-1) || 'agentKv';
}

function addAgentKvRows(
  db: SqliteDatabase,
  dbPath: string,
  sessions: Map<string, MutableChatSession>,
  workspaceMap: Map<string, WorkspaceMeta>,
  summaries: Map<string, CursorConversationSummary>,
  fallbackTimestamp: string,
): void {
  let rows: AgentKvRow[];
  try {
    rows = db.query<AgentKvRow>(AGENTKV_QUERY);
  } catch {
    return;
  }

  const timestamp = (() => {
    try {
      return new Date(fs.statSync(dbPath).mtimeMs).toISOString();
    } catch {
      return fallbackTimestamp;
    }
  })();

  let currentRequestId = '';
  for (const row of rows) {
    const role = row.role === 'assistant'
      ? 'assistant'
      : row.role === 'user'
        ? 'user'
        : row.role === 'tool'
          ? 'tool-result'
          : 'system';
    const contentText = blobToText(row.content);
    const extracted = extractContentText(contentText);
    if (!extracted.text) continue;

    const requestId = row.request_id || currentRequestId || requestIdFromAgentKvKey(row.key);
    currentRequestId = requestId;
    const session = getSession(sessions, requestId, workspaceMap, summaries, timestamp);
    const model = resolveCursorModel(extracted.model || summaries.get(requestId)?.model, CURSOR_CHAT_DEFAULT_MODEL);
    const tokenCount = estimateCursorTokens(extracted.text.length || row.content_length || 0);
    const inputTokens = role === 'assistant' ? 0 : tokenCount;
    const outputTokens = role === 'assistant' ? tokenCount : 0;

    updateSessionTime(session, timestamp);
    session.models.add(model);
    session.model = session.model === CURSOR_CHAT_DEFAULT_MODEL ? model : session.model;
    session.tokenUsage.input_tokens += inputTokens;
    session.tokenUsage.output_tokens += outputTokens;
    addModelUsage(session.modelUsage, model, inputTokens, outputTokens);
    session.searchableParts.push(extracted.text);
    if (!session.title && role === 'user') session.title = firstLine(extracted.text);
    session.messages.push({
      role,
      content: extracted.text,
      timestamp,
      model: role === 'assistant' ? model : undefined,
      usage: role === 'assistant' ? {
        ...EMPTY_USAGE,
        input_tokens: 0,
        output_tokens: outputTokens,
      } : undefined,
    });
  }
}

function toChatSessionInfo(dbPath: string, sourceSignature: { mtimeMs: number; size: number }, session: MutableChatSession): CursorChatSessionInfo {
  const nativeId = `chat:${session.conversationId}`;
  const routeNativeId = `${session.nativeProjectId}:${nativeId}`;
  const sourceFilePath = `${dbPath}#cursor-chat=${encodeURIComponent(session.conversationId)}`;
  return {
    sourceKind: 'chat',
    filePath: sourceFilePath,
    dbPath,
    nativeId,
    routeNativeId,
    projectId: session.nativeProjectId,
    projectDir: '',
    nativeProjectId: session.nativeProjectId,
    projectName: session.projectName,
    cwd: session.cwd,
    conversationId: session.conversationId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt || session.createdAt,
    title: session.title || firstLine(session.searchableParts.join(' ')),
    signature: signatureToString(sourceSignature),
    sourceSignature,
    messages: session.messages.sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    tokenUsage: session.tokenUsage,
    model: session.model,
    models: Array.from(session.models).filter(Boolean),
    modelUsage: session.modelUsage,
    toolsUsed: session.toolsUsed,
    toolCallCount: session.toolCallCount,
    searchTextPreview: session.searchableParts.join('\n').toLowerCase().slice(0, SEARCH_PREVIEW_LIMIT),
  };
}

function parseCursorStateDb(dbPath: string): DiscoveryCacheEntry {
  const sourceSignature = getCursorStateSignature(dbPath);
  const signature = signatureToString(sourceSignature);
  const cached = discoveryCache.get(dbPath);
  if (cached?.signature === signature) return cached;

  const empty: DiscoveryCacheEntry = { signature, sessions: [], summaries: new Map() };
  if (!fs.existsSync(dbPath) || !isSqliteAvailable()) {
    discoveryCache.set(dbPath, empty);
    return empty;
  }

  let db: SqliteDatabase | null = null;
  try {
    db = openDatabase(dbPath);
    const summaries = loadConversationSummaries(db);
    const workspaceMap = loadWorkspaceMap(dbPath);
    const fallbackTimestamp = sourceSignature.mtimeMs > 0
      ? new Date(sourceSignature.mtimeMs).toISOString()
      : new Date(0).toISOString();
    const sessions = new Map<string, MutableChatSession>();
    addBubbleRows(db, sessions, workspaceMap, summaries, fallbackTimestamp);
    addAgentKvRows(db, dbPath, sessions, workspaceMap, summaries, fallbackTimestamp);

    const parsed = {
      signature,
      summaries,
      sessions: Array.from(sessions.values())
        .filter(session => session.messages.length > 0)
        .map(session => toChatSessionInfo(dbPath, sourceSignature, session))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
    discoveryCache.set(dbPath, parsed);
    return parsed;
  } catch {
    discoveryCache.set(dbPath, empty);
    return empty;
  } finally {
    db?.close();
  }
}

export function discoverCursorChatSessions(dbPath = getCursorStateDbPath()): CursorChatSessionInfo[] {
  return parseCursorStateDb(dbPath).sessions;
}

export function getCursorConversationSummary(conversationId: string, dbPath = getCursorStateDbPath()): CursorConversationSummary | undefined {
  return parseCursorStateDb(dbPath).summaries.get(conversationId);
}

export function resetCursorStateDbCache(): void {
  discoveryCache.clear();
  workspaceCacheKey = '';
  workspaceCache = new Map();
}

export function resetCursorStateDbCacheForTests(): void {
  resetCursorStateDbCache();
}
