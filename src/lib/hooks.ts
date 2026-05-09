import useSWR from 'swr';
import type { AgentKind } from '@/lib/agent-data/types';
import type { DashboardStats, LiveSessionInfo, ProjectInfo, SessionInfo, SessionDetail } from '@/lib/claude-data/types';

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

const fetcher = (url: string) => fetch(url).then(r => {
  if (!r.ok) throw new Error(`API error: ${r.status}`);
  return r.json();
});

export function useStats(fallbackData?: DashboardStats) {
  return useSWR<DashboardStats>('/api/stats', fetcher, { fallbackData });
}

export function useProjects(fallbackData?: ProjectInfo[]) {
  return useSWR<ProjectInfo[]>('/api/projects', fetcher, { fallbackData });
}

export function useSessions(limit = 50, offset = 0, query = '', fallbackData?: SessionInfo[]) {
  const url = query
    ? `/api/sessions?q=${encodeURIComponent(query)}&limit=${limit}`
    : `/api/sessions?limit=${limit}&offset=${offset}`;
  return useSWR<SessionInfo[]>(url, fetcher, { fallbackData });
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
