import type { AgentKind } from './types';
import type { DashboardStats, LiveSessionInfo, ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';
import type { CachedSessionSummary, SessionSummarySource } from './session-summary';
import type { SourceParseCheckpoint } from './session-parse-checkpoint';

export interface IncrementalSessionSummaryResult {
  summary: CachedSessionSummary;
  checkpoint: SourceParseCheckpoint;
}

export interface IncrementalSessionSummaryProvider {
  checkpointVersion: number;
  buildSessionSummary(
    source: SessionSummarySource,
    previousSummary: CachedSessionSummary,
    checkpoint: SourceParseCheckpoint,
  ): Promise<IncrementalSessionSummaryResult>;
}

export interface AgentDataProvider {
  kind: AgentKind;
  parserVersion?: string;
  getProjects(): Promise<ProjectInfo[]>;
  getSessions(limit?: number, offset?: number): Promise<SessionInfo[]>;
  getProjectSessions(projectId: string): Promise<SessionInfo[]>;
  getSessionDetail(routeOrNativeId: string): Promise<SessionDetail | null>;
  getSessionDetailWithDescendants?(routeOrNativeId: string): Promise<SessionDetail | null>;
  searchSessions(query: string, limit?: number): Promise<SessionInfo[]>;
  getDashboardStats(): Promise<DashboardStats>;
  discoverSessionSources?(): Promise<SessionSummarySource[]>;
  buildSessionSummary?(source: SessionSummarySource): Promise<CachedSessionSummary>;
  buildLightweightSessionSummary?(source: SessionSummarySource): CachedSessionSummary;
  incrementalSessionSummary?: IncrementalSessionSummaryProvider;
  resetCache?(): void;
  getLiveSessions?(): LiveSessionInfo[];
  canResume?: boolean;
}
