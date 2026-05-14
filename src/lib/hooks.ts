import useSWR from 'swr';
import type { AgentKind } from '@/lib/agent-data/types';
import type { SessionIndexState } from '@/lib/agent-data/indexer';
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

export function useSessions(limit = 50, offset = 0, query = '', fallbackData?: SessionInfo[]) {
  const url = query
    ? `/api/sessions?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&includeTotal=1`
    : `/api/sessions?limit=${limit}&offset=${offset}&includeTotal=1`;
  const fallbackPage = fallbackData
    ? { sessions: fallbackData.slice(offset, offset + limit), total: fallbackData.length, limit, offset }
    : undefined;
  return useSWR<SessionsPage>(url, fetcher, { fallbackData: fallbackPage });
}

export function useProjectSessions(projectId: string, fallbackData?: SessionInfo[]) {
  return useSWR<SessionInfo[]>(`/api/sessions?projectId=${projectId}`, fetcher, { fallbackData });
}

export function useSessionDetail(sessionId: string) {
  return useSWR<SessionDetail>(`/api/sessions/${sessionId}`, fetcher, {
    refreshInterval: (latestData) => latestData?.isLive ? 1000 : 0,
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
  return useSWR<CacheStatus>('/api/cache', fetcher, {
    refreshInterval: (latestData) => {
      if (!latestData) return 2000;
      return latestData.status === 'refreshing' || latestData.status === 'stale' || latestData.status === 'empty'
        ? 2000
        : 15000;
    },
  });
}
