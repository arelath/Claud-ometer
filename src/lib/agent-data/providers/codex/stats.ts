import type { DashboardStats, DailyActivity, DailyChangeActivity, DailyModelTokens, ModelUsage, SessionInfo } from '@/lib/claude-data/types';
import { zeroCosts, addCosts } from '@/lib/claude-data/cost-utils';
import { addChangeTotals, zeroChangeTotals } from '@/lib/claude-data/change-utils';
import { getSessionChangeTotals } from '@/lib/session-diff';
import type { CodexParsedSession } from './transcript-parser';

function datePart(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function hourPart(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '0';
  return String(date.getHours());
}

export function buildCodexDashboardStats(parsedSessions: CodexParsedSession[]): DashboardStats {
  const sessions = parsedSessions.map(parsed => parsed.info);
  const dailyActivity = new Map<string, DailyActivity>();
  const dailyChangeActivity = new Map<string, DailyChangeActivity>();
  const dailyModelTokens = new Map<string, DailyModelTokens>();
  const modelUsage: DashboardStats['modelUsage'] = {};
  const hourCounts: Record<string, number> = {};
  let totalEstimatedCosts = zeroCosts();
  let changeTotals = zeroChangeTotals();

  for (const parsed of parsedSessions) {
    const session = parsed.info;
    const date = datePart(session.timestamp);
    const activity = dailyActivity.get(date) || { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
    activity.sessionCount += 1;
    activity.messageCount += session.messageCount;
    activity.toolCallCount += session.toolCallCount;
    dailyActivity.set(date, activity);

    const sessionChangeTotals = getSessionChangeTotals(parsed.detail.messages);
    changeTotals = addChangeTotals(changeTotals, sessionChangeTotals);
    const existingDailyChangeActivity = dailyChangeActivity.get(date) || {
      date,
      ...zeroChangeTotals(),
      sessionCount: 0,
    };
    const nextDailyChangeTotals = addChangeTotals(existingDailyChangeActivity, sessionChangeTotals);
    dailyChangeActivity.set(date, {
      date,
      ...nextDailyChangeTotals,
      sessionCount: existingDailyChangeActivity.sessionCount + 1,
    });

    const hour = hourPart(session.timestamp);
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;

    const tokenTotal = session.totalInputTokens + session.totalOutputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens;
    const dailyTokens = dailyModelTokens.get(date) || { date, tokensByModel: {}, costsByModel: {} };
    dailyTokens.tokensByModel[session.model] = (dailyTokens.tokensByModel[session.model] || 0) + tokenTotal;
    dailyTokens.costsByModel![session.model] = addCosts(dailyTokens.costsByModel![session.model] || zeroCosts(), session.estimatedCosts);
    dailyModelTokens.set(date, dailyTokens);

    const existing = modelUsage[session.model] || {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
      webSearchRequests: 0,
      estimatedCost: 0,
      estimatedCosts: zeroCosts(),
      reasoningOutputTokens: 0,
    } as ModelUsage & { estimatedCost: number; estimatedCosts: Record<'api' | 'conservative' | 'subscription', number>; reasoningOutputTokens?: number };
    existing.inputTokens += session.totalInputTokens;
    existing.outputTokens += session.totalOutputTokens;
    existing.cacheReadInputTokens += session.totalCacheReadTokens;
    existing.cacheCreationInputTokens += session.totalCacheWriteTokens;
    existing.estimatedCosts = addCosts(existing.estimatedCosts, session.estimatedCosts);
    existing.estimatedCost += session.estimatedCost;
    existing.reasoningOutputTokens = (existing.reasoningOutputTokens || 0) + parsed.reasoningOutputTokens;
    modelUsage[session.model] = existing;
    totalEstimatedCosts = addCosts(totalEstimatedCosts, session.estimatedCosts);
  }

  const longestSession = sessions.reduce<SessionInfo | null>((longest, session) => {
    if (!longest || session.duration > longest.duration) return session;
    return longest;
  }, null);

  const projectIds = new Set(sessions.map(session => session.projectId));

  return {
    totalSessions: sessions.length,
    totalMessages: sessions.reduce((sum, session) => sum + session.messageCount, 0),
    totalTokens: sessions.reduce((sum, session) => sum + session.totalInputTokens + session.totalOutputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens, 0),
    estimatedCost: totalEstimatedCosts.subscription,
    estimatedCosts: totalEstimatedCosts,
    dailyActivity: Array.from(dailyActivity.values()).sort((a, b) => a.date.localeCompare(b.date)),
    dailyModelTokens: Array.from(dailyModelTokens.values()).sort((a, b) => a.date.localeCompare(b.date)),
    changeTotals,
    dailyChangeActivity: Array.from(dailyChangeActivity.values()).sort((a, b) => a.date.localeCompare(b.date)),
    modelUsage,
    hourCounts,
    firstSessionDate: sessions.map(session => session.timestamp).sort()[0] || '',
    longestSession: longestSession
      ? {
          sessionId: longestSession.id,
          duration: longestSession.duration,
          messageCount: longestSession.messageCount,
          timestamp: longestSession.timestamp,
        }
      : { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    projectCount: projectIds.size,
    recentSessions: sessions.slice(0, 10),
  };
}
