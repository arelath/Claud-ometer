import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter, resolveSessionProvider } from '@/lib/agent-data/registry';
import { sortSessionsByTimestamp } from '@/lib/agent-data/aggregate';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { getIndexedSessionSummaries } from '@/lib/agent-data/indexer';
import { getProjectSessionsSql, getSessionsSql, type SessionSqlPage } from '@/lib/agent-data/analytics-sql';
import { filterVisibleSessionSummaries, summariesToSessions, type CachedSessionSummary } from '@/lib/agent-data/session-summary';
import { isSummaryInProjectPath, parseProjectPathRouteId } from '@/lib/agent-data/project-path';
import { filterByTimeRange, parseApiTimeRangeParams, type TimeRangeParams } from '@/lib/time-range';
import type { AgentDataProvider } from '@/lib/agent-data/provider';

export const dynamic = 'force-dynamic';

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

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function paginatedResponse(summaries: CachedSessionSummary[], limit: number, offset: number, includeTotal: boolean) {
  const visibleSummaries = filterVisibleSessionSummaries(summaries);
  const sessions = summariesToSessions(visibleSummaries).slice(offset, offset + limit);
  if (!includeTotal) return NextResponse.json(sessions);
  return NextResponse.json({
    sessions,
    total: visibleSummaries.length,
    limit,
    offset,
  });
}

function sqlPaginatedResponse(page: SessionSqlPage, includeTotal: boolean) {
  if (!includeTotal) return NextResponse.json(page.sessions);
  return NextResponse.json({
    sessions: page.sessions,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
  });
}

function getTimeFilteredSummaries(providers: AgentDataProvider[], range: TimeRangeParams): CachedSessionSummary[] {
  return filterByTimeRange(getIndexedSessionSummaries(providers), range, summary => summary.createdAt);
}

export const GET = withErrorHandler(async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const query = searchParams.get('q');
  const agent = searchParams.get('agent');
  const limit = parsePositiveInt(searchParams.get('limit'), 50);
  const offset = parseNonNegativeInt(searchParams.get('offset'), 0);
  const includeTotal = searchParams.get('includeTotal') === '1';
  const providers = getProvidersForFilter(agent);
  if (agent && agent !== 'active' && providers.length === 0) apiError('Invalid provider filter', 400);
  const { range, error } = parseApiTimeRangeParams(searchParams);
  if (error) apiError(error, 400);

  if (query) {
    try {
      const sqlPage = getSessionsSql(providers, { query, range, limit, offset });
      if (sqlPage) return sqlPaginatedResponse(sqlPage, includeTotal);
    } catch {
      // Fall back to the payload cache if the SQLite sessions path is unavailable.
    }

    const summaries = getTimeFilteredSummaries(providers, range);
    const lowerQuery = query.toLowerCase();
    const matchingSummaries = summaries.filter(summary => summarySearchText(summary).includes(lowerQuery));
    return paginatedResponse(matchingSummaries, limit, offset, includeTotal);
  }

  if (projectId) {
    const projectPath = parseProjectPathRouteId(projectId);
    const parsedProjectId = parseRouteId(projectId);
    const projectProviders = !projectPath && parsedProjectId.agentKind
      ? [resolveSessionProvider(projectId)].filter((provider): provider is AgentDataProvider => Boolean(provider))
      : providers;
    const nativeProjectId = parsedProjectId.nativeId;
    try {
      const sqlSessions = getProjectSessionsSql(projectProviders, {
        projectId,
        projectPath: projectPath || undefined,
        nativeProjectId,
        projectAgentKind: projectPath ? undefined : parsedProjectId.agentKind || undefined,
        range,
      });
      if (sqlSessions) return NextResponse.json(sqlSessions);
    } catch {
      // Fall back to the payload cache if the SQLite sessions path is unavailable.
    }

    const summaries = getTimeFilteredSummaries(projectProviders, range);
    const sessions = sortSessionsByTimestamp(summariesToSessions(summaries.filter(summary => {
      if (projectPath) return isSummaryInProjectPath(summary, projectPath);
      if (parsedProjectId.agentKind && summary.provider !== parsedProjectId.agentKind) return false;
      return summary.nativeProjectId === nativeProjectId || summary.projectRouteId === projectId;
    })));
    return NextResponse.json(sessions);
  }

  try {
    const sqlPage = getSessionsSql(providers, { range, limit, offset });
    if (sqlPage) return sqlPaginatedResponse(sqlPage, includeTotal);
  } catch {
    // Fall back to the payload cache if the SQLite sessions path is unavailable.
  }

  const summaries = getTimeFilteredSummaries(providers, range);
  return paginatedResponse(summaries, limit, offset, includeTotal);
}, 'Error fetching sessions', 'Failed to fetch sessions');
