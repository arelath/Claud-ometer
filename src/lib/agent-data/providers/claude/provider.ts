import { makeRouteId, parseRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import type { DashboardStats, LiveSessionInfo, ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';
import * as reader from '@/lib/claude-data/reader';
import { getLiveSessions } from '@/lib/claude-data/live-sessions';

function nativeId(id: string): string {
  return parseRouteId(id).nativeId;
}

function withProjectIdentity(project: ProjectInfo): ProjectInfo {
  const nativeProjectId = project.nativeId || nativeId(project.id);
  const routeId = qualifyProjectId('claude', nativeProjectId);
  return {
    ...project,
    agentKind: 'claude',
    nativeId: nativeProjectId,
    routeId,
  };
}

function withSessionIdentity(session: SessionInfo): SessionInfo {
  const nativeSessionId = session.nativeId || nativeId(session.id);
  const nativeProjectId = session.nativeProjectId || nativeId(session.projectId);
  return {
    ...session,
    agentKind: 'claude',
    nativeId: nativeSessionId,
    routeId: makeRouteId('claude', nativeSessionId),
    nativeProjectId,
    projectRouteId: qualifyProjectId('claude', nativeProjectId),
  };
}

function withSessionDetailIdentity(session: SessionDetail): SessionDetail {
  return {
    ...session,
    ...withSessionIdentity(session),
  };
}

function withLiveSessionIdentity(session: LiveSessionInfo): LiveSessionInfo {
  return {
    ...session,
    agentKind: 'claude',
    nativeId: session.sessionId,
    routeId: makeRouteId('claude', session.sessionId),
  };
}

export const claudeProvider: AgentDataProvider = {
  kind: 'claude',
  canResume: true,
  async getProjects() {
    return (await reader.getProjects()).map(withProjectIdentity);
  },
  async getSessions(limit, offset) {
    return (await reader.getSessions(limit, offset)).map(withSessionIdentity);
  },
  async getProjectSessions(projectId) {
    return (await reader.getProjectSessions(nativeId(projectId))).map(withSessionIdentity);
  },
  async getSessionDetail(routeOrNativeId) {
    const session = await reader.getSessionDetail(nativeId(routeOrNativeId));
    return session ? withSessionDetailIdentity(session) : null;
  },
  async searchSessions(query, limit) {
    return (await reader.searchSessions(query, limit)).map(withSessionIdentity);
  },
  async getDashboardStats() {
    const stats: DashboardStats = await reader.getDashboardStats();
    return {
      ...stats,
      recentSessions: stats.recentSessions.map(withSessionIdentity),
    };
  },
  getLiveSessions() {
    return getLiveSessions().map(withLiveSessionIdentity);
  },
};
