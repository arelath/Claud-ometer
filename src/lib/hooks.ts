import useSWR from 'swr';
import type { AgentKind } from '@/lib/agent-data/types';
import type { SessionIndexState } from '@/lib/agent-data/indexer';
import type { CostAnalyticsPayload } from '@/lib/agent-data/analytics';
import type { DashboardStats, LiveSessionInfo, ProjectInfo, SessionInfo, SessionDetail } from '@/lib/claude-data/types';
import { buildTimeRangeQuery, type TimeRangeParams } from '@/lib/time-range';

export interface DataSourceInfo {
  active: 'live' | 'imported';
  agents: AgentKind[];
  detectedAgents: AgentKind[];
  hasImportedData: boolean;
  importMeta: {
    importedAt: string;
    exportedAt: string;
    exportedFrom: string;
    projectCount: number;
    sessionCount: number;
    fileCount?: number;
    totalSize?: number;
    agents?: AgentKind[];
    agentCounts?: Partial<Record<AgentKind, { projectCount: number; sessionCount: number }>>;
  } | null;
}

export interface CacheStatus {
  status: SessionIndexState;
  cachePath: string;
  exists: boolean;
  generatedAt: string;
  summaryCount: number;
  activeProviders: AgentKind[];
  sourceCount: number;
  validCount: number;
  staleCount: number;
  missingCount: number;
  unindexedCount: number;
  refreshStartedAt?: string;
  refreshCompletedAt?: string;
  refreshError?: string;
}

export interface SessionsPage {
  sessions: SessionInfo[];
  total: number;
  limit: number;
  offset: number;
}

const fetcher = (url: string) => fetch(url).then(r => {
  if (!r.ok) throw new Error(`API error: ${r.status}`);
  return r.json();
});

export function useStats(fallbackData?: DashboardStats, timeRange?: TimeRangeParams) {
  const query = buildTimeRangeQuery(timeRange);
  return useSWR<DashboardStats>(`/api/stats${query}`, fetcher, { fallbackData: query ? undefined : fallbackData });
}

export function useProjects(fallbackData?: ProjectInfo[], timeRange?: TimeRangeParams) {
  const query = buildTimeRangeQuery(timeRange);
  return useSWR<ProjectInfo[]>(`/api/projects${query}`, fetcher, { fallbackData: query ? undefined : fallbackData });
}

export function useCostAnalytics(fallbackData?: CostAnalyticsPayload, timeRange?: TimeRangeParams) {
  const query = buildTimeRangeQuery(timeRange);
  return useSWR<CostAnalyticsPayload>(`/api/costs${query}`, fetcher, { fallbackData: query ? undefined : fallbackData });
}

export function useSessions(limit = 50, offset = 0, query = '', fallbackData?: SessionInfo[], timeRange?: TimeRangeParams) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('includeTotal', '1');
  if (timeRange?.start) params.set('start', timeRange.start);
  if (timeRange?.end) params.set('end', timeRange.end);
  if (timeRange?.timeZone) params.set('tz', timeRange.timeZone);
  if (timeRange?.granularity) params.set('granularity', timeRange.granularity);
  const hasTimeRange = Boolean(timeRange?.start || timeRange?.end);
  const url = `/api/sessions?${params.toString()}`;
  const fallbackPage = fallbackData && !hasTimeRange
    ? { sessions: fallbackData.slice(offset, offset + limit), total: fallbackData.length, limit, offset }
    : undefined;
  return useSWR<SessionsPage>(url, fetcher, { fallbackData: fallbackPage });
}

export function useProjectSessions(projectId: string, fallbackData?: SessionInfo[]) {
  const params = new URLSearchParams({ projectId });
  return useSWR<SessionInfo[]>(`/api/sessions?${params.toString()}`, fetcher, { fallbackData });
}

export function useSessionDetail(sessionId: string) {
  return useSWR<SessionDetail>(`/api/sessions/${sessionId}`, fetcher, {
    refreshInterval: (latestData) => latestData?.isLive ? 2500 : 0,
    dedupingInterval: 2000,
    keepPreviousData: true,
    compare: (previous, next) => (
      previous?.id === next?.id
      && previous?.messageCount === next?.messageCount
      && previous?.liveStatus === next?.liveStatus
      && previous?.liveMetadataRevision === next?.liveMetadataRevision
      && previous?.liveTranscriptRevision === next?.liveTranscriptRevision
    ),
  });
}

export function useSessionSummary(sessionId: string) {
  return useSWR<SessionInfo>(`/api/sessions/${sessionId}/summary`, fetcher, {
    revalidateOnFocus: false,
  });
}

export function useDataSourceInfo() {
  return useSWR<DataSourceInfo>('/api/data-source', fetcher, { refreshInterval: 5000 });
}

export function useLiveSessions() {
  return useSWR<LiveSessionInfo[]>('/api/live-sessions', fetcher, { refreshInterval: 1000 });
}

export function useLiveSessionBinding(sessionId: string) {
  return useSWR<LiveSessionInfo | null>(`/api/live-sessions/by-session/${sessionId}`, fetcher, { refreshInterval: 1000 });
}

export function useCacheStatus() {
  return useSWR<CacheStatus>('/api/cache?quick=1', fetcher, {
    refreshInterval: (latestData) => {
      if (!latestData) return 2000;
      return latestData.status === 'refreshing' || latestData.status === 'stale' || latestData.status === 'empty'
        ? 2000
        : 15000;
    },
  });
}
