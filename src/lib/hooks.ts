import useSWR from 'swr';
import type { DashboardStats, ProjectInfo, SessionInfo, SessionDetail } from '@/lib/claude-data/types';

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
  return useSWR<SessionDetail>(`/api/sessions/${sessionId}`, fetcher);
}
