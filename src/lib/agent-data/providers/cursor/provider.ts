import type { AgentDataProvider } from '@/lib/agent-data/provider';
import { getCachedSessionSummaries } from '@/lib/agent-data/session-summary-store';
import { summariesToDashboardStats, summariesToProjects, summariesToSessions, type CachedSessionSummary } from '@/lib/agent-data/session-summary';
import * as reader from './reader';

function summarySearchText(summary: CachedSessionSummary): string {
  return [
    summary.title,
    summary.projectName,
    summary.cwd,
    summary.searchTextPreview,
  ].filter(Boolean).join('\n').toLowerCase();
}

export const cursorProvider: AgentDataProvider = {
  kind: 'cursor',
  parserVersion: reader.CURSOR_SESSION_SUMMARY_PARSER_VERSION,
  canResume: false,
  async getProjects() {
    return summariesToProjects(await getCachedSessionSummaries([cursorProvider]));
  },
  async getSessions(limit, offset) {
    return summariesToSessions(await getCachedSessionSummaries([cursorProvider])).slice(offset || 0, (offset || 0) + (limit || 50));
  },
  async getProjectSessions(projectId) {
    const nativeProjectId = projectId.startsWith('cursor:') ? projectId.slice('cursor:'.length) : projectId;
    return summariesToSessions((await getCachedSessionSummaries([cursorProvider]))
      .filter(summary => summary.nativeProjectId === nativeProjectId || summary.projectRouteId === projectId));
  },
  getSessionDetail: reader.getSessionDetail,
  async searchSessions(query, limit) {
    if (!query.trim()) return summariesToSessions(await getCachedSessionSummaries([cursorProvider])).slice(0, limit || 50);
    const lowerQuery = query.toLowerCase();
    const summaries = (await getCachedSessionSummaries([cursorProvider]))
      .filter(summary => summarySearchText(summary).includes(lowerQuery))
      .slice(0, limit || 50);
    return summariesToSessions(summaries);
  },
  async getDashboardStats() {
    return summariesToDashboardStats(await getCachedSessionSummaries([cursorProvider]));
  },
  discoverSessionSources: reader.discoverSessionSummarySources,
  buildSessionSummary: reader.buildSessionSummary,
  buildLightweightSessionSummary: reader.buildLightweightSessionSummary,
};
