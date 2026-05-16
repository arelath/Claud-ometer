import type { AgentDataProvider } from './provider';
import { getIndexedSessionSnapshot } from './indexer';
import {
  summariesToDashboardStats,
  summariesToProjects,
  type CachedSessionSummary,
} from './session-summary';
import { sortProjectsByLastActive } from './aggregate';
import type { DashboardStats, ProjectInfo } from '@/lib/claude-data/types';
import { filterByTimeRange, type TimeRangeParams } from '@/lib/time-range';

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
  return `${range.start || ''}:${range.end || ''}`;
}

function getMemoEntry(providers: AgentDataProvider[], range: TimeRangeParams): MemoEntry {
  const snapshot = getIndexedSessionSnapshot(providers);
  const key = `${providerKey(providers)}:${snapshot.signature}:${rangeKey(range)}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const summaries = filterByTimeRange(snapshot.summaries, range, summary => summary.createdAt);
  const entry: MemoEntry = { key, summaries };
  memo.set(key, entry);
  return entry;
}

export function getCachedDashboardStats(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): DashboardStats {
  const entry = getMemoEntry(providers, range);
  entry.stats ||= summariesToDashboardStats(entry.summaries);
  return entry.stats;
}

export function getCachedProjects(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): ProjectInfo[] {
  const entry = getMemoEntry(providers, range);
  entry.projects ||= sortProjectsByLastActive(summariesToProjects(entry.summaries));
  return entry.projects;
}

export function getCachedCostAnalytics(
  providers: AgentDataProvider[],
  range: TimeRangeParams = {},
): CostAnalyticsPayload {
  const entry = getMemoEntry(providers, range);
  if (!entry.costs) {
    entry.costs = {
      stats: entry.stats || summariesToDashboardStats(entry.summaries),
      projects: entry.projects || sortProjectsByLastActive(summariesToProjects(entry.summaries)),
    };
    entry.stats = entry.costs.stats;
    entry.projects = entry.costs.projects;
  }
  return entry.costs;
}

export function resetAnalyticsMemo(): void {
  memo.clear();
}

export function resetAnalyticsMemoForTests(): void {
  resetAnalyticsMemo();
}
