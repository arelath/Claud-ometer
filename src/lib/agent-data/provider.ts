import type { AgentKind } from './types';
import type { DashboardStats, LiveSessionInfo, ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';

export interface AgentDataProvider {
  kind: AgentKind;
  getProjects(): Promise<ProjectInfo[]>;
  getSessions(limit?: number, offset?: number): Promise<SessionInfo[]>;
  getProjectSessions(projectId: string): Promise<SessionInfo[]>;
  getSessionDetail(routeOrNativeId: string): Promise<SessionDetail | null>;
  searchSessions(query: string, limit?: number): Promise<SessionInfo[]>;
  getDashboardStats(): Promise<DashboardStats>;
  getLiveSessions?(): LiveSessionInfo[];
  canResume?: boolean;
}
