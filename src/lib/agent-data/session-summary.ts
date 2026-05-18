import { calculateCostAllModes, DEFAULT_COST_MODE } from '@/config/pricing';
import {
  bucketKeyToDate,
  getBucketKey,
  getEventLocalDate,
  getLocalTimeParts,
  isDateInRange,
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
  CompactionInfo,
  CostEstimates,
  DashboardStats,
  DailyActivity,
  DailyChangeActivity,
  DailyModelTokens,
  ModelUsage,
  ProjectInfo,
  SessionInfo,
} from '@/lib/claude-data/types';
import type { TimeRangeParams } from '@/lib/time-range';
import {
  buildLegacyChangeEvents,
  buildLegacyUsageEvents,
  type CachedChangeEvent,
  type CachedUsageEvent,
} from './event-metrics';
import type { AgentKind } from './types';

export const SESSION_SUMMARY_CACHE_VERSION = 4;

export interface SessionSourceSignature {
  size: number;
  mtimeMs: number;
}

export interface SessionSummarySource {
  provider: AgentKind;
  parserVersion: string;
  sourceFilePath: string;
  sourceSignature: SessionSourceSignature;
  nativeProjectId?: string;
  projectName?: string;
  metadata?: unknown;
}

export interface CachedModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  webSearchRequests?: number;
}

export interface CachedSessionSummary {
  cacheVersion: number;
  parserVersion: string;
  provider: AgentKind;
  nativeId: string;
  routeId: string;
  nativeProjectId: string;
  projectRouteId: string;
  projectName: string;
  sourceFilePath: string;
  sourceSignature: SessionSourceSignature;
  createdAt: string;
  updatedAt: string;
  title?: string;
  cwd: string;
  gitBranch: string;
  version: string;
  model: string;
  models: string[];
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  tokenTotals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoningOutput?: number;
  };
  modelUsage: Record<string, CachedModelUsage>;
  changeTotals?: ChangeTotals;
  usageEvents?: CachedUsageEvent[];
  changeEvents?: CachedChangeEvent[];
  toolsUsed: Record<string, number>;
  compaction: CompactionInfo;
  searchTextPreview?: string;
}

function summaryTokenTotal(summary: CachedSessionSummary): number {
  return summary.tokenTotals.input + summary.tokenTotals.output + summary.tokenTotals.cacheRead + summary.tokenTotals.cacheWrite;
}

function sessionInfoTokenTotal(session: SessionInfo): number {
  return session.totalInputTokens + session.totalOutputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens;
}

export function isVisibleSessionSummary(summary: CachedSessionSummary): boolean {
  return !(summary.messageCount <= 0 && summary.toolCallCount <= 0 && summaryTokenTotal(summary) <= 0);
}

export function isVisibleSessionInfo(session: SessionInfo): boolean {
  return !(session.messageCount <= 0 && session.toolCallCount <= 0 && sessionInfoTokenTotal(session) <= 0);
}

export function filterVisibleSessionSummaries(summaries: CachedSessionSummary[]): CachedSessionSummary[] {
  return summaries.filter(isVisibleSessionSummary);
}

export function getSummaryModelUsage(summary: CachedSessionSummary): Record<string, CachedModelUsage> {
  if (Object.keys(summary.modelUsage || {}).length > 0) return summary.modelUsage;
  return {
    [summary.model || 'unknown']: {
      inputTokens: summary.tokenTotals.input,
      outputTokens: summary.tokenTotals.output,
      cacheReadInputTokens: summary.tokenTotals.cacheRead,
      cacheCreationInputTokens: summary.tokenTotals.cacheWrite,
      reasoningOutputTokens: summary.tokenTotals.reasoningOutput || 0,
    },
  };
}

export function calculateSummaryCosts(summary: CachedSessionSummary): CostEstimates {
  let costs = zeroCosts();
  for (const [model, usage] of Object.entries(getSummaryModelUsage(summary))) {
    costs = addCosts(
      costs,
      calculateCostAllModes(
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheReadInputTokens,
      ),
    );
  }
  return costs;
}

export function summaryToSessionInfo(summary: CachedSessionSummary): SessionInfo {
  const estimatedCosts = calculateSummaryCosts(summary);
  const publicSessionId = summary.provider === 'claude' ? summary.nativeId : summary.routeId;
  const publicProjectId = summary.provider === 'claude' ? summary.nativeProjectId : summary.projectRouteId;
  return {
    id: publicSessionId,
    agentKind: summary.provider,
    nativeId: summary.nativeId,
    routeId: summary.routeId,
    projectId: publicProjectId,
    nativeProjectId: summary.nativeProjectId,
    projectRouteId: summary.projectRouteId,
    projectName: summary.projectName,
    title: summary.title,
    sourceFilePath: summary.sourceFilePath,
    sourceFilePaths: [summary.sourceFilePath],
    timestamp: summary.createdAt,
    duration: Math.max(0, new Date(summary.updatedAt).getTime() - new Date(summary.createdAt).getTime()),
    messageCount: summary.messageCount,
    userMessageCount: summary.userMessageCount,
    assistantMessageCount: summary.assistantMessageCount,
    toolCallCount: summary.toolCallCount,
    totalInputTokens: summary.tokenTotals.input,
    totalOutputTokens: summary.tokenTotals.output,
    totalCacheReadTokens: summary.tokenTotals.cacheRead,
    totalCacheWriteTokens: summary.tokenTotals.cacheWrite,
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
    estimatedCosts,
    model: summary.model,
    models: summary.models,
    gitBranch: summary.gitBranch,
    cwd: summary.cwd,
    version: summary.version,
    toolsUsed: summary.toolsUsed,
    compaction: summary.compaction,
  };
}

export function sortSummariesByTimestamp(summaries: CachedSessionSummary[]): CachedSessionSummary[] {
  return [...summaries].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function summariesToSessions(summaries: CachedSessionSummary[]): SessionInfo[] {
  return sortSummariesByTimestamp(filterVisibleSessionSummaries(summaries)).map(summaryToSessionInfo);
}

export function summariesToProjects(summaries: CachedSessionSummary[], range: TimeRangeParams = {}): ProjectInfo[] {
  const visibleSummaries = filterVisibleSessionSummaries(summaries);
  const projects = new Map<string, ProjectInfo>();
  const context = getAggregationContext(range);

  for (const summary of visibleSummaries) {
    const usageEvents = getSummaryUsageEvents(summary).filter(event => isEventInRange(event.timestamp, context));
    if (usageEvents.length === 0) continue;

    const publicProjectId = summary.provider === 'claude' ? summary.nativeProjectId : summary.projectRouteId;
    const project = projects.get(summary.projectRouteId) || {
      id: publicProjectId,
      agentKind: summary.provider,
      nativeId: summary.nativeProjectId,
      routeId: summary.projectRouteId,
      name: summary.projectName,
      path: summary.cwd || summary.projectName,
      sessionCount: 0,
      totalMessages: 0,
      totalTokens: 0,
      estimatedCost: 0,
      estimatedCosts: zeroCosts(),
      lastActive: '',
      models: [],
    };

    project.sessionCount += 1;
    for (const event of usageEvents) {
      const tokens = usageEventTokenTotal(event);
      project.totalMessages += event.messageCount;
      project.totalTokens += tokens;
      project.estimatedCosts = addCosts(project.estimatedCosts, event.estimatedCosts);
      if (!project.lastActive || event.timestamp > project.lastActive) project.lastActive = event.timestamp;
    }
    project.estimatedCost = project.estimatedCosts[DEFAULT_COST_MODE];
    project.models = Array.from(new Set([...project.models, ...summary.models]));
    projects.set(summary.projectRouteId, project);
  }

  return Array.from(projects.values()).sort((left, right) => right.lastActive.localeCompare(left.lastActive));
}

export function summariesToDashboardStats(summaries: CachedSessionSummary[], range: TimeRangeParams = {}): DashboardStats {
  const visibleSummaries = filterVisibleSessionSummaries(summaries);
  const sortedSummaries = sortSummariesByTimestamp(visibleSummaries);
  const sessions = sortedSummaries.map(summaryToSessionInfo);
  const context = getAggregationContext(range);
  const buckets = new Map<string, MutableAnalyticsTimeBucket>();
  const modelUsage: DashboardStats['modelUsage'] = {};
  const hourCounts: Record<string, number> = {};
  let estimatedCosts = zeroCosts();
  let changeTotals = zeroChangeTotals();
  let totalMessages = 0;
  let totalTokens = 0;
  const activeSessionIds = new Set<string>();
  const activeProjectIds = new Set<string>();
  const activeSummaryKeys = new Set<string>();

  for (const key of listBucketKeys(range, context.granularity)) {
    ensureBucket(buckets, key, context.granularity);
  }

  for (const summary of sortedSummaries) {
    const summaryKey = summary.routeId || summary.nativeId;
    const sessionId = summaryKey;
    const projectId = summary.projectRouteId;
    recordSessionStart(summary, context, buckets, sessionId);

    for (const event of getSummaryUsageEvents(summary)) {
      if (!isEventInRange(event.timestamp, context)) continue;
      const bucketKey = getBucketKey(event.timestamp, context.timeZone, context.granularity);
      const localParts = getLocalTimeParts(event.timestamp, context.timeZone);
      if (!bucketKey || !localParts) continue;

      const bucket = ensureBucket(buckets, bucketKey, context.granularity);
      bucket.messageCount += event.messageCount;
      bucket.userMessageCount += event.userMessageCount;
      bucket.assistantMessageCount += event.assistantMessageCount;
      bucket.toolCallCount += event.toolCallCount;
      bucket.activeSessionIds.add(sessionId);

      activeSessionIds.add(sessionId);
      activeProjectIds.add(projectId);
      activeSummaryKeys.add(summaryKey);
      totalMessages += event.messageCount;

      const tokens = usageEventTokenTotal(event);
      if (tokens > 0) {
        const model = event.model || 'unknown';
        bucket.tokensByModel[model] = (bucket.tokensByModel[model] || 0) + tokens;
        bucket.costsByModel[model] = addCosts(bucket.costsByModel[model] || zeroCosts(), event.estimatedCosts);
        estimatedCosts = addCosts(estimatedCosts, event.estimatedCosts);
        totalTokens += tokens;
        addEventModelUsage(modelUsage, model, event);
      }

      if (event.assistantMessageCount > 0 || tokens > 0) {
        hourCounts[String(localParts.hour)] = (hourCounts[String(localParts.hour)] || 0) + 1;
      }
    }

    for (const event of getSummaryChangeEvents(summary)) {
      if (!isEventInRange(event.timestamp, context)) continue;
      const bucketKey = getBucketKey(event.timestamp, context.timeZone, context.granularity);
      if (!bucketKey) continue;
      const bucket = ensureBucket(buckets, bucketKey, context.granularity);
      bucket.changeTotals = addChangeTotals(bucket.changeTotals, event);
      bucket.activeSessionIds.add(sessionId);
      activeSessionIds.add(sessionId);
      activeProjectIds.add(projectId);
      activeSummaryKeys.add(summaryKey);
      changeTotals = addChangeTotals(changeTotals, event);
    }
  }

  const usageBuckets = finalizeBuckets(buckets);
  const dailyActivity = bucketsToDailyActivity(usageBuckets);
  const dailyModelTokens = bucketsToDailyModelTokens(usageBuckets);
  const dailyChangeActivity = bucketsToDailyChangeActivity(usageBuckets);
  const recentSessions = sessions
    .filter(session => activeSummaryKeys.has(session.routeId || session.id))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 10);

  const longestSession = sessions.reduce<SessionInfo | null>((longest, session) => {
    if (!longest || session.duration > longest.duration) return session;
    return longest;
  }, null);

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
    longestSession: longestSession
      ? {
          sessionId: longestSession.id,
          duration: longestSession.duration,
          messageCount: longestSession.messageCount,
          timestamp: longestSession.timestamp,
        }
      : { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    projectCount: activeProjectIds.size,
    recentSessions,
  };
}

interface AggregationContext {
  range: TimeRangeParams;
  timeZone: string;
  granularity: BucketGranularity;
}

interface MutableAnalyticsTimeBucket extends AnalyticsTimeBucket {
  activeSessionIds: Set<string>;
  sessionStartIds: Set<string>;
}

function getAggregationContext(range: TimeRangeParams): AggregationContext {
  return {
    range,
    timeZone: normalizeTimeZone(range.timeZone),
    granularity: normalizeBucketGranularity(range.granularity),
  };
}

function getSummaryUsageEvents(summary: CachedSessionSummary): CachedUsageEvent[] {
  return summary.usageEvents?.length ? summary.usageEvents : buildLegacyUsageEvents(summary);
}

function getSummaryChangeEvents(summary: CachedSessionSummary): CachedChangeEvent[] {
  return summary.changeEvents?.length
    ? summary.changeEvents
    : buildLegacyChangeEvents({
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        changeTotals: summary.changeTotals,
      });
}

function isEventInRange(timestamp: string, context: AggregationContext): boolean {
  const localDate = getEventLocalDate(timestamp, context.timeZone);
  if (!localDate) return false;
  return isDateInRange(localDate, context.range);
}

function usageEventTokenTotal(event: CachedUsageEvent): number {
  return event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
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

function recordSessionStart(
  summary: CachedSessionSummary,
  context: AggregationContext,
  buckets: Map<string, MutableAnalyticsTimeBucket>,
  sessionId: string,
): void {
  if (!isEventInRange(summary.createdAt, context)) return;
  const key = getBucketKey(summary.createdAt, context.timeZone, context.granularity);
  if (!key) return;
  ensureBucket(buckets, key, context.granularity).sessionStartIds.add(sessionId);
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

function addEventModelUsage(
  modelUsage: DashboardStats['modelUsage'],
  model: string,
  event: CachedUsageEvent,
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

  existing.inputTokens += event.inputTokens;
  existing.outputTokens += event.outputTokens;
  existing.cacheReadInputTokens += event.cacheReadTokens;
  existing.cacheCreationInputTokens += event.cacheWriteTokens;
  existing.reasoningOutputTokens = (existing.reasoningOutputTokens || 0) + (event.reasoningOutputTokens || 0);
  existing.estimatedCosts = addCosts(existing.estimatedCosts, event.estimatedCosts);
  existing.estimatedCost = existing.estimatedCosts[DEFAULT_COST_MODE];
  modelUsage[model] = existing;
}

export function normalizeSearchText(parts: Array<string | undefined>): string {
  return Array.from(new Set(parts.filter((part): part is string => Boolean(part?.trim()))))
    .join('\n')
    .toLowerCase()
    .slice(0, 8 * 1024);
}
