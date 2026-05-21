import fs from 'fs';
import path from 'path';
import { isSqliteAvailable, openDatabase, openWritableDatabase, type SqliteDatabase } from '@/lib/sqlite';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from './session-summary';
import { buildLegacyChangeEvents, buildLegacyUsageEvents } from './event-metrics';
import {
  clearSessionSummaryCache as clearJsonSessionSummaryCache,
  getSessionSummaryCacheDir,
  getSessionSummaryCachePath,
  getSessionSummaryCacheReadSignature,
  readSessionSummaryCache,
  sourceSummaryCacheKey,
  summaryCacheKey,
  writeSessionSummaryCache,
  isSummaryValidForSource,
  mergeUpdatedSummaries,
  type SessionSummaryCacheFile,
  type SessionSummaryCacheStatus,
} from './session-summary-cache';
import type { AgentKind } from './types';

const SQLITE_SCHEMA_VERSION = 1;
const SQLITE_CACHE_FILE = 'agentscope-session-index-v1.db';

interface MetaRow extends Record<string, unknown> {
  value: string;
}

interface CountRow extends Record<string, unknown> {
  count: number;
}

interface SourceKeyRow extends Record<string, unknown> {
  source_key: string;
}

interface SummaryPayloadRow extends Record<string, unknown> {
  payload_json: string;
}

interface TableColumnRow extends Record<string, unknown> {
  name: string;
}

export interface SessionSummaryIndexCommit {
  touchedProviders: AgentKind[];
  discoveredSources: SessionSummarySource[];
  updatedSummaries: CachedSessionSummary[];
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cache_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  source_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  source_file_path TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime_ms REAL NOT NULL,
  native_project_id TEXT,
  project_name TEXT,
  discovered_at TEXT NOT NULL,
  last_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS session_summaries (
  source_key TEXT PRIMARY KEY REFERENCES sources(source_key) ON DELETE CASCADE,
  route_id TEXT NOT NULL UNIQUE,
  native_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  native_project_id TEXT NOT NULL,
  project_route_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  source_file_path TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime_ms REAL NOT NULL,
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  title TEXT,
  cwd TEXT NOT NULL DEFAULT '',
  git_branch TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'unknown',
  message_count INTEGER NOT NULL DEFAULT 0,
  user_message_count INTEGER NOT NULL DEFAULT 0,
  assistant_message_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  added_lines INTEGER NOT NULL DEFAULT 0,
  removed_lines INTEGER NOT NULL DEFAULT 0,
  net_line_delta INTEGER NOT NULL DEFAULT 0,
  changed_lines INTEGER NOT NULL DEFAULT 0,
  changed_file_count INTEGER NOT NULL DEFAULT 0,
  edit_count INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summary_model_usage (
  source_key TEXT NOT NULL REFERENCES session_summaries(source_key) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER,
  max_output_tokens INTEGER,
  web_search_requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_key, model)
);

CREATE TABLE IF NOT EXISTS summary_tools (
  source_key TEXT NOT NULL REFERENCES session_summaries(source_key) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_count INTEGER NOT NULL,
  PRIMARY KEY (source_key, tool_name)
);

CREATE TABLE IF NOT EXISTS usage_events (
  source_key TEXT NOT NULL REFERENCES session_summaries(source_key) ON DELETE CASCADE,
  event_index INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  role TEXT,
  model TEXT NOT NULL DEFAULT 'unknown',
  message_count INTEGER NOT NULL DEFAULT 0,
  user_message_count INTEGER NOT NULL DEFAULT 0,
  assistant_message_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_api REAL NOT NULL DEFAULT 0,
  cost_conservative REAL NOT NULL DEFAULT 0,
  cost_subscription REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (source_key, event_index)
);

CREATE TABLE IF NOT EXISTS change_events (
  source_key TEXT NOT NULL REFERENCES session_summaries(source_key) ON DELETE CASCADE,
  event_index INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  added_lines INTEGER NOT NULL DEFAULT 0,
  removed_lines INTEGER NOT NULL DEFAULT 0,
  net_line_delta INTEGER NOT NULL DEFAULT 0,
  changed_lines INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  edit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_key, event_index)
);

CREATE INDEX IF NOT EXISTS idx_summaries_provider_created
  ON session_summaries(provider, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_summaries_provider_updated
  ON session_summaries(provider, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_summaries_project
  ON session_summaries(provider, project_route_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_session_summaries_project
  ON session_summaries(project_route_id);

CREATE INDEX IF NOT EXISTS idx_usage_events_time
  ON usage_events(timestamp_ms);

CREATE INDEX IF NOT EXISTS idx_usage_events_model
  ON usage_events(model);

CREATE INDEX IF NOT EXISTS idx_change_events_time
  ON change_events(timestamp_ms);
`;

const DROP_SCHEMA_SQL = `
DROP TABLE IF EXISTS change_events;
DROP TABLE IF EXISTS usage_events;
DROP TABLE IF EXISTS summary_tools;
DROP TABLE IF EXISTS summary_model_usage;
DROP TABLE IF EXISTS session_summaries;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS cache_meta;
`;

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function getSessionSummaryIndexPath(): string {
  return path.join(getSessionSummaryCacheDir(), SQLITE_CACHE_FILE);
}

function isSqliteIndexEnabled(): boolean {
  return isSqliteAvailable();
}

function emptyCacheFile(): SessionSummaryCacheFile {
  return { cacheVersion: SESSION_SUMMARY_CACHE_VERSION, generatedAt: '', summaries: [] };
}

function dateToMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMeta(db: SqliteDatabase, key: string): string {
  return db.get<MetaRow>('SELECT value FROM cache_meta WHERE key = ?', [key])?.value || '';
}

function setMeta(db: SqliteDatabase, key: string, value: string): void {
  db.run(
    'INSERT INTO cache_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

function bumpRevision(db: SqliteDatabase): void {
  const nextRevision = numberValue(getMeta(db, 'revision')) + 1;
  setMeta(db, 'revision', String(nextRevision));
}

function ensureColumn(db: SqliteDatabase, table: string, column: string, definition: string): void {
  const columns = new Set(db.query<TableColumnRow>(`PRAGMA table_info(${table})`).map(row => row.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function ensureSchemaCompatibility(db: SqliteDatabase): void {
  ensureColumn(db, 'usage_events', 'cost_api', 'cost_api REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'usage_events', 'cost_conservative', 'cost_conservative REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'usage_events', 'cost_subscription', 'cost_subscription REAL NOT NULL DEFAULT 0');
}

function initializeSchema(db: SqliteDatabase): void {
  db.exec(SCHEMA_SQL);
  const schemaVersion = getMeta(db, 'schema_version');
  const cacheVersion = getMeta(db, 'summary_cache_version');
  if (
    (schemaVersion && schemaVersion !== String(SQLITE_SCHEMA_VERSION))
    || (cacheVersion && cacheVersion !== String(SESSION_SUMMARY_CACHE_VERSION))
  ) {
    db.exec(DROP_SCHEMA_SQL);
    db.exec(SCHEMA_SQL);
  }

  ensureSchemaCompatibility(db);
  setMeta(db, 'schema_version', String(SQLITE_SCHEMA_VERSION));
  setMeta(db, 'summary_cache_version', String(SESSION_SUMMARY_CACHE_VERSION));
  if (!getMeta(db, 'revision')) setMeta(db, 'revision', '0');
}

function openIndexDatabase(readOnly = false): SqliteDatabase | null {
  if (!isSqliteIndexEnabled()) return null;
  const dbPath = getSessionSummaryIndexPath();
  if (readOnly && !fs.existsSync(dbPath)) return null;

  ensureDir(path.dirname(dbPath));
  const db = readOnly ? openDatabase(dbPath) : openWritableDatabase(dbPath);
  if (!readOnly) {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  initializeSchema(db);
  return db;
}

function parseSummaryRow(row: SummaryPayloadRow): CachedSessionSummary | null {
  try {
    const parsed = JSON.parse(row.payload_json) as CachedSessionSummary;
    if (parsed?.cacheVersion !== SESSION_SUMMARY_CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function summarySearchText(summary: CachedSessionSummary): string {
  return [
    summary.title,
    summary.projectName,
    summary.cwd,
    summary.gitBranch,
    summary.version,
    summary.model,
    ...summary.models,
    ...Object.keys(summary.toolsUsed || {}),
    summary.searchTextPreview,
  ].filter(Boolean).join('\n').toLowerCase();
}

function upsertSource(db: SqliteDatabase, source: SessionSummarySource, now: string): void {
  const sourceKey = sourceSummaryCacheKey(source);
  db.run(
    `INSERT INTO sources (
      source_key,
      provider,
      source_file_path,
      parser_version,
      source_size,
      source_mtime_ms,
      native_project_id,
      project_name,
      discovered_at,
      last_indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(source_key) DO UPDATE SET
      provider = excluded.provider,
      source_file_path = excluded.source_file_path,
      parser_version = excluded.parser_version,
      source_size = excluded.source_size,
      source_mtime_ms = excluded.source_mtime_ms,
      native_project_id = excluded.native_project_id,
      project_name = excluded.project_name,
      discovered_at = excluded.discovered_at`,
    [
      sourceKey,
      source.provider,
      source.sourceFilePath,
      source.parserVersion,
      source.sourceSignature.size,
      source.sourceSignature.mtimeMs,
      source.nativeProjectId || null,
      source.projectName || null,
      now,
    ],
  );
}

function upsertSourceForSummary(db: SqliteDatabase, summary: CachedSessionSummary, now: string): string {
  const sourceKey = summaryCacheKey(summary);
  db.run(
    `INSERT INTO sources (
      source_key,
      provider,
      source_file_path,
      parser_version,
      source_size,
      source_mtime_ms,
      native_project_id,
      project_name,
      discovered_at,
      last_indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      provider = excluded.provider,
      source_file_path = excluded.source_file_path,
      parser_version = excluded.parser_version,
      source_size = excluded.source_size,
      source_mtime_ms = excluded.source_mtime_ms,
      native_project_id = excluded.native_project_id,
      project_name = excluded.project_name,
      last_indexed_at = excluded.last_indexed_at`,
    [
      sourceKey,
      summary.provider,
      summary.sourceFilePath,
      summary.parserVersion,
      summary.sourceSignature.size,
      summary.sourceSignature.mtimeMs,
      summary.nativeProjectId,
      summary.projectName,
      now,
      now,
    ],
  );
  return sourceKey;
}

function upsertSummary(db: SqliteDatabase, summary: CachedSessionSummary, now: string): void {
  const sourceKey = upsertSourceForSummary(db, summary, now);
  const changeTotals = summary.changeTotals || {
    addedLines: 0,
    removedLines: 0,
    netLineDelta: 0,
    changedLines: 0,
    fileCount: 0,
    editCount: 0,
  };

  db.run(
    `INSERT INTO session_summaries (
      source_key,
      route_id,
      native_id,
      provider,
      parser_version,
      native_project_id,
      project_route_id,
      project_name,
      source_file_path,
      source_size,
      source_mtime_ms,
      created_at,
      created_at_ms,
      updated_at,
      updated_at_ms,
      title,
      cwd,
      git_branch,
      version,
      model,
      message_count,
      user_message_count,
      assistant_message_count,
      tool_call_count,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      reasoning_output_tokens,
      added_lines,
      removed_lines,
      net_line_delta,
      changed_lines,
      changed_file_count,
      edit_count,
      search_text,
      payload_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(source_key) DO UPDATE SET
      route_id = excluded.route_id,
      native_id = excluded.native_id,
      provider = excluded.provider,
      parser_version = excluded.parser_version,
      native_project_id = excluded.native_project_id,
      project_route_id = excluded.project_route_id,
      project_name = excluded.project_name,
      source_file_path = excluded.source_file_path,
      source_size = excluded.source_size,
      source_mtime_ms = excluded.source_mtime_ms,
      created_at = excluded.created_at,
      created_at_ms = excluded.created_at_ms,
      updated_at = excluded.updated_at,
      updated_at_ms = excluded.updated_at_ms,
      title = excluded.title,
      cwd = excluded.cwd,
      git_branch = excluded.git_branch,
      version = excluded.version,
      model = excluded.model,
      message_count = excluded.message_count,
      user_message_count = excluded.user_message_count,
      assistant_message_count = excluded.assistant_message_count,
      tool_call_count = excluded.tool_call_count,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      added_lines = excluded.added_lines,
      removed_lines = excluded.removed_lines,
      net_line_delta = excluded.net_line_delta,
      changed_lines = excluded.changed_lines,
      changed_file_count = excluded.changed_file_count,
      edit_count = excluded.edit_count,
      search_text = excluded.search_text,
      payload_json = excluded.payload_json`,
    [
      sourceKey,
      summary.routeId,
      summary.nativeId,
      summary.provider,
      summary.parserVersion,
      summary.nativeProjectId,
      summary.projectRouteId,
      summary.projectName,
      summary.sourceFilePath,
      summary.sourceSignature.size,
      summary.sourceSignature.mtimeMs,
      summary.createdAt,
      dateToMs(summary.createdAt),
      summary.updatedAt,
      dateToMs(summary.updatedAt),
      summary.title || null,
      summary.cwd || '',
      summary.gitBranch || '',
      summary.version || '',
      summary.model || 'unknown',
      summary.messageCount,
      summary.userMessageCount,
      summary.assistantMessageCount,
      summary.toolCallCount,
      summary.tokenTotals.input,
      summary.tokenTotals.output,
      summary.tokenTotals.cacheRead,
      summary.tokenTotals.cacheWrite,
      summary.tokenTotals.reasoningOutput || 0,
      changeTotals.addedLines,
      changeTotals.removedLines,
      changeTotals.netLineDelta,
      changeTotals.changedLines,
      changeTotals.fileCount,
      changeTotals.editCount,
      summarySearchText(summary),
      JSON.stringify(summary),
    ],
  );

  replaceModelUsage(db, sourceKey, summary);
  replaceTools(db, sourceKey, summary);
  replaceUsageEvents(db, sourceKey, summary);
  replaceChangeEvents(db, sourceKey, summary);
}

function replaceModelUsage(db: SqliteDatabase, sourceKey: string, summary: CachedSessionSummary): void {
  db.run('DELETE FROM summary_model_usage WHERE source_key = ?', [sourceKey]);
  for (const [model, usage] of Object.entries(summary.modelUsage || {})) {
    db.run(
      `INSERT INTO summary_model_usage (
        source_key,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_output_tokens,
        context_window,
        max_output_tokens,
        web_search_requests
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sourceKey,
        model,
        usage.inputTokens || 0,
        usage.outputTokens || 0,
        usage.cacheReadInputTokens || 0,
        usage.cacheCreationInputTokens || 0,
        usage.reasoningOutputTokens || 0,
        usage.contextWindow ?? null,
        usage.maxOutputTokens ?? null,
        usage.webSearchRequests || 0,
      ],
    );
  }
}

function replaceTools(db: SqliteDatabase, sourceKey: string, summary: CachedSessionSummary): void {
  db.run('DELETE FROM summary_tools WHERE source_key = ?', [sourceKey]);
  for (const [toolName, toolCount] of Object.entries(summary.toolsUsed || {})) {
    db.run(
      'INSERT INTO summary_tools (source_key, tool_name, tool_count) VALUES (?, ?, ?)',
      [sourceKey, toolName, toolCount],
    );
  }
}

function replaceUsageEvents(db: SqliteDatabase, sourceKey: string, summary: CachedSessionSummary): void {
  db.run('DELETE FROM usage_events WHERE source_key = ?', [sourceKey]);
  const events = summary.usageEvents?.length ? summary.usageEvents : buildLegacyUsageEvents(summary);
  for (const [index, event] of events.entries()) {
    db.run(
      `INSERT INTO usage_events (
        source_key,
        event_index,
        timestamp,
        timestamp_ms,
        role,
        model,
        message_count,
        user_message_count,
        assistant_message_count,
        tool_call_count,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_output_tokens,
        cost_api,
        cost_conservative,
        cost_subscription
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sourceKey,
        index,
        event.timestamp,
        dateToMs(event.timestamp),
        event.role || null,
        event.model || 'unknown',
        event.messageCount,
        event.userMessageCount,
        event.assistantMessageCount,
        event.toolCallCount,
        event.inputTokens,
        event.outputTokens,
        event.cacheReadTokens,
        event.cacheWriteTokens,
        event.reasoningOutputTokens || 0,
        event.estimatedCosts.api || 0,
        event.estimatedCosts.conservative || 0,
        event.estimatedCosts.subscription || 0,
      ],
    );
  }
}

function replaceChangeEvents(db: SqliteDatabase, sourceKey: string, summary: CachedSessionSummary): void {
  db.run('DELETE FROM change_events WHERE source_key = ?', [sourceKey]);
  const events = summary.changeEvents?.length
    ? summary.changeEvents
    : buildLegacyChangeEvents({
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        changeTotals: summary.changeTotals,
      });
  for (const [index, event] of events.entries()) {
    db.run(
      `INSERT INTO change_events (
        source_key,
        event_index,
        timestamp,
        timestamp_ms,
        added_lines,
        removed_lines,
        net_line_delta,
        changed_lines,
        file_count,
        edit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sourceKey,
        index,
        event.timestamp,
        dateToMs(event.timestamp),
        event.addedLines,
        event.removedLines,
        event.netLineDelta,
        event.changedLines,
        event.fileCount,
        event.editCount,
      ],
    );
  }
}

function readSummaries(db: SqliteDatabase, providers?: AgentKind[]): CachedSessionSummary[] {
  const rows = providers?.length
    ? db.query<SummaryPayloadRow>(
        `SELECT payload_json FROM session_summaries WHERE provider IN (${providers.map(() => '?').join(',')}) ORDER BY created_at DESC`,
        providers,
      )
    : db.query<SummaryPayloadRow>('SELECT payload_json FROM session_summaries ORDER BY provider ASC, source_file_path ASC');

  return rows
    .map(parseSummaryRow)
    .filter((summary): summary is CachedSessionSummary => Boolean(summary));
}

function importJsonCacheIfEmpty(db: SqliteDatabase): void {
  const count = numberValue(db.get<CountRow>('SELECT COUNT(*) as count FROM session_summaries')?.count);
  if (count > 0) return;

  const jsonCache = readSessionSummaryCache();
  if (jsonCache.summaries.length === 0) return;

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const summary of jsonCache.summaries) {
      upsertSummary(db, summary, now);
    }
    setMeta(db, 'generated_at', jsonCache.generatedAt || now);
    bumpRevision(db);
  });
}

function readSqliteCache(providers?: AgentKind[]): SessionSummaryCacheFile {
  const db = openIndexDatabase(false);
  if (!db) return readSessionSummaryCache();
  try {
    importJsonCacheIfEmpty(db);
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      generatedAt: getMeta(db, 'generated_at'),
      summaries: readSummaries(db, providers),
    };
  } finally {
    db.close();
  }
}

export function querySessionSummaryIndex<T>(callback: (db: SqliteDatabase) => T): T | null {
  const db = openIndexDatabase(false);
  if (!db) return null;
  try {
    importJsonCacheIfEmpty(db);
    return callback(db);
  } finally {
    db.close();
  }
}

function deleteMissingProviderSources(db: SqliteDatabase, provider: AgentKind, discoveredKeys: Set<string>): void {
  const rows = db.query<SourceKeyRow>('SELECT source_key FROM sources WHERE provider = ?', [provider]);
  for (const row of rows) {
    if (!discoveredKeys.has(row.source_key)) {
      db.run('DELETE FROM sources WHERE source_key = ?', [row.source_key]);
    }
  }
}

function commitSqliteIndex({ touchedProviders, discoveredSources, updatedSummaries }: SessionSummaryIndexCommit): void {
  const db = openIndexDatabase(false);
  if (!db) {
    const cache = readSessionSummaryCache();
    writeSessionSummaryCache({
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      summaries: mergeUpdatedSummaries(cache.summaries, updatedSummaries, discoveredSources),
    });
    return;
  }

  const now = new Date().toISOString();
  const discoveredKeysByProvider = new Map<AgentKind, Set<string>>();
  for (const source of discoveredSources) {
    const keys = discoveredKeysByProvider.get(source.provider) || new Set<string>();
    keys.add(sourceSummaryCacheKey(source));
    discoveredKeysByProvider.set(source.provider, keys);
  }

  try {
    db.transaction(() => {
      for (const source of discoveredSources) {
        upsertSource(db, source, now);
      }
      for (const provider of touchedProviders) {
        deleteMissingProviderSources(db, provider, discoveredKeysByProvider.get(provider) || new Set<string>());
      }
      for (const summary of updatedSummaries) {
        upsertSummary(db, summary, now);
      }
      setMeta(db, 'generated_at', now);
      bumpRevision(db);
    });
  } finally {
    db.close();
  }
}

export function readSessionSummaryIndexCache(): SessionSummaryCacheFile {
  if (!isSqliteIndexEnabled()) return readSessionSummaryCache();
  try {
    return readSqliteCache();
  } catch {
    return readSessionSummaryCache();
  }
}

export function readSessionSummaryIndexCacheForProviders(providers: AgentKind[]): SessionSummaryCacheFile {
  if (providers.length === 0) return emptyCacheFile();
  if (!isSqliteIndexEnabled()) {
    const cache = readSessionSummaryCache();
    return {
      ...cache,
      summaries: cache.summaries.filter(summary => providers.includes(summary.provider)),
    };
  }

  try {
    return readSqliteCache(providers);
  } catch {
    const cache = readSessionSummaryCache();
    return {
      ...cache,
      summaries: cache.summaries.filter(summary => providers.includes(summary.provider)),
    };
  }
}

export function getSessionSummaryIndexReadSignature(): string {
  if (!isSqliteIndexEnabled()) return `json:${getSessionSummaryCacheReadSignature()}`;
  const dbPath = getSessionSummaryIndexPath();
  if (!fs.existsSync(dbPath)) return 'sqlite:missing';

  let db: SqliteDatabase | null = null;
  try {
    const stat = fs.statSync(dbPath);
    db = openDatabase(dbPath);
    return [
      'sqlite',
      SQLITE_SCHEMA_VERSION,
      SESSION_SUMMARY_CACHE_VERSION,
      getMeta(db, 'revision') || '0',
      getMeta(db, 'generated_at'),
      stat.size,
      stat.mtimeMs,
    ].join(':');
  } catch {
    return `json:${getSessionSummaryCacheReadSignature()}`;
  } finally {
    db?.close();
  }
}

export function getValidSessionSummariesForSources(sources: SessionSummarySource[]): Map<string, CachedSessionSummary> {
  const cache = readSessionSummaryIndexCache();
  const summariesByKey = new Map(cache.summaries.map(summary => [summaryCacheKey(summary), summary]));
  const valid = new Map<string, CachedSessionSummary>();
  for (const source of sources) {
    const key = sourceSummaryCacheKey(source);
    const summary = summariesByKey.get(key);
    if (summary && isSummaryValidForSource(summary, source)) {
      valid.set(key, summary);
    }
  }
  return valid;
}

export function commitSessionSummaryIndex(commit: SessionSummaryIndexCommit): void {
  if (!isSqliteIndexEnabled()) {
    commitSqliteIndex(commit);
    return;
  }
  commitSqliteIndex(commit);
}

export function getSessionSummaryIndexStatus(
  activeProviders: AgentKind[],
  sources: SessionSummarySource[],
): SessionSummaryCacheStatus {
  const cache = readSessionSummaryIndexCache();
  const summariesByKey = new Map(cache.summaries.map(summary => [summaryCacheKey(summary), summary]));
  let validCount = 0;
  let staleCount = 0;

  for (const source of sources) {
    const summary = summariesByKey.get(sourceSummaryCacheKey(source));
    if (!summary) continue;
    if (isSummaryValidForSource(summary, source)) validCount++;
    else staleCount++;
  }

  const sourceKeys = new Set(sources.map(sourceSummaryCacheKey));
  const missingCount = cache.summaries.filter(summary => (
    activeProviders.includes(summary.provider)
    && !sourceKeys.has(summaryCacheKey(summary))
  )).length;
  const sqliteEnabled = isSqliteIndexEnabled();
  const cachePath = sqliteEnabled ? getSessionSummaryIndexPath() : getSessionSummaryCachePath();

  return {
    cachePath,
    exists: sqliteEnabled ? fs.existsSync(getSessionSummaryIndexPath()) : fs.existsSync(getSessionSummaryCachePath()),
    generatedAt: cache.generatedAt,
    summaryCount: cache.summaries.length,
    activeProviders,
    sourceCount: sources.length,
    validCount,
    staleCount,
    missingCount,
  };
}

export function clearSessionSummaryIndexCache(): void {
  clearJsonSessionSummaryCache();
  const dbPath = getSessionSummaryIndexPath();
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  }
}

export function writeSessionSummaryIndexCache(cache: SessionSummaryCacheFile): void {
  if (!isSqliteIndexEnabled()) {
    writeSessionSummaryCache(cache);
    return;
  }

  const db = openIndexDatabase(false);
  if (!db) {
    writeSessionSummaryCache(cache);
    return;
  }

  const database = db;
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      database.run('DELETE FROM sources');
      for (const summary of cache.summaries) {
        upsertSummary(database, summary, now);
      }
      setMeta(database, 'generated_at', cache.generatedAt || now);
      bumpRevision(database);
    });
  } finally {
    database.close();
  }
}

export function emptySessionSummaryIndexCache(): SessionSummaryCacheFile {
  return emptyCacheFile();
}
