import fs from 'fs';
import path from 'path';
import { isSqliteAvailable, openDatabase, openWritableDatabase, type SqliteDatabase } from '@/lib/sqlite';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from './session-summary';
import { isSessionSourceRecentlyModified } from './source-stability';
import { buildLegacyChangeEvents, buildLegacyUsageEvents } from './event-metrics';
import type { SourceParseCheckpoint } from './session-parse-checkpoint';
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

interface OptionalMetaRow extends Record<string, unknown> {
  value?: string;
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

export interface SessionSummaryIndexMetadata {
  exists: boolean;
  generatedAt: string;
  revision: number;
  summaryCount: number;
  sourceCount: number;
  providerVersions: Array<{ provider: AgentKind; parserVersion: string; count: number }>;
  runtime?: SessionIndexerRuntimeStatus;
}

export interface SessionIndexerRuntimeStatus {
  state: 'ready' | 'building' | 'degraded' | 'paused';
  queueDepth: number;
  activeSources: number;
  pendingSources: number;
  failedSources: number;
  initialBuild: boolean;
  totalSources?: number;
  processedSources?: number;
  committedSources?: number;
  heapUsedBytes?: number;
  rssBytes?: number;
  currentProvider?: AgentKind;
  lastCommittedAt?: string;
  lastError?: string;
  run?: {
    id: string;
    state: 'queued' | 'running' | 'completed' | 'failed';
    startedAt?: string;
    completedAt?: string;
  };
}

interface CheckpointRow extends Record<string, unknown> {
  source_key: string;
  provider: AgentKind;
  parser_version: string;
  checkpoint_version: number;
  source_file_path: string;
  source_size: number;
  source_mtime_ms: number;
  last_complete_offset: number;
  record_count: number;
  component_state_json: string;
  accumulator_json: string;
  updated_at: string;
}

interface TableColumnRow extends Record<string, unknown> {
  name: string;
}

export interface SessionSummaryIndexCommit {
  touchedProviders: AgentKind[];
  discoveredSources: SessionSummarySource[];
  updatedSummaries: CachedSessionSummary[];
  updatedCheckpoints?: SourceParseCheckpoint[];
  deletedCheckpointKeys?: string[];
}

export interface SessionSummaryIndexSourceState {
  summary?: CachedSessionSummary;
  checkpoint?: SourceParseCheckpoint;
}

export interface SessionSummaryIndexSourceCommit {
  source: SessionSummarySource;
  summary: CachedSessionSummary;
  checkpoint?: SourceParseCheckpoint;
  deleteCheckpoint?: boolean;
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
  models_json TEXT NOT NULL DEFAULT '[]',
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
  compactions INTEGER NOT NULL DEFAULT 0,
  microcompactions INTEGER NOT NULL DEFAULT 0,
  compaction_tokens_saved INTEGER NOT NULL DEFAULT 0,
  compaction_timestamps_json TEXT NOT NULL DEFAULT '[]',
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

CREATE TABLE IF NOT EXISTS source_parse_checkpoints (
  source_key TEXT PRIMARY KEY REFERENCES sources(source_key) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  checkpoint_version INTEGER NOT NULL,
  source_file_path TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime_ms REAL NOT NULL,
  last_complete_offset INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  component_state_json TEXT NOT NULL DEFAULT '{}',
  accumulator_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
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
DROP TABLE IF EXISTS source_parse_checkpoints;
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

function getOptionalMeta(db: SqliteDatabase, key: string): string | undefined {
  return db.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', [key])?.value;
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
  ensureColumn(db, 'session_summaries', 'models_json', "models_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'session_summaries', 'compactions', 'compactions INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'session_summaries', 'microcompactions', 'microcompactions INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'session_summaries', 'compaction_tokens_saved', 'compaction_tokens_saved INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'session_summaries', 'compaction_timestamps_json', "compaction_timestamps_json TEXT NOT NULL DEFAULT '[]'");
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

  if (!readOnly) ensureDir(path.dirname(dbPath));
  const db = readOnly ? openDatabase(dbPath) : openWritableDatabase(dbPath);
  if (!readOnly) {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  if (!readOnly) initializeSchema(db);
  return db;
}

const INDEXER_RUNTIME_META_KEY = 'indexer_runtime_status_json';
const INDEX_COUNTS_META_KEY = 'index_counts_json';

interface PersistedIndexCounts {
  summaries: Partial<Record<AgentKind, number>>;
  sources: Partial<Record<AgentKind, number>>;
  providerVersions: Array<{ provider: AgentKind; parserVersion: string; count: number }>;
}

function refreshIndexCounts(db: SqliteDatabase): void {
  const summaryRows = db.query<{ provider: AgentKind; count: number }>(
    'SELECT provider, COUNT(*) AS count FROM session_summaries GROUP BY provider',
  );
  const sourceRows = db.query<{ provider: AgentKind; count: number }>(
    'SELECT provider, COUNT(*) AS count FROM sources GROUP BY provider',
  );
  const providerVersions = db.query<{ provider: AgentKind; parser_version: string; count: number }>(
    'SELECT provider, parser_version, COUNT(*) AS count FROM session_summaries GROUP BY provider, parser_version',
  ).map(row => ({ provider: row.provider, parserVersion: row.parser_version, count: numberValue(row.count) }));
  setMeta(db, INDEX_COUNTS_META_KEY, JSON.stringify({
    summaries: Object.fromEntries(summaryRows.map(row => [row.provider, numberValue(row.count)])),
    sources: Object.fromEntries(sourceRows.map(row => [row.provider, numberValue(row.count)])),
    providerVersions,
  } satisfies PersistedIndexCounts));
}

export function readSessionSummaryIndexMetadata(providers?: AgentKind[]): SessionSummaryIndexMetadata {
  const dbPath = getSessionSummaryIndexPath();
  if (!isSqliteIndexEnabled() || !fs.existsSync(dbPath)) {
    return { exists: false, generatedAt: '', revision: 0, summaryCount: 0, sourceCount: 0, providerVersions: [] };
  }

  let db: SqliteDatabase | null = null;
  try {
    db = openDatabase(dbPath);
    const countsRaw = db.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', [INDEX_COUNTS_META_KEY])?.value;
    let counts: PersistedIndexCounts = { summaries: {}, sources: {}, providerVersions: [] };
    try {
      if (countsRaw) counts = JSON.parse(countsRaw) as PersistedIndexCounts;
    } catch {
      counts = { summaries: {}, sources: {}, providerVersions: [] };
    }
    const selectedProviders = providers?.length ? new Set(providers) : undefined;
    const summaryCount = Object.entries(counts.summaries).reduce((total, [provider, count]) => (
      total + (!selectedProviders || selectedProviders.has(provider as AgentKind) ? numberValue(count) : 0)
    ), 0);
    const sourceCount = Object.entries(counts.sources).reduce((total, [provider, count]) => (
      total + (!selectedProviders || selectedProviders.has(provider as AgentKind) ? numberValue(count) : 0)
    ), 0);
    const providerVersions = counts.providerVersions.filter(item => !selectedProviders || selectedProviders.has(item.provider));
    const runtimeRaw = db.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', [INDEXER_RUNTIME_META_KEY])?.value;
    let runtime: SessionIndexerRuntimeStatus | undefined;
    try {
      runtime = runtimeRaw ? JSON.parse(runtimeRaw) as SessionIndexerRuntimeStatus : undefined;
    } catch {
      runtime = undefined;
    }
    return {
      exists: true,
      generatedAt: db.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', ['generated_at'])?.value || '',
      revision: numberValue(db.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', ['revision'])?.value),
      summaryCount,
      sourceCount,
      providerVersions,
      runtime,
    };
  } catch {
    return { exists: true, generatedAt: '', revision: 0, summaryCount: 0, sourceCount: 0, providerVersions: [] };
  } finally {
    db?.close();
  }
}

export function writeSessionIndexerRuntimeStatus(status: SessionIndexerRuntimeStatus): void {
  const db = openIndexDatabase(false);
  if (!db) return;
  try {
    setMeta(db, INDEXER_RUNTIME_META_KEY, JSON.stringify(status));
  } finally {
    db.close();
  }
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

function checkpointFromRow(row: CheckpointRow): SourceParseCheckpoint {
  return {
    sourceKey: row.source_key,
    provider: row.provider,
    parserVersion: row.parser_version,
    checkpointVersion: numberValue(row.checkpoint_version),
    sourceFilePath: row.source_file_path,
    sourceSize: numberValue(row.source_size),
    sourceMtimeMs: numberValue(row.source_mtime_ms),
    lastCompleteOffset: numberValue(row.last_complete_offset),
    recordCount: numberValue(row.record_count),
    componentStateJson: row.component_state_json || '{}',
    accumulatorJson: row.accumulator_json || '{}',
    updatedAt: row.updated_at,
  };
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
      models_json,
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
      compactions,
      microcompactions,
      compaction_tokens_saved,
      compaction_timestamps_json,
      search_text,
      payload_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      models_json = excluded.models_json,
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
      compactions = excluded.compactions,
      microcompactions = excluded.microcompactions,
      compaction_tokens_saved = excluded.compaction_tokens_saved,
      compaction_timestamps_json = excluded.compaction_timestamps_json,
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
      JSON.stringify(summary.models || []),
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
      summary.compaction?.compactions || 0,
      summary.compaction?.microcompactions || 0,
      summary.compaction?.totalTokensSaved || 0,
      JSON.stringify(summary.compaction?.compactionTimestamps || []),
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

function upsertCheckpoint(db: SqliteDatabase, checkpoint: SourceParseCheckpoint): void {
  db.run(
    `INSERT INTO source_parse_checkpoints (
      source_key,
      provider,
      parser_version,
      checkpoint_version,
      source_file_path,
      source_size,
      source_mtime_ms,
      last_complete_offset,
      record_count,
      component_state_json,
      accumulator_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      provider = excluded.provider,
      parser_version = excluded.parser_version,
      checkpoint_version = excluded.checkpoint_version,
      source_file_path = excluded.source_file_path,
      source_size = excluded.source_size,
      source_mtime_ms = excluded.source_mtime_ms,
      last_complete_offset = excluded.last_complete_offset,
      record_count = excluded.record_count,
      component_state_json = excluded.component_state_json,
      accumulator_json = excluded.accumulator_json,
      updated_at = excluded.updated_at`,
    [
      checkpoint.sourceKey,
      checkpoint.provider,
      checkpoint.parserVersion,
      checkpoint.checkpointVersion,
      checkpoint.sourceFilePath,
      checkpoint.sourceSize,
      checkpoint.sourceMtimeMs,
      checkpoint.lastCompleteOffset,
      checkpoint.recordCount,
      checkpoint.componentStateJson || '{}',
      checkpoint.accumulatorJson || '{}',
      checkpoint.updatedAt,
    ],
  );
}

function deleteCheckpoints(db: SqliteDatabase, sourceKeys: string[]): void {
  for (const sourceKey of sourceKeys) {
    db.run('DELETE FROM source_parse_checkpoints WHERE source_key = ?', [sourceKey]);
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

function readCheckpoints(db: SqliteDatabase, sources?: SessionSummarySource[]): Map<string, SourceParseCheckpoint> {
  const rows = db.query<CheckpointRow>('SELECT * FROM source_parse_checkpoints');
  const sourceKeys = sources ? new Set(sources.map(sourceSummaryCacheKey)) : null;
  const checkpoints = new Map<string, SourceParseCheckpoint>();

  for (const row of rows) {
    if (sourceKeys && !sourceKeys.has(row.source_key)) continue;
    checkpoints.set(row.source_key, checkpointFromRow(row));
  }

  return checkpoints;
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
    refreshIndexCounts(db);
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
  const db = openIndexDatabase(true);
  if (!db) return null;
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

const LAST_REFRESH_METRICS_META_KEY = 'last_refresh_metrics_json';

export function writeSessionSummaryIndexRefreshMetrics(metrics: unknown): void {
  if (!isSqliteIndexEnabled()) return;
  try {
    const db = openIndexDatabase(false);
    if (!db) return;
    try {
      setMeta(db, LAST_REFRESH_METRICS_META_KEY, JSON.stringify(metrics));
    } finally {
      db.close();
    }
  } catch {
    // Metrics are diagnostic-only and should never affect index refreshes.
  }
}

export function readSessionSummaryIndexRefreshMetrics<T>(): T | undefined {
  if (!isSqliteIndexEnabled()) return undefined;
  try {
    const db = openIndexDatabase(false);
    if (!db) return undefined;
    try {
      const raw = getOptionalMeta(db, LAST_REFRESH_METRICS_META_KEY);
      return raw ? JSON.parse(raw) as T : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function readSourceParseCheckpoints(sources?: SessionSummarySource[]): Map<string, SourceParseCheckpoint> {
  if (!isSqliteIndexEnabled()) return new Map();
  try {
    const db = openIndexDatabase(false);
    if (!db) return new Map();
    try {
      return readCheckpoints(db, sources);
    } finally {
      db.close();
    }
  } catch {
    return new Map();
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

function commitSqliteIndex({
  touchedProviders,
  discoveredSources,
  updatedSummaries,
  updatedCheckpoints = [],
  deletedCheckpointKeys = [],
}: SessionSummaryIndexCommit): void {
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
      deleteCheckpoints(db, deletedCheckpointKeys);
      for (const checkpoint of updatedCheckpoints) {
        upsertCheckpoint(db, checkpoint);
      }
      setMeta(db, 'generated_at', now);
      bumpRevision(db);
      refreshIndexCounts(db);
    });
  } finally {
    db.close();
  }
}

/**
 * Read only the persisted state needed to plan one source. The progressive
 * sidecar path deliberately avoids hydrating every payload_json row.
 */
export function readSessionSummaryIndexSourceState(
  source: SessionSummarySource,
): SessionSummaryIndexSourceState {
  if (!isSqliteIndexEnabled()) return {};
  const db = openIndexDatabase(true);
  if (!db) return {};
  try {
    const sourceKey = sourceSummaryCacheKey(source);
    const summaryRow = db.get<SummaryPayloadRow>(
      'SELECT payload_json FROM session_summaries WHERE source_key = ?',
      [sourceKey],
    );
    const checkpointRow = db.get<CheckpointRow>(
      'SELECT * FROM source_parse_checkpoints WHERE source_key = ?',
      [sourceKey],
    );
    return {
      summary: summaryRow ? parseSummaryRow(summaryRow) || undefined : undefined,
      checkpoint: checkpointRow ? checkpointFromRow(checkpointRow) : undefined,
    };
  } finally {
    db.close();
  }
}

/** Publish one successfully parsed source without applying corpus deletions. */
export function commitSessionSummaryIndexSource(commit: SessionSummaryIndexSourceCommit): void {
  const db = openIndexDatabase(false);
  if (!db) {
    commitSqliteIndex({
      touchedProviders: [],
      discoveredSources: [commit.source],
      updatedSummaries: [commit.summary],
      updatedCheckpoints: commit.checkpoint ? [commit.checkpoint] : [],
      deletedCheckpointKeys: commit.deleteCheckpoint ? [sourceSummaryCacheKey(commit.source)] : [],
    });
    return;
  }

  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      upsertSource(db, commit.source, now);
      upsertSummary(db, commit.summary, now);
      if (commit.deleteCheckpoint) deleteCheckpoints(db, [sourceSummaryCacheKey(commit.source)]);
      if (commit.checkpoint) upsertCheckpoint(db, commit.checkpoint);
      setMeta(db, 'generated_at', now);
      bumpRevision(db);
      refreshIndexCounts(db);
    });
  } finally {
    db.close();
  }
}

/**
 * Apply discovery metadata and missing-source deletion only after a complete
 * provider scan has finished. An interrupted progressive run never calls this.
 */
export function finalizeSessionSummaryIndexDiscovery(
  touchedProviders: AgentKind[],
  discoveredSources: SessionSummarySource[],
): void {
  commitSqliteIndex({
    touchedProviders,
    discoveredSources,
    updatedSummaries: [],
  });
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
  if (!isSqliteIndexEnabled()) return emptyCacheFile();
  const db = openIndexDatabase(true);
  if (!db) return emptyCacheFile();
  try {
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      generatedAt: getMeta(db, 'generated_at'),
      summaries: readSummaries(db, providers),
    };
  } catch {
    return emptyCacheFile();
  } finally {
    db.close();
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
    if (isSummaryValidForSource(summary, source, { allowPartial: isSessionSourceRecentlyModified(source) })) validCount++;
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
      refreshIndexCounts(database);
    });
  } finally {
    database.close();
  }
}

export function emptySessionSummaryIndexCache(): SessionSummaryCacheFile {
  return emptyCacheFile();
}
