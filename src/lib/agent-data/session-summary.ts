import { calculateCostAllModes, DEFAULT_COST_MODE } from '@/config/pricing';
import { addChangeTotals, zeroChangeTotals } from '@/lib/claude-data/change-utils';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import type {
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
import type { AgentKind } from './types';

export const SESSION_SUMMARY_CACHE_VERSION = 3;

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
  toolsUsed: Record<string, number>;
  compaction: CompactionInfo;
  searchTextPreview?: string;
}

function datePart(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function hourPart(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '0';
  return String(date.getHours());
}

function tokenTotal(usage: CachedModelUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

function summaryTokenTotal(summary: CachedSessionSummary): number {
  return summary.tokenTotals.input + summary.tokenTotals.output + summary.tokenTotals.cacheRead + summary.tokenTotals.cacheWrite;
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
  return sortSummariesByTimestamp(summaries).map(summaryToSessionInfo);
}

export function summariesToProjects(summaries: CachedSessionSummary[]): ProjectInfo[] {
  const projects = new Map<string, ProjectInfo>();

  for (const summary of summaries) {
    const session = summaryToSessionInfo(summary);
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
    project.totalMessages += summary.messageCount;
    project.totalTokens += summaryTokenTotal(summary);
    project.estimatedCosts = addCosts(project.estimatedCosts, session.estimatedCosts);
    project.estimatedCost = project.estimatedCosts[DEFAULT_COST_MODE];
    project.lastActive = project.lastActive && project.lastActive > summary.updatedAt ? project.lastActive : summary.updatedAt;
    project.models = Array.from(new Set([...project.models, ...summary.models]));
    projects.set(summary.projectRouteId, project);
  }

  return Array.from(projects.values()).sort((left, right) => right.lastActive.localeCompare(left.lastActive));
}

export function summariesToDashboardStats(summaries: CachedSessionSummary[]): DashboardStats {
  const sortedSummaries = sortSummariesByTimestamp(summaries);
  const sessions = sortedSummaries.map(summaryToSessionInfo);
  const dailyActivity = new Map<string, DailyActivity>();
  const dailyModelTokens = new Map<string, DailyModelTokens>();
  const dailyChangeActivity = new Map<string, DailyChangeActivity>();
  const modelUsage: DashboardStats['modelUsage'] = {};
  const hourCounts: Record<string, number> = {};
  let estimatedCosts = zeroCosts();
  let changeTotals = zeroChangeTotals();

  for (const summary of sortedSummaries) {
    const date = datePart(summary.createdAt);
    const activity = dailyActivity.get(date) || { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
    activity.sessionCount += 1;
    activity.messageCount += summary.messageCount;
    activity.toolCallCount += summary.toolCallCount;
    dailyActivity.set(date, activity);

    const summaryChangeTotals = summary.changeTotals || zeroChangeTotals();
    changeTotals = addChangeTotals(changeTotals, summaryChangeTotals);
    const existingDailyChangeActivity = dailyChangeActivity.get(date) || {
      date,
      ...zeroChangeTotals(),
      sessionCount: 0,
    };
    const nextDailyChangeTotals = addChangeTotals(existingDailyChangeActivity, summaryChangeTotals);
    dailyChangeActivity.set(date, {
      date,
      ...nextDailyChangeTotals,
      sessionCount: existingDailyChangeActivity.sessionCount + 1,
    });

    const hour = hourPart(summary.createdAt);
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;

    const dailyTokens = dailyModelTokens.get(date) || { date, tokensByModel: {}, costsByModel: {} };
    for (const [model, usage] of Object.entries(getSummaryModelUsage(summary))) {
      const costs = calculateCostAllModes(
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheReadInputTokens,
      );
      const tokens = tokenTotal(usage);
      dailyTokens.tokensByModel[model] = (dailyTokens.tokensByModel[model] || 0) + tokens;
      dailyTokens.costsByModel![model] = addCosts(dailyTokens.costsByModel![model] || zeroCosts(), costs);
      estimatedCosts = addCosts(estimatedCosts, costs);

      const existing = modelUsage[model] || {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        costUSD: 0,
        contextWindow: usage.contextWindow || 0,
        maxOutputTokens: usage.maxOutputTokens || 0,
        webSearchRequests: 0,
        estimatedCost: 0,
        estimatedCosts: zeroCosts(),
      } satisfies ModelUsage & { estimatedCost: number; estimatedCosts: CostEstimates };

      existing.inputTokens += usage.inputTokens;
      existing.outputTokens += usage.outputTokens;
      existing.cacheReadInputTokens += usage.cacheReadInputTokens;
      existing.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      existing.reasoningOutputTokens = (existing.reasoningOutputTokens || 0) + (usage.reasoningOutputTokens || 0);
      existing.webSearchRequests += usage.webSearchRequests || 0;
      existing.estimatedCosts = addCosts(existing.estimatedCosts, costs);
      existing.estimatedCost = existing.estimatedCosts[DEFAULT_COST_MODE];
      modelUsage[model] = existing;
    }
    dailyModelTokens.set(date, dailyTokens);
  }

  const longestSession = sessions.reduce<SessionInfo | null>((longest, session) => {
    if (!longest || session.duration > longest.duration) return session;
    return longest;
  }, null);

  return {
    totalSessions: summaries.length,
    totalMessages: summaries.reduce((sum, summary) => sum + summary.messageCount, 0),
    totalTokens: summaries.reduce((sum, summary) => sum + summaryTokenTotal(summary), 0),
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
    estimatedCosts,
    dailyActivity: Array.from(dailyActivity.values()).sort((left, right) => left.date.localeCompare(right.date)),
    dailyModelTokens: Array.from(dailyModelTokens.values()).sort((left, right) => left.date.localeCompare(right.date)),
    changeTotals,
    dailyChangeActivity: Array.from(dailyChangeActivity.values()).sort((left, right) => left.date.localeCompare(right.date)),
    modelUsage,
    hourCounts,
    firstSessionDate: summaries.map(summary => summary.createdAt).sort()[0]?.slice(0, 10) || '',
    longestSession: longestSession
      ? {
          sessionId: longestSession.id,
          duration: longestSession.duration,
          messageCount: longestSession.messageCount,
          timestamp: longestSession.timestamp,
        }
      : { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    projectCount: new Set(summaries.map(summary => summary.projectRouteId)).size,
    recentSessions: sessions.slice(0, 10),
  };
}

export function normalizeSearchText(parts: Array<string | undefined>): string {
  return Array.from(new Set(parts.filter((part): part is string => Boolean(part?.trim()))))
    .join('\n')
    .toLowerCase()
    .slice(0, 8 * 1024);
}
