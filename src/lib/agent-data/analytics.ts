import type { AgentDataProvider } from './provider';
import { getIndexedSessionSnapshot } from './indexer';
import { getCostAnalyticsSql, getDashboardStatsSql, getProjectsSql } from './analytics-sql';
import {
  summariesToCostAnalytics,
  summariesToDashboardStats,
  summariesToProjects,
  type CachedSessionSummary,
} from './session-summary';
import { sortProjectsByLastActive } from './aggregate';
import type { DashboardStats, ProjectInfo } from '@/lib/claude-data/types';
import type { TimeRangeParams } from '@/lib/time-range';

export interface CostAnalyticsPayload {
  stats: DashboardStats;
  projects: ProjectInfo[];
}

interface MemoEntry {
  key: string;
  summaries: CachedSessionSummary[];
  stats?: DashboardStats;
  projects?: ProjectInfo[];
  costs?: CostAnalyticsPayload;
}

const memo = new Map<string, MemoEntry>();

function providerKey(providers: AgentDataProvider[]): string {
  return providers
    .map(provider => `${provider.kind}:${provider.parserVersion || 'none'}`)
    .sort()
    .join(',');
}

function rangeKey(range: TimeRangeParams): string {
  return `${range.start || ''}:${range.end || ''}:${range.timeZone || ''}:${range.granularity || ''}`;
}

function getMemoEntry(providers: AgentDataProvider[], range: TimeRangeParams): MemoEntry {
  const snapshot = getIndexedSessionSnapshot(providers);
  const key = `${providerKey(providers)}:${snapshot.signature}:${rangeKey(range)}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const entry: MemoEntry = { key, summaries: snapshot.summaries };
  memo.set(key, entry);
  return entry;
}

export function getCachedDashboardStats(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): DashboardStats {
  try {
    const sqlStats = getDashboardStatsSql(providers, range);
    if (sqlStats) return sqlStats;
  } catch {
    // Fall back to the payload cache if the SQLite analytics path is unavailable.
  }

  const entry = getMemoEntry(providers, range);
  entry.stats ||= summariesToDashboardStats(entry.summaries, range);
  return entry.stats;
}

export function getCachedProjects(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): ProjectInfo[] {
  try {
    const sqlProjects = getProjectsSql(providers, range);
    if (sqlProjects) return sqlProjects;
  } catch {
    // Fall back to the payload cache if the SQLite analytics path is unavailable.
  }

  const entry = getMemoEntry(providers, range);
  entry.projects ||= sortProjectsByLastActive(summariesToProjects(entry.summaries, range));
  return entry.projects;
}

export function getCachedCostAnalytics(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): CostAnalyticsPayload {
  try {
    const sqlCosts = getCostAnalyticsSql(providers, range);
    if (sqlCosts) return sqlCosts;
  } catch {
    // Fall back to the payload cache if the SQLite analytics path is unavailable.
  }

  const entry = getMemoEntry(providers, range);
  if (!entry.costs) {
    entry.costs = summariesToCostAnalytics(entry.summaries, range);
  }
  return entry.costs;
}

export function resetAnalyticsMemo(): void {
  memo.clear();
}

export function resetAnalyticsMemoForTests(): void {
  resetAnalyticsMemo();
}
