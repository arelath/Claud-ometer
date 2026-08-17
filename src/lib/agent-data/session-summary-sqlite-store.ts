import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { isSqliteAvailable, openDatabase, openWritableDatabase, type SqliteDatabase } from '@/lib/sqlite';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from './session-summary';
import { isSessionSourceRecentlyModified } from './source-stability';
import { buildLegacyChangeEvents, buildLegacyUsageEvents } from './event-metrics';
import type { SourceParseCheckpoint } from './session-parse-checkpoint';
import type { IncrementalIndexMutations } from './provider';
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

const SQLITE_SCHEMA_VERSION = 2;
const SQLITE_CACHE_FILE = 'agentscope-session-index-v2.db';
const LEGACY_SQLITE_CACHE_FILE = 'agentscope-session-index-v1.db';

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

interface IndexStatusRow extends Record<string, unknown> {
  committed_revision: number;
  status_revision: number;
  state: SessionIndexerRuntimeStatus['state'];
  initial_build: number;
  queue_depth: number;
  active_sources: number;
  pending_sources: number;
  failed_sources: number;
  current_run_id?: string;
  current_run_state?: 'queued' | 'running' | 'completed' | 'failed';
  current_run_started_at?: string;
  current_run_completed_at?: string;
  total_sources: number;
  processed_sources: number;
  committed_sources: number;
  current_provider?: AgentKind;
  heap_used_bytes?: number;
  rss_bytes?: number;
  last_committed_at?: string;
  last_error?: string;
  migration_completed_at?: string;
}

export interface SessionSummaryIndexMetadata {
  exists: boolean;
  generatedAt: string;
  revision: number;
  statusRevision?: number;
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
  jobState?: string;
  retryAfter?: string;
  lastError?: string;
}

export interface SessionSummaryIndexSourceCommit {
  source: SessionSummarySource;
  summary: CachedSessionSummary;
  checkpoint?: SourceParseCheckpoint;
  mutations?: IncrementalIndexMutations;
  deleteCheckpoint?: boolean;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cache_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS index_status (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  committed_revision INTEGER NOT NULL DEFAULT 0,
  status_revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'building',
  initial_build INTEGER NOT NULL DEFAULT 1,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  active_source_key TEXT,
  active_sources INTEGER NOT NULL DEFAULT 0,
  discovered_sources INTEGER NOT NULL DEFAULT 0,
  indexed_sources INTEGER NOT NULL DEFAULT 0,
  pending_sources INTEGER NOT NULL DEFAULT 0,
  failed_sources INTEGER NOT NULL DEFAULT 0,
  current_run_id TEXT,
  current_run_state TEXT,
  current_run_started_at TEXT,
  current_run_completed_at TEXT,
  total_sources INTEGER NOT NULL DEFAULT 0,
  processed_sources INTEGER NOT NULL DEFAULT 0,
  committed_sources INTEGER NOT NULL DEFAULT 0,
  current_provider TEXT,
  heap_used_bytes INTEGER,
  rss_bytes INTEGER,
  last_reconciled_at TEXT,
  last_committed_at TEXT,
  last_error TEXT,
  migration_source TEXT,
  migration_completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS index_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'reconcile',
  providers_json TEXT NOT NULL DEFAULT '[]',
  force INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  total_sources INTEGER NOT NULL DEFAULT 0,
  processed_sources INTEGER NOT NULL DEFAULT 0,
  committed_sources INTEGER NOT NULL DEFAULT 0,
  failed_sources INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_reconciliations (
  provider TEXT PRIMARY KEY,
  scan_generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS source_sessions (
  source_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  checkpoint_version INTEGER,
  route_id TEXT UNIQUE,
  native_id TEXT,
  native_project_id TEXT,
  project_route_id TEXT,
  project_name TEXT,
  canonical_path TEXT NOT NULL,
  revision_kind TEXT NOT NULL DEFAULT 'legacy-signature-v1',
  desired_revision TEXT NOT NULL,
  indexed_revision TEXT,
  activity TEXT NOT NULL DEFAULT 'quiet',
  job_state TEXT NOT NULL DEFAULT 'pending',
  dirty INTEGER NOT NULL DEFAULT 1,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_after TEXT,
  run_id TEXT,
  last_error TEXT,
  published_generation INTEGER NOT NULL DEFAULT 0,
  next_generation INTEGER NOT NULL DEFAULT 1,
  last_seen_scan_generation INTEGER NOT NULL DEFAULT 0,
  aggregate_state_json TEXT NOT NULL DEFAULT '{}',
  discovered_at TEXT NOT NULL,
  last_indexed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_components (
  source_key TEXT NOT NULL REFERENCES source_sessions(source_key) ON DELETE CASCADE,
  component_key TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'legacy-primary',
  file_path TEXT,
  file_identity TEXT,
  observed_revision TEXT NOT NULL,
  observed_size INTEGER,
  observed_mtime_ms REAL,
  indexed_revision TEXT,
  indexed_size INTEGER,
  indexed_mtime_ms REAL,
  complete_offset INTEGER NOT NULL DEFAULT 0,
  boundary_hash TEXT,
  continuation_json TEXT NOT NULL DEFAULT '{}',
  last_seen_scan_generation INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_key, component_key)
);

CREATE TABLE IF NOT EXISTS source_generations (
  source_key TEXT NOT NULL REFERENCES source_sessions(source_key) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  target_revision TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  error TEXT,
  PRIMARY KEY (source_key, generation)
);

CREATE TABLE IF NOT EXISTS source_mutation_batches (
  source_key TEXT NOT NULL REFERENCES source_sessions(source_key) ON DELETE CASCADE,
  target_revision TEXT NOT NULL,
  digest TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (source_key, target_revision)
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
  generation INTEGER NOT NULL DEFAULT 1,
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
  generation INTEGER NOT NULL DEFAULT 1,
  tool_name TEXT NOT NULL,
  tool_count INTEGER NOT NULL,
  PRIMARY KEY (source_key, tool_name)
);

CREATE TABLE IF NOT EXISTS usage_events (
  source_key TEXT NOT NULL REFERENCES session_summaries(source_key) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1,
  component_key TEXT,
  record_identity TEXT,
  event_ordinal INTEGER,
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
  generation INTEGER NOT NULL DEFAULT 1,
  component_key TEXT,
  record_identity TEXT,
  event_ordinal INTEGER,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_stable_identity
  ON usage_events(source_key, generation, component_key, record_identity, event_ordinal)
  WHERE component_key IS NOT NULL AND record_identity IS NOT NULL AND event_ordinal IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_change_events_stable_identity
  ON change_events(source_key, generation, component_key, record_identity, event_ordinal)
  WHERE component_key IS NOT NULL AND record_identity IS NOT NULL AND event_ordinal IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_source_sessions_job
  ON source_sessions(job_state, retry_after, provider);

CREATE INDEX IF NOT EXISTS idx_source_sessions_seen
  ON source_sessions(provider, last_seen_scan_generation);
`;

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function getSessionSummaryIndexPath(): string {
  return path.join(getSessionSummaryCacheDir(), SQLITE_CACHE_FILE);
}

export function getLegacySessionSummaryIndexPath(): string {
  return path.join(getSessionSummaryCacheDir(), LEGACY_SQLITE_CACHE_FILE);
}

const REQUIRED_READ_TABLES = [
  'cache_meta',
  'session_summaries',
  'summary_model_usage',
  'summary_tools',
  'usage_events',
  'change_events',
];

function isReadableIndexDatabase(filePath: string, expectedSchemaVersion?: number): boolean {
  if (!fs.existsSync(filePath)) return false;
  let db: SqliteDatabase | null = null;
  try {
    db = openDatabase(filePath);
    const tableRows = db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_READ_TABLES.map(() => '?').join(',')})`,
      REQUIRED_READ_TABLES,
    );
    if (tableRows.length !== REQUIRED_READ_TABLES.length) return false;
    db.query(
      `SELECT source_key, route_id, native_id, provider, parser_version,
        native_project_id, project_route_id, project_name, source_file_path,
        source_size, source_mtime_ms, created_at, created_at_ms, updated_at,
        updated_at_ms, title, cwd, git_branch, version, model, models_json,
        message_count, user_message_count, assistant_message_count, tool_call_count,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_output_tokens, added_lines, removed_lines, net_line_delta,
        changed_lines, changed_file_count, edit_count, compactions,
        microcompactions, compaction_tokens_saved, compaction_timestamps_json,
        search_text, payload_json
       FROM session_summaries LIMIT 0`,
    );
    db.query('SELECT source_key, model, input_tokens, output_tokens FROM summary_model_usage LIMIT 0');
    db.query('SELECT source_key, tool_name, tool_count FROM summary_tools LIMIT 0');
    db.query('SELECT source_key, event_index, timestamp_ms FROM usage_events LIMIT 0');
    db.query('SELECT source_key, event_index, timestamp_ms FROM change_events LIMIT 0');
    if (expectedSchemaVersion == null) return true;
    const pragmaVersion = numberValue(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version);
    const schemaVersion = numberValue(db.get<OptionalMetaRow>(
      'SELECT value FROM cache_meta WHERE key = ?',
      ['schema_version'],
    )?.value);
    const cacheVersion = numberValue(db.get<OptionalMetaRow>(
      'SELECT value FROM cache_meta WHERE key = ?',
      ['summary_cache_version'],
    )?.value);
    const status = db.get<IndexStatusRow>('SELECT * FROM index_status WHERE singleton = 1');
    return pragmaVersion === expectedSchemaVersion
      && schemaVersion === expectedSchemaVersion
      && cacheVersion === SESSION_SUMMARY_CACHE_VERSION
      && Boolean(status?.migration_completed_at);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function getReadableSessionSummaryIndexPath(): string | null {
  const v2Path = getSessionSummaryIndexPath();
  if (isReadableIndexDatabase(v2Path, SQLITE_SCHEMA_VERSION)) return v2Path;
  const legacyPath = getLegacySessionSummaryIndexPath();
  return isReadableIndexDatabase(legacyPath) ? legacyPath : null;
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
  db.run(
    `UPDATE index_status
     SET committed_revision = ?, status_revision = status_revision + 1, updated_at = ?
     WHERE singleton = 1`,
    [nextRevision, new Date().toISOString()],
  );
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
  ensureColumn(db, 'index_status', 'current_run_started_at', 'current_run_started_at TEXT');
  ensureColumn(db, 'index_status', 'current_run_completed_at', 'current_run_completed_at TEXT');
}

function initializeSchema(db: SqliteDatabase): void {
  db.exec(SCHEMA_SQL);
  const schemaVersion = getMeta(db, 'schema_version');
  if (schemaVersion && schemaVersion !== String(SQLITE_SCHEMA_VERSION)) {
    throw new Error(`Unsupported session index schema ${schemaVersion}; expected ${SQLITE_SCHEMA_VERSION}.`);
  }

  ensureSchemaCompatibility(db);
  setMeta(db, 'schema_version', String(SQLITE_SCHEMA_VERSION));
  setMeta(db, 'summary_cache_version', String(SESSION_SUMMARY_CACHE_VERSION));
  if (!getMeta(db, 'revision')) setMeta(db, 'revision', '0');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO index_status (
      singleton, schema_version, committed_revision, status_revision, state,
      initial_build, updated_at
    ) VALUES (1, ?, ?, 0, 'building', 1, ?)
    ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version`,
    [SQLITE_SCHEMA_VERSION, numberValue(getMeta(db, 'revision')), now],
  );
  db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
}

let sharedWriterDatabase: SqliteDatabase | null = null;

function openIndexDatabase(readOnly = false): SqliteDatabase | null {
  if (!isSqliteIndexEnabled()) return null;
  if (!readOnly && sharedWriterDatabase) return sharedWriterDatabase;
  const dbPath = readOnly ? getReadableSessionSummaryIndexPath() : getSessionSummaryIndexPath();
  if (!dbPath || (readOnly && !fs.existsSync(dbPath))) return null;

  if (!readOnly) ensureDir(path.dirname(dbPath));
  const db = readOnly ? openDatabase(dbPath) : openWritableDatabase(dbPath);
  if (!readOnly) {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  if (!readOnly) {
    initializeSchema(db);
    importLegacyIndexIfEmpty(db);
  }
  return db;
}

function closeIndexDatabase(db: SqliteDatabase | null): void {
  if (db && db !== sharedWriterDatabase) db.close();
}

export function initializeSessionSummaryIndexWriter(): void {
  if (sharedWriterDatabase || !isSqliteIndexEnabled()) return;
  const dbPath = getSessionSummaryIndexPath();
  ensureDir(path.dirname(dbPath));
  const db = openWritableDatabase(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  initializeSchema(db);
  sharedWriterDatabase = db;
  importLegacyIndexIfEmpty(db);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.run(
      `UPDATE source_sessions SET job_state = 'pending', dirty = 1, updated_at = ?
       WHERE job_state = 'processing'`,
      [now],
    );
    db.run(
      `UPDATE source_generations SET state = 'abandoned', error = COALESCE(error, 'indexer restarted')
       WHERE state = 'staging'`,
    );
    db.run(
      `UPDATE index_runs SET state = 'queued', completed_at = NULL, updated_at = ?
       WHERE state = 'running'`,
      [now],
    );
  });
}

export function closeSessionSummaryIndexWriter(): void {
  const db = sharedWriterDatabase;
  sharedWriterDatabase = null;
  db?.close();
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
  const catalogCounts = db.get<{
    discovered: number;
    indexed: number;
    pending: number;
    failed: number;
  }>(
    `SELECT
      COUNT(*) AS discovered,
      SUM(CASE WHEN published_generation > 0 THEN 1 ELSE 0 END) AS indexed,
      SUM(CASE WHEN job_state IN ('pending', 'processing') OR dirty = 1 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN job_state = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM source_sessions`,
  );
  db.run(
    `UPDATE index_status SET
      discovered_sources = ?, indexed_sources = ?, pending_sources = ?, failed_sources = ?
     WHERE singleton = 1`,
    [
      numberValue(catalogCounts?.discovered),
      numberValue(catalogCounts?.indexed),
      numberValue(catalogCounts?.pending),
      numberValue(catalogCounts?.failed),
    ],
  );
}

export function readSessionSummaryIndexMetadata(providers?: AgentKind[]): SessionSummaryIndexMetadata {
  const dbPath = getReadableSessionSummaryIndexPath();
  if (!isSqliteIndexEnabled() || !dbPath || !fs.existsSync(dbPath)) {
    return { exists: false, generatedAt: '', revision: 0, summaryCount: 0, sourceCount: 0, providerVersions: [] };
  }

  let db: SqliteDatabase | null = null;
  let inReadTransaction = false;
  try {
    db = openDatabase(dbPath);
    db.exec('BEGIN');
    inReadTransaction = true;
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
    let indexStatus: IndexStatusRow | undefined;
    try {
      indexStatus = db.get<IndexStatusRow>('SELECT * FROM index_status WHERE singleton = 1');
    } catch {
      indexStatus = undefined;
    }
    let runtime: SessionIndexerRuntimeStatus | undefined;
    if (indexStatus) {
      runtime = {
        state: indexStatus.state,
        queueDepth: numberValue(indexStatus.queue_depth),
        activeSources: numberValue(indexStatus.active_sources),
        pendingSources: numberValue(indexStatus.pending_sources),
        failedSources: numberValue(indexStatus.failed_sources),
        initialBuild: Boolean(indexStatus.initial_build),
        totalSources: numberValue(indexStatus.total_sources),
        processedSources: numberValue(indexStatus.processed_sources),
        committedSources: numberValue(indexStatus.committed_sources),
        heapUsedBytes: indexStatus.heap_used_bytes == null ? undefined : numberValue(indexStatus.heap_used_bytes),
        rssBytes: indexStatus.rss_bytes == null ? undefined : numberValue(indexStatus.rss_bytes),
        currentProvider: indexStatus.current_provider,
        lastCommittedAt: indexStatus.last_committed_at,
        lastError: indexStatus.last_error,
        run: indexStatus.current_run_id && indexStatus.current_run_state ? {
          id: indexStatus.current_run_id,
          state: indexStatus.current_run_state,
          startedAt: indexStatus.current_run_started_at,
          completedAt: indexStatus.current_run_completed_at,
        } : undefined,
      };
    } else {
      const runtimeRaw = db.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', [INDEXER_RUNTIME_META_KEY])?.value;
      try {
        runtime = runtimeRaw ? JSON.parse(runtimeRaw) as SessionIndexerRuntimeStatus : undefined;
      } catch {
        runtime = undefined;
      }
    }
    const metadata: SessionSummaryIndexMetadata = {
      exists: true,
      generatedAt: db.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', ['generated_at'])?.value || '',
      revision: numberValue(indexStatus?.committed_revision ?? db.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', ['revision'])?.value),
      statusRevision: numberValue(indexStatus?.status_revision),
      summaryCount,
      sourceCount,
      providerVersions,
      runtime,
    };
    db.exec('COMMIT');
    inReadTransaction = false;
    return metadata;
  } catch {
    if (inReadTransaction) {
      try {
        db?.exec('ROLLBACK');
      } catch {
        // Preserve the read fallback when the connection has already failed.
      }
    }
    return { exists: true, generatedAt: '', revision: 0, summaryCount: 0, sourceCount: 0, providerVersions: [] };
  } finally {
    closeIndexDatabase(db);
  }
}

export function writeSessionIndexerRuntimeStatus(status: SessionIndexerRuntimeStatus): void {
  const db = openIndexDatabase(false);
  if (!db) return;
  try {
    db.transaction(() => {
      setMeta(db, INDEXER_RUNTIME_META_KEY, JSON.stringify(status));
      const now = new Date().toISOString();
      db.run(
        `UPDATE index_status SET
          status_revision = status_revision + 1,
          state = ?, initial_build = ?, queue_depth = ?,
          active_sources = ?, pending_sources = ?, failed_sources = ?,
          current_run_id = ?, current_run_state = ?, current_run_started_at = ?,
          current_run_completed_at = ?, total_sources = ?,
          processed_sources = ?, committed_sources = ?, current_provider = ?,
          heap_used_bytes = ?, rss_bytes = ?, last_committed_at = COALESCE(?, last_committed_at),
          last_error = ?, updated_at = ?
         WHERE singleton = 1`,
        [
          status.state,
          status.initialBuild ? 1 : 0,
          status.queueDepth,
          status.activeSources,
          status.pendingSources,
          status.failedSources,
          status.run?.id || null,
          status.run?.state || null,
          status.run?.startedAt || null,
          status.run?.completedAt || null,
          status.totalSources || 0,
          status.processedSources || 0,
          status.committedSources || 0,
          status.currentProvider || null,
          status.heapUsedBytes || null,
          status.rssBytes || null,
          status.lastCommittedAt || null,
          status.lastError || null,
          now,
        ],
      );
      if (status.run) {
        db.run(
          `INSERT INTO index_runs (
            run_id, state, total_sources, processed_sources, committed_sources,
            failed_sources, started_at, completed_at, last_error, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            state = excluded.state,
            total_sources = excluded.total_sources,
            processed_sources = excluded.processed_sources,
            committed_sources = excluded.committed_sources,
            failed_sources = excluded.failed_sources,
            started_at = COALESCE(excluded.started_at, index_runs.started_at),
            completed_at = excluded.completed_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at`,
          [
            status.run.id,
            status.run.state,
            status.totalSources || 0,
            status.processedSources || 0,
            status.committedSources || 0,
            status.failedSources,
            status.run.startedAt || null,
            status.run.completedAt || null,
            status.lastError || null,
            now,
          ],
        );
      }
    });
  } finally {
    closeIndexDatabase(db);
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

function legacySourceRevision(size: number, mtimeMs: number): string {
  return `${size}:${mtimeMs}`;
}

function upsertCatalogSource(db: SqliteDatabase, source: SessionSummarySource, now: string): void {
  const sourceKey = sourceSummaryCacheKey(source);
  const revision = legacySourceRevision(source.sourceSignature.size, source.sourceSignature.mtimeMs);
  db.run(
    `INSERT INTO source_sessions (
      source_key, provider, parser_version, canonical_path, desired_revision,
      native_project_id, project_name, discovered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      provider = excluded.provider,
      parser_version = excluded.parser_version,
      canonical_path = excluded.canonical_path,
      desired_revision = excluded.desired_revision,
      native_project_id = excluded.native_project_id,
      project_name = excluded.project_name,
      dirty = CASE WHEN source_sessions.indexed_revision = excluded.desired_revision THEN 0 ELSE 1 END,
      job_state = CASE
        WHEN source_sessions.indexed_revision = excluded.desired_revision THEN source_sessions.job_state
        WHEN source_sessions.job_state = 'failed' THEN 'failed'
        ELSE 'pending'
      END,
      updated_at = excluded.updated_at`,
    [
      sourceKey,
      source.provider,
      source.parserVersion,
      source.sourceFilePath,
      revision,
      source.nativeProjectId || null,
      source.projectName || null,
      now,
      now,
    ],
  );
  db.run(
    `INSERT INTO source_components (
      source_key, component_key, file_path, observed_revision, observed_size,
      observed_mtime_ms
    ) VALUES (?, 'legacy-primary', ?, ?, ?, ?)
    ON CONFLICT(source_key, component_key) DO UPDATE SET
      file_path = excluded.file_path,
      observed_revision = excluded.observed_revision,
      observed_size = excluded.observed_size,
      observed_mtime_ms = excluded.observed_mtime_ms,
      missing = 0`,
    [sourceKey, source.sourceFilePath, revision, source.sourceSignature.size, source.sourceSignature.mtimeMs],
  );
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
  upsertCatalogSource(db, source, now);
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
  upsertCatalogSource(db, {
    provider: summary.provider,
    parserVersion: summary.parserVersion,
    sourceFilePath: summary.sourceFilePath,
    sourceSignature: summary.sourceSignature,
    nativeProjectId: summary.nativeProjectId,
    projectName: summary.projectName,
  }, now);
  return sourceKey;
}

function upsertSummary(
  db: SqliteDatabase,
  summary: CachedSessionSummary,
  now: string,
  replaceEvents = true,
): void {
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
  if (replaceEvents) {
    replaceUsageEvents(db, sourceKey, summary);
    replaceChangeEvents(db, sourceKey, summary);
  }
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

function applyStableUsageEventMutations(
  db: SqliteDatabase,
  sourceKey: string,
  generation: number,
  mutations: IncrementalIndexMutations['usageEvents'],
): void {
  let nextIndex = numberValue(db.get<{ next_index: number }>(
    'SELECT COALESCE(MAX(event_index), -1) + 1 AS next_index FROM usage_events WHERE source_key = ?',
    [sourceKey],
  )?.next_index);
  for (const mutation of mutations) {
    const event = mutation.event;
    const existing = db.get<{ event_index: number }>(
      `SELECT event_index FROM usage_events
       WHERE source_key = ? AND generation = ? AND component_key = ?
         AND record_identity = ? AND event_ordinal = ?`,
      [sourceKey, generation, mutation.componentKey, mutation.recordIdentity, mutation.eventOrdinal],
    );
    const eventIndex = existing?.event_index ?? nextIndex++;
    db.run(
      `INSERT INTO usage_events (
        source_key, generation, component_key, record_identity, event_ordinal, event_index,
        timestamp, timestamp_ms, role, model, message_count, user_message_count,
        assistant_message_count, tool_call_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_output_tokens,
        cost_api, cost_conservative, cost_subscription
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key, event_index) DO UPDATE SET
        timestamp = excluded.timestamp, timestamp_ms = excluded.timestamp_ms,
        role = excluded.role, model = excluded.model,
        message_count = excluded.message_count, user_message_count = excluded.user_message_count,
        assistant_message_count = excluded.assistant_message_count, tool_call_count = excluded.tool_call_count,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        cost_api = excluded.cost_api, cost_conservative = excluded.cost_conservative,
        cost_subscription = excluded.cost_subscription`,
      [
        sourceKey, generation, mutation.componentKey, mutation.recordIdentity, mutation.eventOrdinal, eventIndex,
        event.timestamp, dateToMs(event.timestamp), event.role || null, event.model || 'unknown',
        event.messageCount, event.userMessageCount, event.assistantMessageCount, event.toolCallCount,
        event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens,
        event.reasoningOutputTokens || 0, event.estimatedCosts.api || 0,
        event.estimatedCosts.conservative || 0, event.estimatedCosts.subscription || 0,
      ],
    );
  }
}

function applyStableChangeEventMutations(
  db: SqliteDatabase,
  sourceKey: string,
  generation: number,
  mutations: IncrementalIndexMutations['changeEvents'],
): void {
  let nextIndex = numberValue(db.get<{ next_index: number }>(
    'SELECT COALESCE(MAX(event_index), -1) + 1 AS next_index FROM change_events WHERE source_key = ?',
    [sourceKey],
  )?.next_index);
  for (const mutation of mutations) {
    const event = mutation.event;
    const existing = db.get<{ event_index: number }>(
      `SELECT event_index FROM change_events
       WHERE source_key = ? AND generation = ? AND component_key = ?
         AND record_identity = ? AND event_ordinal = ?`,
      [sourceKey, generation, mutation.componentKey, mutation.recordIdentity, mutation.eventOrdinal],
    );
    const eventIndex = existing?.event_index ?? nextIndex++;
    db.run(
      `INSERT INTO change_events (
        source_key, generation, component_key, record_identity, event_ordinal, event_index,
        timestamp, timestamp_ms, added_lines, removed_lines, net_line_delta,
        changed_lines, file_count, edit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key, event_index) DO UPDATE SET
        timestamp = excluded.timestamp, timestamp_ms = excluded.timestamp_ms,
        added_lines = excluded.added_lines, removed_lines = excluded.removed_lines,
        net_line_delta = excluded.net_line_delta, changed_lines = excluded.changed_lines,
        file_count = excluded.file_count, edit_count = excluded.edit_count`,
      [
        sourceKey, generation, mutation.componentKey, mutation.recordIdentity, mutation.eventOrdinal, eventIndex,
        event.timestamp, dateToMs(event.timestamp), event.addedLines, event.removedLines,
        event.netLineDelta, event.changedLines, event.fileCount, event.editCount,
      ],
    );
  }
}

interface PublishedComponentCheckpoint {
  componentKey: string;
  filePath: string;
  size: number;
  mtimeMs: number;
  completeOffset: number;
  boundaryHash: string;
}

function publishCheckpointComponents(
  db: SqliteDatabase,
  sourceKey: string,
  checkpoint: SourceParseCheckpoint,
  targetRevision: string,
): void {
  let components: PublishedComponentCheckpoint[] = [];
  try {
    const parsed = JSON.parse(checkpoint.componentStateJson) as { version?: number; components?: PublishedComponentCheckpoint[] };
    if (parsed.version === 1 && Array.isArray(parsed.components)) components = parsed.components;
  } catch {
    return;
  }
  if (components.length === 0) return;
  const keys = new Set(components.map(component => component.componentKey));
  for (const component of components) {
    db.run(
      `INSERT INTO source_components (
        source_key, component_key, source_kind, file_path, observed_revision,
        observed_size, observed_mtime_ms, indexed_revision, indexed_size,
        indexed_mtime_ms, complete_offset, boundary_hash, continuation_json, missing
      ) VALUES (?, ?, 'jsonl', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 0)
      ON CONFLICT(source_key, component_key) DO UPDATE SET
        source_kind = excluded.source_kind, file_path = excluded.file_path,
        observed_revision = excluded.observed_revision, observed_size = excluded.observed_size,
        observed_mtime_ms = excluded.observed_mtime_ms, indexed_revision = excluded.indexed_revision,
        indexed_size = excluded.indexed_size, indexed_mtime_ms = excluded.indexed_mtime_ms,
        complete_offset = excluded.complete_offset, boundary_hash = excluded.boundary_hash,
        missing = 0`,
      [
        sourceKey, component.componentKey, component.filePath, targetRevision,
        component.size, component.mtimeMs, targetRevision, component.size,
        component.mtimeMs, component.completeOffset, component.boundaryHash,
      ],
    );
  }
  const stale = db.query<{ component_key: string }>(
    'SELECT component_key FROM source_components WHERE source_key = ?',
    [sourceKey],
  );
  for (const row of stale) {
    if (!keys.has(row.component_key)) {
      db.run('DELETE FROM source_components WHERE source_key = ? AND component_key = ?', [sourceKey, row.component_key]);
    }
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

function markImportedSummaryPublished(
  db: SqliteDatabase,
  summary: CachedSessionSummary,
  checkpoint: SourceParseCheckpoint | undefined,
  now: string,
): void {
  const sourceKey = summaryCacheKey(summary);
  const revision = legacySourceRevision(summary.sourceSignature.size, summary.sourceSignature.mtimeMs);
  db.run(
    `INSERT INTO source_generations (
      source_key, generation, target_revision, parser_version, mode, state,
      payload_json, created_at, published_at
    ) VALUES (?, 1, ?, ?, 'migration', 'published', ?, ?, ?)
    ON CONFLICT(source_key, generation) DO NOTHING`,
    [sourceKey, revision, summary.parserVersion, JSON.stringify(summary), now, now],
  );
  db.run(
    `UPDATE source_sessions SET
      route_id = ?, native_id = ?, native_project_id = ?, project_route_id = ?,
      project_name = ?, indexed_revision = ?, desired_revision = ?,
      job_state = 'clean', dirty = 0, published_generation = 1,
      next_generation = MAX(next_generation, 2), last_error = NULL,
      last_indexed_at = ?, updated_at = ?
     WHERE source_key = ?`,
    [
      summary.routeId,
      summary.nativeId,
      summary.nativeProjectId,
      summary.projectRouteId,
      summary.projectName,
      revision,
      revision,
      now,
      now,
      sourceKey,
    ],
  );
  db.run(
    `UPDATE source_components SET
      indexed_revision = ?, indexed_size = ?, indexed_mtime_ms = ?,
      complete_offset = ?, continuation_json = ?, missing = 0
     WHERE source_key = ? AND component_key = 'legacy-primary'`,
    [
      revision,
      summary.sourceSignature.size,
      summary.sourceSignature.mtimeMs,
      checkpoint?.lastCompleteOffset || 0,
      checkpoint?.componentStateJson || '{}',
      sourceKey,
    ],
  );
}

function markSummaryPublished(
  db: SqliteDatabase,
  summary: CachedSessionSummary,
  now: string,
  mode = 'full',
): void {
  const sourceKey = summaryCacheKey(summary);
  const revision = legacySourceRevision(summary.sourceSignature.size, summary.sourceSignature.mtimeMs);
  const row = db.get<{ next_generation: number }>(
    'SELECT next_generation FROM source_sessions WHERE source_key = ?',
    [sourceKey],
  );
  const generation = Math.max(1, numberValue(row?.next_generation));
  db.run(
    `INSERT INTO source_generations (
      source_key, generation, target_revision, parser_version, mode, state,
      payload_json, created_at, published_at
    ) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
    [sourceKey, generation, revision, summary.parserVersion, mode, JSON.stringify(summary), now, now],
  );
  db.run(
    `UPDATE source_sessions SET
      route_id = ?, native_id = ?, native_project_id = ?, project_route_id = ?,
      project_name = ?, indexed_revision = ?, desired_revision = ?,
      job_state = 'clean', dirty = 0, retry_count = 0, retry_after = NULL,
      last_error = NULL, published_generation = ?, next_generation = ?,
      last_indexed_at = ?, updated_at = ?
     WHERE source_key = ?`,
    [
      summary.routeId,
      summary.nativeId,
      summary.nativeProjectId,
      summary.projectRouteId,
      summary.projectName,
      revision,
      revision,
      generation,
      generation + 1,
      now,
      now,
      sourceKey,
    ],
  );
  db.run(
    `UPDATE source_components SET
      indexed_revision = ?, indexed_size = ?, indexed_mtime_ms = ?, missing = 0
     WHERE source_key = ? AND component_key = 'legacy-primary'`,
    [revision, summary.sourceSignature.size, summary.sourceSignature.mtimeMs, sourceKey],
  );
}

function importLegacyIndexIfEmpty(db: SqliteDatabase): void {
  const migration = db.get<{ migration_completed_at?: string }>(
    'SELECT migration_completed_at FROM index_status WHERE singleton = 1',
  );
  if (migration?.migration_completed_at) return;
  const existing = numberValue(db.get<CountRow>('SELECT COUNT(*) AS count FROM session_summaries')?.count);
  if (existing > 0) {
    throw new Error('Session index v2 contains rows without a completed migration marker.');
  }

  const legacyPath = getLegacySessionSummaryIndexPath();
  let summaries: CachedSessionSummary[] = [];
  let checkpoints = new Map<string, SourceParseCheckpoint>();
  let revision = 0;
  let generatedAt = '';
  let migrationSource = 'json';
  if (fs.existsSync(legacyPath)) {
    let legacy: SqliteDatabase | null = null;
    try {
      legacy = openDatabase(legacyPath);
      summaries = legacy.query<SummaryPayloadRow>(
        'SELECT payload_json FROM session_summaries ORDER BY provider, source_file_path',
      ).map(parseSummaryRow).filter((summary): summary is CachedSessionSummary => Boolean(summary));
      checkpoints = readCheckpoints(legacy);
      revision = numberValue(legacy.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', ['revision'])?.value);
      generatedAt = legacy.get<OptionalMetaRow>('SELECT value FROM cache_meta WHERE key = ?', ['generated_at'])?.value || '';
      migrationSource = 'v1-sqlite';
    } catch {
      summaries = [];
      checkpoints = new Map();
    } finally {
      legacy?.close();
    }
  }

  if (summaries.length === 0) {
    const jsonCache = readSessionSummaryCache();
    summaries = jsonCache.summaries;
    generatedAt = jsonCache.generatedAt;
    revision = summaries.length > 0 ? 1 : 0;
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const summary of summaries) {
      upsertSummary(db, summary, now);
      const checkpoint = checkpoints.get(summaryCacheKey(summary));
      if (checkpoint) upsertCheckpoint(db, checkpoint);
      markImportedSummaryPublished(db, summary, checkpoint, now);
    }
    setMeta(db, 'revision', String(revision));
    setMeta(db, 'generated_at', generatedAt || now);
    refreshIndexCounts(db);
    db.run(
      `UPDATE index_status SET
        committed_revision = ?, status_revision = status_revision + 1,
        state = ?, initial_build = ?, discovered_sources = ?, indexed_sources = ?,
        migration_source = ?, migration_completed_at = ?, last_committed_at = ?, updated_at = ?
       WHERE singleton = 1`,
      [
        revision,
        summaries.length > 0 ? 'ready' : 'building',
        summaries.length > 0 ? 0 : 1,
        summaries.length,
        summaries.length,
        migrationSource,
        now,
        generatedAt || (summaries.length > 0 ? now : null),
        now,
      ],
    );
  });
}

function readSqliteCache(providers?: AgentKind[]): SessionSummaryCacheFile {
  const db = openIndexDatabase(true);
  if (!db) return readSessionSummaryCache();
  try {
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      generatedAt: getMeta(db, 'generated_at'),
      summaries: readSummaries(db, providers),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export function querySessionSummaryIndex<T>(callback: (db: SqliteDatabase) => T): T | null {
  const db = openIndexDatabase(true);
  if (!db) return null;
  try {
    return callback(db);
  } finally {
    closeIndexDatabase(db);
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
      closeIndexDatabase(db);
    }
  } catch {
    // Metrics are diagnostic-only and should never affect index refreshes.
  }
}

export function readSessionSummaryIndexRefreshMetrics<T>(): T | undefined {
  if (!isSqliteIndexEnabled()) return undefined;
  try {
    const db = openIndexDatabase(true);
    if (!db) return undefined;
    try {
      const raw = getOptionalMeta(db, LAST_REFRESH_METRICS_META_KEY);
      return raw ? JSON.parse(raw) as T : undefined;
    } finally {
      closeIndexDatabase(db);
    }
  } catch {
    return undefined;
  }
}

export function readSourceParseCheckpoints(sources?: SessionSummarySource[]): Map<string, SourceParseCheckpoint> {
  if (!isSqliteIndexEnabled()) return new Map();
  try {
    const db = openIndexDatabase(true);
    if (!db) return new Map();
    try {
      return readCheckpoints(db, sources);
    } finally {
      closeIndexDatabase(db);
    }
  } catch {
    return new Map();
  }
}

function deleteMissingProviderSources(db: SqliteDatabase, provider: AgentKind, discoveredKeys: Set<string>): number {
  const rows = db.query<SourceKeyRow>('SELECT source_key FROM sources WHERE provider = ?', [provider]);
  let deleted = 0;
  for (const row of rows) {
    if (!discoveredKeys.has(row.source_key)) {
      db.run('DELETE FROM sources WHERE source_key = ?', [row.source_key]);
      db.run('DELETE FROM source_sessions WHERE source_key = ?', [row.source_key]);
      deleted += 1;
    }
  }
  return deleted;
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
      let visibleChanges = updatedSummaries.length;
      for (const source of discoveredSources) {
        upsertSource(db, source, now);
      }
      for (const provider of touchedProviders) {
        visibleChanges += deleteMissingProviderSources(db, provider, discoveredKeysByProvider.get(provider) || new Set<string>());
      }
      for (const summary of updatedSummaries) {
        upsertSummary(db, summary, now);
        markSummaryPublished(db, summary, now);
      }
      deleteCheckpoints(db, deletedCheckpointKeys);
      for (const checkpoint of updatedCheckpoints) {
        upsertCheckpoint(db, checkpoint);
      }
      if (visibleChanges > 0) {
        setMeta(db, 'generated_at', now);
        bumpRevision(db);
      }
      refreshIndexCounts(db);
    });
  } finally {
    closeIndexDatabase(db);
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
    let catalogRow: { job_state?: string | null; retry_after?: string | null; last_error?: string | null } | undefined;
    try {
      catalogRow = db.get<{ job_state?: string | null; retry_after?: string | null; last_error?: string | null }>(
        'SELECT job_state, retry_after, last_error FROM source_sessions WHERE source_key = ?',
        [sourceKey],
      );
    } catch {
      catalogRow = undefined;
    }
    return {
      summary: summaryRow ? parseSummaryRow(summaryRow) || undefined : undefined,
      checkpoint: checkpointRow ? checkpointFromRow(checkpointRow) : undefined,
      jobState: catalogRow?.job_state || undefined,
      retryAfter: catalogRow?.retry_after || undefined,
      lastError: catalogRow?.last_error || undefined,
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export function observeSessionSummaryIndexSource(source: SessionSummarySource): void {
  const db = openIndexDatabase(false);
  if (!db) return;
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      upsertSource(db, source, now);
      db.run(
        `UPDATE source_sessions SET
          job_state = CASE WHEN indexed_revision = desired_revision THEN 'clean' ELSE 'processing' END,
          dirty = CASE WHEN indexed_revision = desired_revision THEN 0 ELSE 1 END,
          updated_at = ?
         WHERE source_key = ?`,
        [now, sourceSummaryCacheKey(source)],
      );
    });
  } finally {
    closeIndexDatabase(db);
  }
}

export function recordSessionSummaryIndexSourceFailure(source: SessionSummarySource, error: string): void {
  const db = openIndexDatabase(false);
  if (!db) return;
  const now = new Date(Date.now());
  try {
    db.transaction(() => {
      upsertSource(db, source, now.toISOString());
      const row = db.get<{ retry_count: number }>(
        'SELECT retry_count FROM source_sessions WHERE source_key = ?',
        [sourceSummaryCacheKey(source)],
      );
      const retryCount = numberValue(row?.retry_count) + 1;
      const delayMs = Math.min(30_000 * (2 ** Math.max(0, retryCount - 1)), 30 * 60_000);
      db.run(
        `UPDATE source_sessions SET
          job_state = 'failed', dirty = 1, retry_count = ?, retry_after = ?,
          last_error = ?, updated_at = ?
         WHERE source_key = ?`,
        [retryCount, new Date(now.getTime() + delayMs).toISOString(), error, now.toISOString(), sourceSummaryCacheKey(source)],
      );
      db.run(
        `UPDATE index_status SET
          status_revision = status_revision + 1, failed_sources = failed_sources + 1,
          last_error = ?, updated_at = ? WHERE singleton = 1`,
        [error, now.toISOString()],
      );
    });
  } finally {
    closeIndexDatabase(db);
  }
}

export function deferSessionSummaryIndexSource(source: SessionSummarySource): void {
  const db = openIndexDatabase(false);
  if (!db) return;
  try {
    db.run(
      `UPDATE source_sessions SET
        job_state = 'pending', dirty = 1, retry_count = 0,
        retry_after = NULL, last_error = NULL, updated_at = ?
       WHERE source_key = ?`,
      [new Date().toISOString(), sourceSummaryCacheKey(source)],
    );
  } finally {
    closeIndexDatabase(db);
  }
}

export function beginSessionSummaryProviderReconciliations(providers: AgentKind[]): void {
  const db = openIndexDatabase(false);
  if (!db) return;
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      for (const provider of providers) {
        db.run(
          `INSERT INTO provider_reconciliations (
            provider, scan_generation, state, started_at, completed_at, last_error
          ) VALUES (?, 1, 'running', ?, NULL, NULL)
          ON CONFLICT(provider) DO UPDATE SET
            scan_generation = provider_reconciliations.scan_generation + 1,
            state = 'running', started_at = excluded.started_at,
            completed_at = NULL, last_error = NULL`,
          [provider, now],
        );
      }
      db.run(
        `UPDATE index_status SET status_revision = status_revision + 1,
          last_reconciled_at = ?, updated_at = ? WHERE singleton = 1`,
        [now, now],
      );
    });
  } finally {
    closeIndexDatabase(db);
  }
}

export function failSessionSummaryProviderReconciliation(provider: AgentKind, error: string): void {
  const db = openIndexDatabase(false);
  if (!db) return;
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.run(
        `UPDATE provider_reconciliations SET state = 'failed', completed_at = ?, last_error = ?
         WHERE provider = ?`,
        [now, error, provider],
      );
      db.run(
        `UPDATE index_status SET status_revision = status_revision + 1,
          state = 'degraded', last_error = ?, updated_at = ? WHERE singleton = 1`,
        [error, now],
      );
    });
  } finally {
    closeIndexDatabase(db);
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
      const sourceKey = sourceSummaryCacheKey(commit.source);
      const generationRow = db.get<{ next_generation: number }>(
        'SELECT next_generation FROM source_sessions WHERE source_key = ?',
        [sourceKey],
      );
      const generation = Math.max(1, numberValue(generationRow?.next_generation));
      const targetRevision = legacySourceRevision(
        commit.source.sourceSignature.size,
        commit.source.sourceSignature.mtimeMs,
      );
      if (commit.mutations && commit.checkpoint) {
        const summaryState = { ...commit.summary };
        delete summaryState.usageEvents;
        delete summaryState.changeEvents;
        const mutationDigest = createHash('sha256').update(JSON.stringify({
          summary: summaryState,
          checkpoint: commit.checkpoint,
          mutations: commit.mutations,
        })).digest('hex');
        const priorBatch = db.get<{ digest: string }>(
          'SELECT digest FROM source_mutation_batches WHERE source_key = ? AND target_revision = ?',
          [sourceKey, targetRevision],
        );
        if (priorBatch) {
          if (priorBatch.digest !== mutationDigest) {
            throw new Error(`Conflicting replay for ${sourceKey} at ${targetRevision}`);
          }
          return;
        }
        const publishedGeneration = Math.max(1, numberValue(db.get<{ published_generation: number }>(
          'SELECT published_generation FROM source_sessions WHERE source_key = ?',
          [sourceKey],
        )?.published_generation));
        upsertSummary(db, commit.summary, now, false);
        applyStableUsageEventMutations(db, sourceKey, publishedGeneration, commit.mutations.usageEvents);
        applyStableChangeEventMutations(db, sourceKey, publishedGeneration, commit.mutations.changeEvents);
        upsertCheckpoint(db, commit.checkpoint);
        publishCheckpointComponents(db, sourceKey, commit.checkpoint, targetRevision);
        db.run(
          'INSERT INTO source_mutation_batches (source_key, target_revision, digest, committed_at) VALUES (?, ?, ?, ?)',
          [sourceKey, targetRevision, mutationDigest, now],
        );
        db.run(
          `UPDATE source_sessions SET
            route_id = ?, native_id = ?, native_project_id = ?, project_route_id = ?,
            project_name = ?, indexed_revision = ?, job_state = 'clean', dirty = 0,
            retry_count = 0, retry_after = NULL, last_error = NULL,
            last_indexed_at = ?, updated_at = ?
           WHERE source_key = ?`,
          [
            commit.summary.routeId,
            commit.summary.nativeId,
            commit.summary.nativeProjectId,
            commit.summary.projectRouteId,
            commit.summary.projectName,
            targetRevision,
            now,
            now,
            sourceKey,
          ],
        );
        setMeta(db, 'generated_at', now);
        bumpRevision(db);
        refreshIndexCounts(db);
        return;
      }
      db.run(
        `INSERT INTO source_generations (
          source_key, generation, target_revision, parser_version, mode, state,
          payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'staging', ?, ?)`,
        [
          sourceKey,
          generation,
          targetRevision,
          commit.source.parserVersion,
          commit.checkpoint ? 'incremental' : 'full',
          JSON.stringify(commit.summary),
          now,
        ],
      );
      upsertSummary(db, commit.summary, now);
      if (commit.deleteCheckpoint) deleteCheckpoints(db, [sourceSummaryCacheKey(commit.source)]);
      if (commit.checkpoint) upsertCheckpoint(db, commit.checkpoint);
      if (commit.checkpoint) publishCheckpointComponents(db, sourceKey, commit.checkpoint, targetRevision);
      db.run(
        `UPDATE source_sessions SET
          route_id = ?, native_id = ?, native_project_id = ?, project_route_id = ?,
          project_name = ?, indexed_revision = ?, job_state = ?, dirty = ?,
          retry_count = 0, retry_after = NULL, last_error = NULL,
          published_generation = ?, next_generation = ?, last_indexed_at = ?, updated_at = ?
         WHERE source_key = ?`,
        [
          commit.summary.routeId,
          commit.summary.nativeId,
          commit.summary.nativeProjectId,
          commit.summary.projectRouteId,
          commit.summary.projectName,
          targetRevision,
          targetRevision === legacySourceRevision(commit.source.sourceSignature.size, commit.source.sourceSignature.mtimeMs) ? 'clean' : 'pending',
          0,
          generation,
          generation + 1,
          now,
          now,
          sourceKey,
        ],
      );
      db.run(
        `UPDATE source_components SET
          indexed_revision = ?, indexed_size = ?, indexed_mtime_ms = ?,
          complete_offset = ?, continuation_json = ?, missing = 0
         WHERE source_key = ? AND component_key = 'legacy-primary'`,
        [
          targetRevision,
          commit.source.sourceSignature.size,
          commit.source.sourceSignature.mtimeMs,
          commit.checkpoint?.lastCompleteOffset || 0,
          commit.checkpoint?.componentStateJson || '{}',
          sourceKey,
        ],
      );
      db.run(
        `UPDATE source_generations SET state = 'published', published_at = ?
         WHERE source_key = ? AND generation = ?`,
        [now, sourceKey, generation],
      );
      setMeta(db, 'generated_at', now);
      bumpRevision(db);
      refreshIndexCounts(db);
    });
  } finally {
    closeIndexDatabase(db);
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
  const db = openIndexDatabase(false);
  if (!db) return;
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      for (const provider of touchedProviders) {
        db.run(
          `UPDATE provider_reconciliations SET state = 'complete', completed_at = ?, last_error = NULL
           WHERE provider = ?`,
          [now, provider],
        );
      }
      db.run(
        `UPDATE index_status SET status_revision = status_revision + 1,
          last_reconciled_at = ?, updated_at = ? WHERE singleton = 1`,
        [now, now],
      );
    });
  } finally {
    closeIndexDatabase(db);
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
    closeIndexDatabase(db);
  }
}

export function getSessionSummaryIndexReadSignature(): string {
  if (!isSqliteIndexEnabled()) return `json:${getSessionSummaryCacheReadSignature()}`;
  const dbPath = getReadableSessionSummaryIndexPath();
  if (!dbPath || !fs.existsSync(dbPath)) return 'sqlite:missing';

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
    closeIndexDatabase(db);
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
        markSummaryPublished(database, summary, now, 'compatibility-import');
      }
      setMeta(database, 'generated_at', cache.generatedAt || now);
      bumpRevision(database);
      refreshIndexCounts(database);
    });
  } finally {
    closeIndexDatabase(database);
  }
}

export function emptySessionSummaryIndexCache(): SessionSummaryCacheFile {
  return emptyCacheFile();
}
