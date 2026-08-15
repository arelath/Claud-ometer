import { calculateCostAllModes, DEFAULT_COST_MODE } from '@/config/pricing';
import {
  bucketKeyFromLocalTimeParts,
  bucketKeyToDate,
  getLocalTimeParts,
  isDateInRange,
  isTimestampInLocalDateRange,
  listBucketKeys,
  normalizeBucketGranularity,
  normalizeTimeZone,
} from '@/lib/analytics-time';
import { addChangeTotals, zeroChangeTotals } from '@/lib/claude-data/change-utils';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import type {
  AnalyticsTimeBucket,
  BucketGranularity,
  ChangeTotals,
  CostEstimates,
  DashboardStats,
  DailyActivity,
  DailyChangeActivity,
  DailyModelTokens,
  ModelUsage,
  ProjectInfo,
  SessionInfo,
} from '@/lib/claude-data/types';
import type { SqliteDatabase } from '@/lib/sqlite';
import type { TimeRangeParams } from '@/lib/time-range';
import { querySessionSummaryIndex } from './session-summary-sqlite-store';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  summaryToSessionInfo,
  type CachedModelUsage,
  type CachedSessionSummary,
} from './session-summary';
import {
  getProjectRowPath,
  isSummaryInProjectPath,
  makeProjectPathRouteId,
} from './project-path';
import type { AgentDataProvider } from './provider';
import type { AgentKind } from './types';

interface AggregationContext {
  range: TimeRangeParams;
  timeZone: string;
  granularity: BucketGranularity;
}

interface MutableAnalyticsTimeBucket extends AnalyticsTimeBucket {
  activeSessionIds: Set<string>;
  sessionStartIds: Set<string>;
}

interface CountRow extends Record<string, unknown> {
  count: number;
}

interface SessionSummaryScalarRow extends Record<string, unknown> {
  source_key: string;
  route_id: string;
  native_id: string;
  provider: AgentKind;
  parser_version: string;
  native_project_id: string;
  project_route_id: string;
  project_name: string;
  source_file_path: string;
  source_size: number;
  source_mtime_ms: number;
  created_at: string;
  created_at_ms: number;
  updated_at: string;
  updated_at_ms: number;
  title?: string;
  cwd: string;
  git_branch: string;
  version: string;
  model: string;
  models_json?: string;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_output_tokens: number;
  added_lines: number;
  removed_lines: number;
  net_line_delta: number;
  changed_lines: number;
  changed_file_count: number;
  edit_count: number;
  compactions?: number;
  microcompactions?: number;
  compaction_tokens_saved?: number;
  compaction_timestamps_json?: string;
}

interface SessionModelUsageRow extends Record<string, unknown> {
  source_key: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_output_tokens: number;
  context_window?: number | null;
  max_output_tokens?: number | null;
  web_search_requests?: number;
}

interface SessionToolRow extends Record<string, unknown> {
  source_key: string;
  tool_name: string;
  tool_count: number;
}

interface UsageAggregateRow extends Record<string, unknown> {
  utc_hour_ms: number;
  model: string;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_output_tokens: number;
  cost_api: number;
  cost_conservative: number;
  cost_subscription: number;
  activity_count: number;
}

interface ChangeAggregateRow extends Record<string, unknown>, ChangeTotals {
  utc_hour_ms: number;
}

interface ActiveSessionRow extends Record<string, unknown> {
  source_key: string;
  project_route_id: string;
  project_name: string;
  cwd: string;
  utc_hour_ms: number;
  has_usage: number;
}

interface SessionStartRow extends Record<string, unknown> {
  source_key: string;
  created_at: string;
}

interface LongestSessionRow extends Record<string, unknown> {
  provider: AgentKind;
  route_id: string;
  native_id: string;
  created_at: string;
  created_at_ms: number;
  updated_at_ms: number;
  message_count: number;
}

interface ProjectUsageRow extends UsageAggregateRow {
  source_key: string;
  provider: AgentKind;
  native_project_id: string;
  project_route_id: string;
  project_name: string;
  cwd: string;
  last_timestamp_ms: number;
}

export interface SessionSqlPage {
  sessions: SessionInfo[];
  total: number;
  limit: number;
  offset: number;
}

export interface SessionSqlQuery {
  query?: string;
  projectId?: string;
  projectPath?: string;
  nativeProjectId?: string;
  projectAgentKind?: AgentKind;
  range?: TimeRangeParams;
  limit?: number;
  offset?: number;
}

export interface CostAnalyticsSqlPayload {
  stats: DashboardStats;
  projects: ProjectInfo[];
}

const VISIBLE_SUMMARY_SQL = `(
  s.message_count > 0
  OR s.tool_call_count > 0
  OR (s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens) > 0
)`;
const SESSION_SUMMARY_SCALAR_COLUMNS = `
  s.source_key,
  s.route_id,
  s.native_id,
  s.provider,
  s.parser_version,
  s.native_project_id,
  s.project_route_id,
  s.project_name,
  s.source_file_path,
  s.source_size,
  s.source_mtime_ms,
  s.created_at,
  s.created_at_ms,
  s.updated_at,
  s.updated_at_ms,
  s.title,
  s.cwd,
  s.git_branch,
  s.version,
  s.model,
  s.models_json,
  s.message_count,
  s.user_message_count,
  s.assistant_message_count,
  s.tool_call_count,
  s.input_tokens,
  s.output_tokens,
  s.cache_read_tokens,
  s.cache_write_tokens,
  s.reasoning_output_tokens,
  s.added_lines,
  s.removed_lines,
  s.net_line_delta,
  s.changed_lines,
  s.changed_file_count,
  s.edit_count,
  s.compactions,
  s.microcompactions,
  s.compaction_tokens_saved,
  s.compaction_timestamps_json
`;
const UTC_RANGE_PADDING_MS = 36 * 60 * 60 * 1000;

function providerKinds(providers: AgentDataProvider[]): AgentKind[] {
  return providers.map(provider => provider.kind);
}

function providerFilterSql(providers: AgentKind[], params: unknown[]): string {
  if (providers.length === 0) return '0 = 1';
  params.push(...providers);
  return `s.provider IN (${providers.map(() => '?').join(',')})`;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseStringArrayJson(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function loadSessionModelUsage(
  db: SqliteDatabase,
  sourceKeys: string[],
): Map<string, Record<string, CachedModelUsage>> {
  const usageBySource = new Map<string, Record<string, CachedModelUsage>>();
  for (const chunk of chunked(sourceKeys, 500)) {
    if (chunk.length === 0) continue;
    const rows = db.query<SessionModelUsageRow>(
      `SELECT
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
       FROM summary_model_usage
       WHERE source_key IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
    for (const row of rows) {
      const sourceUsage = usageBySource.get(row.source_key) || {};
      sourceUsage[row.model || 'unknown'] = {
        inputTokens: numberValue(row.input_tokens),
        outputTokens: numberValue(row.output_tokens),
        cacheReadInputTokens: numberValue(row.cache_read_tokens),
        cacheCreationInputTokens: numberValue(row.cache_write_tokens),
        reasoningOutputTokens: numberValue(row.reasoning_output_tokens),
        contextWindow: row.context_window == null ? undefined : numberValue(row.context_window),
        maxOutputTokens: row.max_output_tokens == null ? undefined : numberValue(row.max_output_tokens),
        webSearchRequests: numberValue(row.web_search_requests),
      };
      usageBySource.set(row.source_key, sourceUsage);
    }
  }
  return usageBySource;
}

function loadSessionTools(db: SqliteDatabase, sourceKeys: string[]): Map<string, Record<string, number>> {
  const toolsBySource = new Map<string, Record<string, number>>();
  for (const chunk of chunked(sourceKeys, 500)) {
    if (chunk.length === 0) continue;
    const rows = db.query<SessionToolRow>(
      `SELECT source_key, tool_name, tool_count
       FROM summary_tools
       WHERE source_key IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
    for (const row of rows) {
      const tools = toolsBySource.get(row.source_key) || {};
      tools[row.tool_name] = numberValue(row.tool_count);
      toolsBySource.set(row.source_key, tools);
    }
  }
  return toolsBySource;
}

function scalarRowToSummary(
  row: SessionSummaryScalarRow,
  modelUsage: Record<string, CachedModelUsage>,
  toolsUsed: Record<string, number>,
): CachedSessionSummary {
  const models = parseStringArrayJson(row.models_json);
  return {
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    parserVersion: row.parser_version,
    provider: row.provider,
    nativeId: row.native_id,
    routeId: row.route_id,
    nativeProjectId: row.native_project_id,
    projectRouteId: row.project_route_id,
    projectName: row.project_name,
    sourceFilePath: row.source_file_path,
    sourceSignature: {
      size: numberValue(row.source_size),
      mtimeMs: numberValue(row.source_mtime_ms),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title || undefined,
    cwd: row.cwd || '',
    gitBranch: row.git_branch || '',
    version: row.version || '',
    model: row.model || 'unknown',
    models: models.length > 0 ? models : Object.keys(modelUsage),
    messageCount: numberValue(row.message_count),
    userMessageCount: numberValue(row.user_message_count),
    assistantMessageCount: numberValue(row.assistant_message_count),
    toolCallCount: numberValue(row.tool_call_count),
    tokenTotals: {
      input: numberValue(row.input_tokens),
      output: numberValue(row.output_tokens),
      cacheRead: numberValue(row.cache_read_tokens),
      cacheWrite: numberValue(row.cache_write_tokens),
      reasoningOutput: numberValue(row.reasoning_output_tokens),
    },
    modelUsage,
    changeTotals: {
      addedLines: numberValue(row.added_lines),
      removedLines: numberValue(row.removed_lines),
      netLineDelta: numberValue(row.net_line_delta),
      changedLines: numberValue(row.changed_lines),
      fileCount: numberValue(row.changed_file_count),
      editCount: numberValue(row.edit_count),
    },
    toolsUsed,
    compaction: {
      compactions: numberValue(row.compactions),
      microcompactions: numberValue(row.microcompactions),
      totalTokensSaved: numberValue(row.compaction_tokens_saved),
      compactionTimestamps: parseStringArrayJson(row.compaction_timestamps_json),
    },
  };
}

function scalarRowsToSessions(db: SqliteDatabase, rows: SessionSummaryScalarRow[]): SessionInfo[] {
  const sourceKeys = rows.map(row => row.source_key);
  const usageBySource = loadSessionModelUsage(db, sourceKeys);
  const toolsBySource = loadSessionTools(db, sourceKeys);
  return rows.map(row => summaryToSessionInfo(scalarRowToSummary(
    row,
    usageBySource.get(row.source_key) || {},
    toolsBySource.get(row.source_key) || {},
  )));
}

function getAggregationContext(range: TimeRangeParams = {}): AggregationContext {
  return {
    range,
    timeZone: normalizeTimeZone(range.timeZone),
    granularity: normalizeBucketGranularity(range.granularity),
  };
}

function utcBoundsForLocalRange(range: TimeRangeParams): { startMs?: number; endMs?: number } {
  const startMs = range.start ? Date.parse(`${range.start}T00:00:00.000Z`) - UTC_RANGE_PADDING_MS : undefined;
  const endMs = range.end ? Date.parse(`${range.end}T23:59:59.999Z`) + UTC_RANGE_PADDING_MS : undefined;
  return {
    startMs: Number.isFinite(startMs) ? startMs : undefined,
    endMs: Number.isFinite(endMs) ? endMs : undefined,
  };
}

function appendTimestampBounds(where: string[], params: unknown[], column: string, range: TimeRangeParams): void {
  const bounds = utcBoundsForLocalRange(range);
  if (bounds.startMs !== undefined) {
    where.push(`${column} >= ?`);
    params.push(bounds.startMs);
  }
  if (bounds.endMs !== undefined) {
    where.push(`${column} <= ?`);
    params.push(bounds.endMs);
  }
}

function localBucketForUtcHour(
  utcHourMs: unknown,
  context: AggregationContext,
  cache: Map<number, { key: string; hour: number } | null>,
): { key: string; hour: number } | null {
  const ms = numberValue(utcHourMs);
  if (!ms) return null;
  if (cache.has(ms)) return cache.get(ms) || null;

  const parts = getLocalTimeParts(new Date(ms).toISOString(), context.timeZone);
  const bucket = parts && isDateInRange(parts.date, context.range)
    ? { key: bucketKeyFromLocalTimeParts(parts, context.granularity), hour: parts.hour }
    : null;
  cache.set(ms, bucket);
  return bucket;
}

function localBucketForTimestamp(timestamp: string, context: AggregationContext): string | null {
  const parts = getLocalTimeParts(timestamp, context.timeZone);
  if (!parts || !isDateInRange(parts.date, context.range)) return null;
  return bucketKeyFromLocalTimeParts(parts, context.granularity);
}

function usageTokenTotal(row: Pick<UsageAggregateRow, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>): number {
  return numberValue(row.input_tokens) + numberValue(row.output_tokens) + numberValue(row.cache_read_tokens) + numberValue(row.cache_write_tokens);
}

function rowCosts(row: UsageAggregateRow): CostEstimates {
  const stored = {
    api: numberValue(row.cost_api),
    conservative: numberValue(row.cost_conservative),
    subscription: numberValue(row.cost_subscription),
  };
  if (stored.api || stored.conservative || stored.subscription || usageTokenTotal(row) === 0) return stored;
  return calculateCostAllModes(
    row.model || 'unknown',
    numberValue(row.input_tokens),
    numberValue(row.output_tokens),
    numberValue(row.cache_write_tokens),
    numberValue(row.cache_read_tokens),
  );
}

function ensureBucket(
  buckets: Map<string, MutableAnalyticsTimeBucket>,
  key: string,
  granularity: BucketGranularity,
): MutableAnalyticsTimeBucket {
  const existing = buckets.get(key);
  if (existing) return existing;

  const bucket: MutableAnalyticsTimeBucket = {
    key,
    startLocal: key,
    granularity,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    sessionStartCount: 0,
    activeSessionCount: 0,
    tokensByModel: {},
    costsByModel: {},
    changeTotals: zeroChangeTotals(),
    activeSessionIds: new Set<string>(),
    sessionStartIds: new Set<string>(),
  };
  buckets.set(key, bucket);
  return bucket;
}

function finalizeBuckets(buckets: Map<string, MutableAnalyticsTimeBucket>): AnalyticsTimeBucket[] {
  return Array.from(buckets.values())
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(bucket => ({
      key: bucket.key,
      startLocal: bucket.startLocal,
      granularity: bucket.granularity,
      messageCount: bucket.messageCount,
      userMessageCount: bucket.userMessageCount,
      assistantMessageCount: bucket.assistantMessageCount,
      toolCallCount: bucket.toolCallCount,
      sessionStartCount: bucket.sessionStartIds.size,
      activeSessionCount: bucket.activeSessionIds.size,
      tokensByModel: bucket.tokensByModel,
      costsByModel: bucket.costsByModel,
      changeTotals: bucket.changeTotals,
    }));
}

function bucketsToDailyActivity(buckets: AnalyticsTimeBucket[]): DailyActivity[] {
  const days = new Map<string, DailyActivity>();
  for (const bucket of buckets) {
    const date = bucketKeyToDate(bucket.key);
    const day = days.get(date) || { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
    day.messageCount += bucket.messageCount;
    day.sessionCount += bucket.sessionStartCount;
    day.toolCallCount += bucket.toolCallCount;
    days.set(date, day);
  }
  return Array.from(days.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function bucketsToDailyModelTokens(buckets: AnalyticsTimeBucket[]): DailyModelTokens[] {
  const days = new Map<string, DailyModelTokens>();
  for (const bucket of buckets) {
    const date = bucketKeyToDate(bucket.key);
    const day = days.get(date) || { date, tokensByModel: {}, costsByModel: {} };
    for (const [model, tokens] of Object.entries(bucket.tokensByModel)) {
      day.tokensByModel[model] = (day.tokensByModel[model] || 0) + tokens;
    }
    for (const [model, costs] of Object.entries(bucket.costsByModel)) {
      day.costsByModel![model] = addCosts(day.costsByModel![model] || zeroCosts(), costs);
    }
    days.set(date, day);
  }
  return Array.from(days.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function bucketsToDailyChangeActivity(buckets: AnalyticsTimeBucket[]): DailyChangeActivity[] {
  const days = new Map<string, DailyChangeActivity>();
  for (const bucket of buckets) {
    const date = bucketKeyToDate(bucket.key);
    const day = days.get(date) || {
      date,
      ...zeroChangeTotals(),
      sessionCount: 0,
    };
    const totals = addChangeTotals(day, bucket.changeTotals);
    days.set(date, {
      date,
      ...totals,
      sessionCount: day.sessionCount + bucket.activeSessionCount,
    });
  }
  return Array.from(days.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function addModelUsage(
  modelUsage: DashboardStats['modelUsage'],
  model: string,
  row: UsageAggregateRow,
  costs: CostEstimates,
): void {
  const existing = modelUsage[model] || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    webSearchRequests: 0,
    estimatedCost: 0,
    estimatedCosts: zeroCosts(),
  } satisfies ModelUsage & { estimatedCost: number; estimatedCosts: CostEstimates };

  existing.inputTokens += numberValue(row.input_tokens);
  existing.outputTokens += numberValue(row.output_tokens);
  existing.cacheReadInputTokens += numberValue(row.cache_read_tokens);
  existing.cacheCreationInputTokens += numberValue(row.cache_write_tokens);
  existing.reasoningOutputTokens = (existing.reasoningOutputTokens || 0) + numberValue(row.reasoning_output_tokens);
  existing.estimatedCosts = addCosts(existing.estimatedCosts, costs);
  existing.estimatedCost = existing.estimatedCosts[DEFAULT_COST_MODE];
  modelUsage[model] = existing;
}

function emptyDashboardStats(range: TimeRangeParams = {}): DashboardStats {
  const context = getAggregationContext(range);
  const buckets = new Map<string, MutableAnalyticsTimeBucket>();
  for (const key of listBucketKeys(range, context.granularity)) {
    ensureBucket(buckets, key, context.granularity);
  }
  const usageBuckets = finalizeBuckets(buckets);
  const dailyActivity = bucketsToDailyActivity(usageBuckets);
  return {
    totalSessions: 0,
    totalMessages: 0,
    totalTokens: 0,
    estimatedCost: 0,
    estimatedCosts: zeroCosts(),
    dailyActivity,
    dailyModelTokens: bucketsToDailyModelTokens(usageBuckets),
    changeTotals: zeroChangeTotals(),
    dailyChangeActivity: bucketsToDailyChangeActivity(usageBuckets),
    timeZone: context.timeZone,
    bucketGranularity: context.granularity,
    usageBuckets,
    modelUsage: {},
    hourCounts: {},
    firstSessionDate: '',
    longestSession: { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    projectCount: 0,
    recentSessions: [],
  };
}

function loadRecentSessions(db: SqliteDatabase, sourceKeys: Set<string>): SessionInfo[] {
  const keys = Array.from(sourceKeys);
  if (keys.length === 0) return [];

  const rows: SessionSummaryScalarRow[] = [];
  for (let index = 0; index < keys.length; index += 500) {
    const chunk = keys.slice(index, index + 500);
    rows.push(...db.query<SessionSummaryScalarRow>(
      `SELECT ${SESSION_SUMMARY_SCALAR_COLUMNS}
       FROM session_summaries s
       WHERE source_key IN (${chunk.map(() => '?').join(',')})
       ORDER BY created_at_ms DESC`,
      chunk,
    ));
  }

  return scalarRowsToSessions(db, rows)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 10);
}

function longestSession(db: SqliteDatabase, providerList: AgentKind[]) {
  const params: unknown[] = [];
  const where = [providerFilterSql(providerList, params), VISIBLE_SUMMARY_SQL];
  const row = db.get<LongestSessionRow>(
    `SELECT
       provider,
       route_id,
       native_id,
       created_at,
       created_at_ms,
       updated_at_ms,
       message_count
     FROM session_summaries s
     WHERE ${where.join(' AND ')}
     ORDER BY (updated_at_ms - created_at_ms) DESC
     LIMIT 1`,
    params,
  );
  if (!row) return { sessionId: '', duration: 0, messageCount: 0, timestamp: '' };
  return {
    sessionId: row.provider === 'claude' ? row.native_id : row.route_id,
    duration: Math.max(0, numberValue(row.updated_at_ms) - numberValue(row.created_at_ms)),
    messageCount: numberValue(row.message_count),
    timestamp: row.created_at,
  };
}

export function getDashboardStatsSql(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): DashboardStats | null {
  const providerList = providerKinds(providers);
  if (providerList.length === 0) return emptyDashboardStats(range);

  return querySessionSummaryIndex((db) => {
    const context = getAggregationContext(range);
    const buckets = new Map<string, MutableAnalyticsTimeBucket>();
    const localHourCache = new Map<number, { key: string; hour: number } | null>();
    const modelUsage: DashboardStats['modelUsage'] = {};
    const hourCounts: Record<string, number> = {};
    const activeSessionIds = new Set<string>();
    const activeProjectIds = new Set<string>();
    const activeUsageSourceKeys = new Set<string>();
    let estimatedCosts = zeroCosts();
    let changeTotals = zeroChangeTotals();
    let totalMessages = 0;
    let totalTokens = 0;

    for (const key of listBucketKeys(range, context.granularity)) {
      ensureBucket(buckets, key, context.granularity);
    }

    const usageParams: unknown[] = [];
    const usageWhere = [providerFilterSql(providerList, usageParams), VISIBLE_SUMMARY_SQL, 'u.timestamp_ms > 0'];
    appendTimestampBounds(usageWhere, usageParams, 'u.timestamp_ms', range);
    const usageRows = db.query<UsageAggregateRow>(
      `SELECT
         CAST(u.timestamp_ms / 3600000 AS INTEGER) * 3600000 AS utc_hour_ms,
         u.model AS model,
         SUM(u.message_count) AS message_count,
         SUM(u.user_message_count) AS user_message_count,
         SUM(u.assistant_message_count) AS assistant_message_count,
         SUM(u.tool_call_count) AS tool_call_count,
         SUM(u.input_tokens) AS input_tokens,
         SUM(u.output_tokens) AS output_tokens,
         SUM(u.cache_read_tokens) AS cache_read_tokens,
         SUM(u.cache_write_tokens) AS cache_write_tokens,
         SUM(u.reasoning_output_tokens) AS reasoning_output_tokens,
         SUM(u.cost_api) AS cost_api,
         SUM(u.cost_conservative) AS cost_conservative,
         SUM(u.cost_subscription) AS cost_subscription,
         SUM(CASE
           WHEN u.assistant_message_count > 0
             OR (u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) > 0
           THEN 1 ELSE 0 END) AS activity_count
       FROM usage_events u
       JOIN session_summaries s ON s.source_key = u.source_key
       WHERE ${usageWhere.join(' AND ')}
       GROUP BY utc_hour_ms, u.model
       ORDER BY utc_hour_ms ASC`,
      usageParams,
    );

    for (const row of usageRows) {
      const localBucket = localBucketForUtcHour(row.utc_hour_ms, context, localHourCache);
      if (!localBucket) continue;

      const bucket = ensureBucket(buckets, localBucket.key, context.granularity);
      const costs = rowCosts(row);
      const tokens = usageTokenTotal(row);
      const model = row.model || 'unknown';

      bucket.messageCount += numberValue(row.message_count);
      bucket.userMessageCount += numberValue(row.user_message_count);
      bucket.assistantMessageCount += numberValue(row.assistant_message_count);
      bucket.toolCallCount += numberValue(row.tool_call_count);
      totalMessages += numberValue(row.message_count);
      hourCounts[String(localBucket.hour)] = (hourCounts[String(localBucket.hour)] || 0) + numberValue(row.activity_count);

      if (tokens > 0) {
        bucket.tokensByModel[model] = (bucket.tokensByModel[model] || 0) + tokens;
        bucket.costsByModel[model] = addCosts(bucket.costsByModel[model] || zeroCosts(), costs);
        estimatedCosts = addCosts(estimatedCosts, costs);
        totalTokens += tokens;
        addModelUsage(modelUsage, model, row, costs);
      }
    }

    const changeParams: unknown[] = [];
    const changeWhere = [providerFilterSql(providerList, changeParams), VISIBLE_SUMMARY_SQL, 'c.timestamp_ms > 0'];
    appendTimestampBounds(changeWhere, changeParams, 'c.timestamp_ms', range);
    const changeRows = db.query<ChangeAggregateRow>(
      `SELECT
         CAST(c.timestamp_ms / 3600000 AS INTEGER) * 3600000 AS utc_hour_ms,
         SUM(c.added_lines) AS addedLines,
         SUM(c.removed_lines) AS removedLines,
         SUM(c.net_line_delta) AS netLineDelta,
         SUM(c.changed_lines) AS changedLines,
         SUM(c.file_count) AS fileCount,
         SUM(c.edit_count) AS editCount
       FROM change_events c
       JOIN session_summaries s ON s.source_key = c.source_key
       WHERE ${changeWhere.join(' AND ')}
       GROUP BY utc_hour_ms
       ORDER BY utc_hour_ms ASC`,
      changeParams,
    );

    for (const row of changeRows) {
      const localBucket = localBucketForUtcHour(row.utc_hour_ms, context, localHourCache);
      if (!localBucket) continue;
      const eventTotals = {
        addedLines: numberValue(row.addedLines),
        removedLines: numberValue(row.removedLines),
        netLineDelta: numberValue(row.netLineDelta),
        changedLines: numberValue(row.changedLines),
        fileCount: numberValue(row.fileCount),
        editCount: numberValue(row.editCount),
      };
      const bucket = ensureBucket(buckets, localBucket.key, context.granularity);
      bucket.changeTotals = addChangeTotals(bucket.changeTotals, eventTotals);
      changeTotals = addChangeTotals(changeTotals, eventTotals);
    }

    const activeParams: unknown[] = [];
    const activeUsageWhere = [providerFilterSql(providerList, activeParams), VISIBLE_SUMMARY_SQL, 'u.timestamp_ms > 0'];
    appendTimestampBounds(activeUsageWhere, activeParams, 'u.timestamp_ms', range);
    const activeChangeParams: unknown[] = [];
    const activeChangeWhere = [providerFilterSql(providerList, activeChangeParams), VISIBLE_SUMMARY_SQL, 'c.timestamp_ms > 0'];
    appendTimestampBounds(activeChangeWhere, activeChangeParams, 'c.timestamp_ms', range);
    const activeRows = db.query<ActiveSessionRow>(
      `SELECT
         u.source_key AS source_key,
         s.project_route_id AS project_route_id,
         s.project_name AS project_name,
         s.cwd AS cwd,
         CAST(u.timestamp_ms / 3600000 AS INTEGER) * 3600000 AS utc_hour_ms,
         1 AS has_usage
       FROM usage_events u
       JOIN session_summaries s ON s.source_key = u.source_key
       WHERE ${activeUsageWhere.join(' AND ')}
       GROUP BY u.source_key, utc_hour_ms
       UNION ALL
       SELECT
         c.source_key AS source_key,
         s.project_route_id AS project_route_id,
         s.project_name AS project_name,
         s.cwd AS cwd,
         CAST(c.timestamp_ms / 3600000 AS INTEGER) * 3600000 AS utc_hour_ms,
         0 AS has_usage
       FROM change_events c
       JOIN session_summaries s ON s.source_key = c.source_key
       WHERE ${activeChangeWhere.join(' AND ')}
       GROUP BY c.source_key, utc_hour_ms`,
      [...activeParams, ...activeChangeParams],
    );

    for (const row of activeRows) {
      const localBucket = localBucketForUtcHour(row.utc_hour_ms, context, localHourCache);
      if (!localBucket) continue;
      const bucket = ensureBucket(buckets, localBucket.key, context.granularity);
      bucket.activeSessionIds.add(row.source_key);
      activeSessionIds.add(row.source_key);
      activeProjectIds.add(getProjectRowPath(row) || row.project_route_id);
      if (numberValue(row.has_usage) > 0) activeUsageSourceKeys.add(row.source_key);
    }

    const startParams: unknown[] = [];
    const startWhere = [providerFilterSql(providerList, startParams), VISIBLE_SUMMARY_SQL];
    appendTimestampBounds(startWhere, startParams, 's.created_at_ms', range);
    const startRows = db.query<SessionStartRow>(
      `SELECT source_key, created_at
       FROM session_summaries s
       WHERE ${startWhere.join(' AND ')}`,
      startParams,
    );
    for (const row of startRows) {
      const key = localBucketForTimestamp(row.created_at, context);
      if (!key) continue;
      ensureBucket(buckets, key, context.granularity).sessionStartIds.add(row.source_key);
    }

    const usageBuckets = finalizeBuckets(buckets);
    const dailyActivity = bucketsToDailyActivity(usageBuckets);
    const dailyModelTokens = bucketsToDailyModelTokens(usageBuckets);
    const dailyChangeActivity = bucketsToDailyChangeActivity(usageBuckets);

    return {
      totalSessions: activeSessionIds.size,
      totalMessages,
      totalTokens,
      estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
      estimatedCosts,
      dailyActivity,
      dailyModelTokens,
      changeTotals,
      dailyChangeActivity,
      timeZone: context.timeZone,
      bucketGranularity: context.granularity,
      usageBuckets,
      modelUsage,
      hourCounts,
      firstSessionDate: dailyActivity.find(day => day.messageCount > 0 || day.sessionCount > 0)?.date || '',
      longestSession: longestSession(db, providerList),
      projectCount: activeProjectIds.size,
      recentSessions: loadRecentSessions(db, activeUsageSourceKeys),
    };
  });
}

function addProjectAgentKind(project: ProjectInfo, agentKind: AgentKind): void {
  if (!project.agentKinds?.includes(agentKind)) {
    project.agentKinds = [...(project.agentKinds || []), agentKind].sort();
  }
  project.agentKind = project.agentKinds.length === 1 ? project.agentKinds[0] : undefined;
}

function ensureProject(projects: Map<string, ProjectInfo>, row: ProjectUsageRow): ProjectInfo {
  const projectPath = getProjectRowPath(row);
  const projectKey = projectPath || row.project_route_id;
  const existing = projects.get(projectKey);
  if (existing) {
    addProjectAgentKind(existing, row.provider);
    return existing;
  }

  const project: ProjectInfo = {
    id: projectPath ? makeProjectPathRouteId(projectPath) : row.project_route_id,
    agentKind: row.provider,
    agentKinds: [row.provider],
    nativeId: row.native_project_id,
    routeId: row.project_route_id,
    name: row.project_name,
    path: row.cwd || row.project_name,
    sessionCount: 0,
    totalMessages: 0,
    totalTokens: 0,
    estimatedCost: 0,
    estimatedCosts: zeroCosts(),
    lastActive: '',
    models: [],
  };
  projects.set(projectKey, project);
  return project;
}

export function getProjectsSql(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): ProjectInfo[] | null {
  const providerList = providerKinds(providers);
  if (providerList.length === 0) return [];

  return querySessionSummaryIndex((db) => {
    const context = getAggregationContext(range);
    const localHourCache = new Map<number, { key: string; hour: number } | null>();
    const params: unknown[] = [];
    const where = [providerFilterSql(providerList, params), VISIBLE_SUMMARY_SQL, 'u.timestamp_ms > 0'];
    appendTimestampBounds(where, params, 'u.timestamp_ms', range);
    const rows = db.query<ProjectUsageRow>(
      `SELECT
         u.source_key AS source_key,
         s.provider AS provider,
         s.native_project_id AS native_project_id,
         s.project_route_id AS project_route_id,
         s.project_name AS project_name,
         s.cwd AS cwd,
         CAST(u.timestamp_ms / 3600000 AS INTEGER) * 3600000 AS utc_hour_ms,
         u.model AS model,
         SUM(u.message_count) AS message_count,
         SUM(u.user_message_count) AS user_message_count,
         SUM(u.assistant_message_count) AS assistant_message_count,
         SUM(u.tool_call_count) AS tool_call_count,
         SUM(u.input_tokens) AS input_tokens,
         SUM(u.output_tokens) AS output_tokens,
         SUM(u.cache_read_tokens) AS cache_read_tokens,
         SUM(u.cache_write_tokens) AS cache_write_tokens,
         SUM(u.reasoning_output_tokens) AS reasoning_output_tokens,
         SUM(u.cost_api) AS cost_api,
         SUM(u.cost_conservative) AS cost_conservative,
         SUM(u.cost_subscription) AS cost_subscription,
         SUM(CASE
           WHEN u.assistant_message_count > 0
             OR (u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) > 0
           THEN 1 ELSE 0 END) AS activity_count,
         MAX(u.timestamp_ms) AS last_timestamp_ms
       FROM usage_events u
       JOIN session_summaries s ON s.source_key = u.source_key
       WHERE ${where.join(' AND ')}
       GROUP BY u.source_key, utc_hour_ms, u.model
       ORDER BY last_timestamp_ms DESC`,
      params,
    );

    const projects = new Map<string, ProjectInfo>();
    const sessionsByProject = new Map<string, Set<string>>();
    const modelsByProject = new Map<string, Set<string>>();

    for (const row of rows) {
      if (!localBucketForUtcHour(row.utc_hour_ms, context, localHourCache)) continue;

      const projectKey = getProjectRowPath(row) || row.project_route_id;
      const project = ensureProject(projects, row);
      const sessions = sessionsByProject.get(projectKey) || new Set<string>();
      sessions.add(row.source_key);
      sessionsByProject.set(projectKey, sessions);

      const models = modelsByProject.get(projectKey) || new Set<string>();
      if (row.model) models.add(row.model);
      modelsByProject.set(projectKey, models);

      const tokens = usageTokenTotal(row);
      project.totalMessages += numberValue(row.message_count);
      project.totalTokens += tokens;
      project.estimatedCosts = addCosts(project.estimatedCosts, rowCosts(row));
      project.estimatedCost = project.estimatedCosts[DEFAULT_COST_MODE];

      const lastActive = new Date(numberValue(row.last_timestamp_ms)).toISOString();
      if (!project.lastActive || lastActive > project.lastActive) project.lastActive = lastActive;
    }

    for (const [projectId, project] of projects) {
      project.sessionCount = sessionsByProject.get(projectId)?.size || 0;
      project.models = Array.from(modelsByProject.get(projectId) || []).sort();
    }

    return Array.from(projects.values()).sort((left, right) => right.lastActive.localeCompare(left.lastActive));
  });
}

export function getCostAnalyticsSql(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): CostAnalyticsSqlPayload | null {
  const stats = getDashboardStatsSql(providers, range);
  if (!stats) return null;
  const projects = getProjectsSql(providers, range);
  if (!projects) return null;
  return {
    stats: {
      ...stats,
      hourCounts: {},
      longestSession: { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
      recentSessions: [],
    },
    projects,
  };
}

function appendCreatedDateRange(where: string[], params: unknown[], range: TimeRangeParams): void {
  if (range.timeZone) {
    appendTimestampBounds(where, params, 's.created_at_ms', range);
    return;
  }

  if (range.start) {
    where.push('substr(s.created_at, 1, 10) >= ?');
    params.push(range.start);
  }
  if (range.end) {
    where.push('substr(s.created_at, 1, 10) <= ?');
    params.push(range.end);
  }
}

function sessionWhereSql(providers: AgentKind[], options: SessionSqlQuery, params: unknown[]): string {
  const where = [providerFilterSql(providers, params), VISIBLE_SUMMARY_SQL];
  appendCreatedDateRange(where, params, options.range || {});

  if (options.query?.trim()) {
    where.push('instr(s.search_text, ?) > 0');
    params.push(options.query.trim().toLowerCase());
  }

  if (options.projectPath) {
    return where.join(' AND ');
  }

  if (options.projectId) {
    if (options.projectAgentKind) {
      where.push('s.provider = ?');
      params.push(options.projectAgentKind);
    }
    where.push('(s.native_project_id = ? OR s.project_route_id = ?)');
    params.push(options.nativeProjectId || options.projectId, options.projectId);
  }

  return where.join(' AND ');
}

function needsLocalCreatedAtFilter(range: TimeRangeParams = {}): boolean {
  return Boolean(range.timeZone && (range.start || range.end));
}

function isScalarRowInCreatedAtRange(row: SessionSummaryScalarRow, range: TimeRangeParams = {}): boolean {
  if (!range.start && !range.end) return true;
  if (range.timeZone) {
    return isTimestampInLocalDateRange(row.created_at, normalizeTimeZone(range.timeZone), range);
  }

  const date = row.created_at.slice(0, 10);
  if (range.start && date < range.start) return false;
  if (range.end && date > range.end) return false;
  return true;
}

export function getSessionsSql(
  providers: AgentDataProvider[],
  options: SessionSqlQuery = {},
): SessionSqlPage | null {
  const providerList = providerKinds(providers);
  const limit = options.limit && options.limit > 0 ? options.limit : 50;
  const offset = options.offset && options.offset > 0 ? options.offset : 0;
  if (providerList.length === 0) return { sessions: [], total: 0, limit, offset };

  return querySessionSummaryIndex((db) => {
    if (needsLocalCreatedAtFilter(options.range)) {
      const params: unknown[] = [];
      const where = sessionWhereSql(providerList, options, params);
      const rows = db.query<SessionSummaryScalarRow>(
        `SELECT ${SESSION_SUMMARY_SCALAR_COLUMNS}
         FROM session_summaries s
         WHERE ${where}
         ORDER BY s.created_at_ms DESC`,
        params,
      );
      const filteredRows = rows.filter(row => isScalarRowInCreatedAtRange(row, options.range));

      return {
        sessions: scalarRowsToSessions(db, filteredRows).slice(offset, offset + limit),
        total: filteredRows.length,
        limit,
        offset,
      };
    }

    const countParams: unknown[] = [];
    const countWhere = sessionWhereSql(providerList, options, countParams);
    const total = numberValue(db.get<CountRow>(
      `SELECT COUNT(*) AS count FROM session_summaries s WHERE ${countWhere}`,
      countParams,
    )?.count);

    const pageParams: unknown[] = [];
    const pageWhere = sessionWhereSql(providerList, options, pageParams);
    const rows = db.query<SessionSummaryScalarRow>(
      `SELECT ${SESSION_SUMMARY_SCALAR_COLUMNS}
       FROM session_summaries s
       WHERE ${pageWhere}
       ORDER BY s.created_at_ms DESC
       LIMIT ? OFFSET ?`,
      [...pageParams, limit, offset],
    );

    return {
      sessions: scalarRowsToSessions(db, rows),
      total,
      limit,
      offset,
    };
  });
}

export function getProjectSessionsSql(
  providers: AgentDataProvider[],
  options: Omit<SessionSqlQuery, 'limit' | 'offset' | 'query'>,
): SessionInfo[] | null {
  const providerList = providerKinds(providers);
  if (providerList.length === 0) return [];

  return querySessionSummaryIndex((db) => {
    const params: unknown[] = [];
    const where = sessionWhereSql(providerList, options, params);
    const rows = db.query<SessionSummaryScalarRow>(
      `SELECT ${SESSION_SUMMARY_SCALAR_COLUMNS}
       FROM session_summaries s
       WHERE ${where}
       ORDER BY s.created_at_ms DESC`,
      params,
    );
    const rangeFilteredRows = needsLocalCreatedAtFilter(options.range)
      ? rows.filter(row => isScalarRowInCreatedAtRange(row, options.range))
      : rows;
    const filteredRows = options.projectPath
      ? rangeFilteredRows.filter(row => isSummaryInProjectPath({ cwd: row.cwd, projectName: row.project_name }, options.projectPath || ''))
      : rangeFilteredRows;
    return scalarRowsToSessions(db, filteredRows);
  });
}

export function getSessionSummarySql(
  providers: AgentDataProvider[],
  routeId: string,
): SessionInfo | null | undefined {
  const providerList = providerKinds(providers);
  if (providerList.length === 0) return null;

  return querySessionSummaryIndex((db) => {
    const params: unknown[] = [];
    const where = [providerFilterSql(providerList, params), VISIBLE_SUMMARY_SQL, '(s.route_id = ? OR s.native_id = ?)'];
    params.push(routeId, routeId);
    const row = db.get<SessionSummaryScalarRow>(
      `SELECT ${SESSION_SUMMARY_SCALAR_COLUMNS} FROM session_summaries s WHERE ${where.join(' AND ')} LIMIT 1`,
      params,
    );
    return row ? scalarRowsToSessions(db, [row])[0] : null;
  });
}
