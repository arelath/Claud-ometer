import type { AgentDataProvider } from './provider';
import { getCostAnalyticsSql, getDashboardStatsSql, getProjectsSql } from './analytics-sql';
import { summariesToCostAnalytics, summariesToDashboardStats } from './session-summary';
import type { DashboardStats, ProjectInfo } from '@/lib/claude-data/types';
import type { TimeRangeParams } from '@/lib/time-range';
import { getSessionSummaryIndexReadSignature } from './session-summary-sqlite-store';

export interface CostAnalyticsPayload {
  stats: DashboardStats;
  projects: ProjectInfo[];
}

// Retain only the last view for each endpoint. Progress updates in the indexer
// do not change the published analytics, whereas a new committed revision does.
function memoizeView<T>(read: (providers: AgentDataProvider[], range: TimeRangeParams) => T) {
  let last: { key: string; result: T } | undefined;
  return {
    read(providers: AgentDataProvider[], range: TimeRangeParams) {
      const key = JSON.stringify([
        getSessionSummaryIndexReadSignature(), providers.map(provider => provider.kind).sort(),
        range.start, range.end, range.timeZone, range.granularity,
      ]);
      if (last?.key === key) return last.result;
      const result = read(providers, range);
      last = { key, result };
      return result;
    },
    clear() { last = undefined; },
  };
}

const dashboard = memoizeView(getDashboardStatsSql);
const projects = memoizeView(getProjectsSql);
const costs = memoizeView(getCostAnalyticsSql);

export function getCachedDashboardStats(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): DashboardStats {
  return dashboard.read(providers, range) || summariesToDashboardStats([], range);
}

export function getCachedProjects(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): ProjectInfo[] {
  return projects.read(providers, range) || [];
}

export function getCachedCostAnalytics(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): CostAnalyticsPayload {
  return costs.read(providers, range) || summariesToCostAnalytics([], range);
}

export function resetAnalyticsMemo(): void {
  dashboard.clear();
  projects.clear();
  costs.clear();
}

export function resetAnalyticsMemoForTests(): void {
  resetAnalyticsMemo();
}
