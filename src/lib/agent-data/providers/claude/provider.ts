import { makeRouteId, parseRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import type { DashboardStats, LiveSessionInfo, ProjectInfo, SessionDetail, SessionInfo } from '@/lib/claude-data/types';
import * as reader from '@/lib/claude-data/reader';
import { getLiveSessions } from '@/lib/claude-data/live-sessions';
import { getCachedSessionSummaries } from '@/lib/agent-data/session-summary-store';
import { summariesToDashboardStats, summariesToProjects, summariesToSessions, type CachedSessionSummary } from '@/lib/agent-data/session-summary';

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

function hasSummarySupport(): boolean {
  return 'discoverSessionSummarySources' in reader
    && 'buildSessionSummary' in reader
    && typeof reader.discoverSessionSummarySources === 'function'
    && typeof reader.buildSessionSummary === 'function';
}

const claudeParserVersion = 'CLAUDE_SESSION_SUMMARY_PARSER_VERSION' in reader
  ? reader.CLAUDE_SESSION_SUMMARY_PARSER_VERSION
  : undefined;

function summarySearchText(summary: CachedSessionSummary): string {
  return [
    summary.title,
    summary.projectName,
    summary.cwd,
    summary.gitBranch,
    summary.version,
    summary.model,
    ...summary.models,
    ...Object.keys(summary.toolsUsed || {}),
    summary.searchTextPreview,
  ].filter(Boolean).join('\n').toLowerCase();
}

export const claudeProvider: AgentDataProvider = {
  kind: 'claude',
  parserVersion: claudeParserVersion,
  canResume: true,
  async getProjects() {
    if (hasSummarySupport()) return summariesToProjects(await getCachedSessionSummaries([claudeProvider]));
    return (await reader.getProjects()).map(withProjectIdentity);
  },
  async getSessions(limit, offset) {
    if (hasSummarySupport()) return summariesToSessions(await getCachedSessionSummaries([claudeProvider])).slice(offset || 0, (offset || 0) + (limit || 50));
    return (await reader.getSessions(limit, offset)).map(withSessionIdentity);
  },
  async getProjectSessions(projectId) {
    if (hasSummarySupport()) {
      const nativeProjectId = nativeId(projectId);
      return summariesToSessions((await getCachedSessionSummaries([claudeProvider]))
        .filter(summary => summary.nativeProjectId === nativeProjectId || summary.projectRouteId === projectId));
    }
    return (await reader.getProjectSessions(nativeId(projectId))).map(withSessionIdentity);
  },
  async getSessionDetail(routeOrNativeId) {
    const session = await reader.getSessionDetail(nativeId(routeOrNativeId));
    return session ? withSessionDetailIdentity(session) : null;
  },
  async searchSessions(query, limit) {
    if (hasSummarySupport()) {
      if (!query.trim()) return summariesToSessions(await getCachedSessionSummaries([claudeProvider])).slice(0, limit || 50);
      const lowerQuery = query.toLowerCase();
      const summaries = (await getCachedSessionSummaries([claudeProvider]))
        .filter(summary => summarySearchText(summary).includes(lowerQuery))
        .slice(0, limit || 50);
      return summariesToSessions(summaries);
    }
    return (await reader.searchSessions(query, limit)).map(withSessionIdentity);
  },
  async getDashboardStats() {
    if (hasSummarySupport()) return summariesToDashboardStats(await getCachedSessionSummaries([claudeProvider]));
    const stats: DashboardStats = await reader.getDashboardStats();
    return {
      ...stats,
      recentSessions: stats.recentSessions.map(withSessionIdentity),
    };
  },
  discoverSessionSources: 'discoverSessionSummarySources' in reader ? reader.discoverSessionSummarySources : undefined,
  buildSessionSummary: 'buildSessionSummary' in reader ? reader.buildSessionSummary : undefined,
  resetCache: 'resetClaudeReaderCache' in reader ? reader.resetClaudeReaderCache : undefined,
  getLiveSessions() {
    return getLiveSessions().map(withLiveSessionIdentity);
  },
};
