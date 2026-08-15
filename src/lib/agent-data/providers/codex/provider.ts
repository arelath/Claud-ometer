import type { AgentDataProvider } from '@/lib/agent-data/provider';
import * as reader from './reader';
import { resetCodexSessionIndexCache } from './session-index';
import { getProviderSessionSummaries } from '@/lib/agent-data/provider-summary-view';
import { summariesToDashboardStats, summariesToProjects, summariesToSessions, type CachedSessionSummary } from '@/lib/agent-data/session-summary';

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

export const codexProvider: AgentDataProvider = {
  kind: 'codex',
  parserVersion: reader.CODEX_SESSION_SUMMARY_PARSER_VERSION,
  canResume: false,
  async getProjects() {
    return summariesToProjects(await getProviderSessionSummaries(codexProvider));
  },
  async getSessions(limit, offset) {
    return summariesToSessions(await getProviderSessionSummaries(codexProvider)).slice(offset || 0, (offset || 0) + (limit || 50));
  },
  async getProjectSessions(projectId) {
    const nativeProjectId = projectId.startsWith('codex:') ? projectId.slice('codex:'.length) : projectId;
    return summariesToSessions((await getProviderSessionSummaries(codexProvider))
      .filter(summary => summary.nativeProjectId === nativeProjectId || summary.projectRouteId === projectId));
  },
  getSessionDetail: reader.getSessionDetail,
  async searchSessions(query, limit) {
    if (!query.trim()) return summariesToSessions(await getProviderSessionSummaries(codexProvider)).slice(0, limit || 50);
    const lowerQuery = query.toLowerCase();
    const summaries = (await getProviderSessionSummaries(codexProvider))
      .filter(summary => summarySearchText(summary).includes(lowerQuery))
      .slice(0, limit || 50);
    return summariesToSessions(summaries);
  },
  async getDashboardStats() {
    return summariesToDashboardStats(await getProviderSessionSummaries(codexProvider));
  },
  discoverSessionSources: reader.discoverSessionSummarySources,
  buildSessionSummary: reader.buildSessionSummary,
  buildLightweightSessionSummary: reader.buildLightweightSessionSummary,
  resetCache() {
    reader.resetCodexReaderCache();
    resetCodexSessionIndexCache();
  },
};
