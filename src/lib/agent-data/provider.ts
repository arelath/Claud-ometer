import type { AgentKind } from './types';
import type { DashboardStats, LiveSessionInfo, ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';
import type { CachedSessionSummary, SessionSummarySource } from './session-summary';

export interface AgentDataProvider {
  kind: AgentKind;
  parserVersion?: string;
  getProjects(): Promise<ProjectInfo[]>;
  getSessions(limit?: number, offset?: number): Promise<SessionInfo[]>;
  getProjectSessions(projectId: string): Promise<SessionInfo[]>;
  getSessionDetail(routeOrNativeId: string): Promise<SessionDetail | null>;
  searchSessions(query: string, limit?: number): Promise<SessionInfo[]>;
  getDashboardStats(): Promise<DashboardStats>;
  discoverSessionSources?(): Promise<SessionSummarySource[]>;
  buildSessionSummary?(source: SessionSummarySource): Promise<CachedSessionSummary>;
  getLiveSessions?(): LiveSessionInfo[];
  canResume?: boolean;
}
