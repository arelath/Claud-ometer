import type { CostEstimates, DashboardStats, DailyActivity, DailyModelTokens, ModelUsage, ProjectInfo, SessionInfo } from '@/lib/claude-data/types';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import { DEFAULT_COST_MODE } from '@/config/pricing';

export function sortSessionsByTimestamp(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

export function sortProjectsByLastActive(projects: ProjectInfo[]): ProjectInfo[] {
  return [...projects].sort((left, right) => right.lastActive.localeCompare(left.lastActive));
}

export function mergeDailyActivity(stats: DashboardStats[]): DailyActivity[] {
  const merged = new Map<string, DailyActivity>();
  for (const source of stats) {
    for (const day of source.dailyActivity) {
      const existing = merged.get(day.date) || { date: day.date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
      existing.messageCount += day.messageCount;
      existing.sessionCount += day.sessionCount;
      existing.toolCallCount += day.toolCallCount;
      merged.set(day.date, existing);
    }
  }
  return Array.from(merged.values()).sort((left, right) => left.date.localeCompare(right.date));
}

export function mergeDailyModelTokens(stats: DashboardStats[]): DailyModelTokens[] {
  const tokensByDate = new Map<string, DailyModelTokens>();
  for (const source of stats) {
    for (const day of source.dailyModelTokens) {
      const existing = tokensByDate.get(day.date) || { date: day.date, tokensByModel: {}, costsByModel: {} };
      for (const [model, tokens] of Object.entries(day.tokensByModel)) {
        existing.tokensByModel[model] = (existing.tokensByModel[model] || 0) + tokens;
      }
      for (const [model, costs] of Object.entries(day.costsByModel || {})) {
        existing.costsByModel![model] = addCosts(existing.costsByModel![model] || zeroCosts(), costs);
      }
      tokensByDate.set(day.date, existing);
    }
  }
  return Array.from(tokensByDate.values()).sort((left, right) => left.date.localeCompare(right.date));
}

export function mergeModelUsage(stats: DashboardStats[]): DashboardStats['modelUsage'] {
  const merged: DashboardStats['modelUsage'] = {};
  for (const source of stats) {
    for (const [model, usage] of Object.entries(source.modelUsage)) {
      const existing = merged[model] || {
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
      existing.costUSD += usage.costUSD;
      existing.webSearchRequests += usage.webSearchRequests;
      existing.estimatedCost += usage.estimatedCost;
      existing.estimatedCosts = addCosts(existing.estimatedCosts, usage.estimatedCosts);
      merged[model] = existing;
    }
  }
  return merged;
}

export function mergeDashboardStats(stats: DashboardStats[]): DashboardStats {
  if (stats.length === 1) return stats[0];

  const estimatedCosts = stats.reduce((sum, item) => addCosts(sum, item.estimatedCosts), zeroCosts());
  const recentSessions = sortSessionsByTimestamp(stats.flatMap(item => item.recentSessions)).slice(0, 10);
  const hourCounts: Record<string, number> = {};
  for (const source of stats) {
    for (const [hour, count] of Object.entries(source.hourCounts)) {
      hourCounts[hour] = (hourCounts[hour] || 0) + count;
    }
  }

  const longest = stats
    .map(item => item.longestSession)
    .sort((left, right) => right.duration - left.duration)[0] || { sessionId: '', duration: 0, messageCount: 0, timestamp: '' };

  return {
    totalSessions: stats.reduce((sum, item) => sum + item.totalSessions, 0),
    totalMessages: stats.reduce((sum, item) => sum + item.totalMessages, 0),
    totalTokens: stats.reduce((sum, item) => sum + item.totalTokens, 0),
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
    estimatedCosts,
    dailyActivity: mergeDailyActivity(stats),
    dailyModelTokens: mergeDailyModelTokens(stats),
    modelUsage: mergeModelUsage(stats),
    hourCounts,
    firstSessionDate: stats.map(item => item.firstSessionDate).filter(Boolean).sort()[0] || '',
    longestSession: longest,
    projectCount: stats.reduce((sum, item) => sum + item.projectCount, 0),
    recentSessions,
  };
}
