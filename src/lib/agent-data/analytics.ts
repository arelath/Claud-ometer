import type { AgentDataProvider } from './provider';
import { getCostAnalyticsSql, getDashboardStatsSql, getProjectsSql } from './analytics-sql';
import { summariesToCostAnalytics, summariesToDashboardStats } from './session-summary';
import type { DashboardStats, ProjectInfo } from '@/lib/claude-data/types';
import type { TimeRangeParams } from '@/lib/time-range';

export interface CostAnalyticsPayload {
  stats: DashboardStats;
  projects: ProjectInfo[];
}

export function getCachedDashboardStats(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): DashboardStats {
  return getDashboardStatsSql(providers, range) || summariesToDashboardStats([], range);
}

export function getCachedProjects(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): ProjectInfo[] {
  return getProjectsSql(providers, range) || [];
}

export function getCachedCostAnalytics(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): CostAnalyticsPayload {
  return getCostAnalyticsSql(providers, range) || summariesToCostAnalytics([], range);
}

export function resetAnalyticsMemo(): void {
  // SQL reads are revision-consistent and no longer hydrate or memoize the summary corpus.
}

export function resetAnalyticsMemoForTests(): void {
  resetAnalyticsMemo();
}
