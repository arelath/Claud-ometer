import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter, resolveSessionProvider } from '@/lib/agent-data/registry';
import { sortSessionsByTimestamp } from '@/lib/agent-data/aggregate';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { getIndexedSessionSummariesWithFallbacks } from '@/lib/agent-data/indexer';
import { summariesToSessions, type CachedSessionSummary } from '@/lib/agent-data/session-summary';
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
  const sessions = summariesToSessions(summaries).slice(offset, offset + limit);
  if (!includeTotal) return NextResponse.json(sessions);
  return NextResponse.json({
    sessions,
    total: summaries.length,
    limit,
    offset,
  });
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

  if (query) {
    const summaries = await getIndexedSessionSummariesWithFallbacks(providers);
    const lowerQuery = query.toLowerCase();
    const matchingSummaries = summaries.filter(summary => summarySearchText(summary).includes(lowerQuery));
    return paginatedResponse(matchingSummaries, limit, offset, includeTotal);
  }

  if (projectId) {
    const parsedProjectId = parseRouteId(projectId);
    const projectProviders = parsedProjectId.agentKind
      ? [resolveSessionProvider(projectId)].filter((provider): provider is AgentDataProvider => Boolean(provider))
      : providers;
    const summaries = await getIndexedSessionSummariesWithFallbacks(projectProviders);
    const nativeProjectId = parsedProjectId.nativeId;
    const sessions = sortSessionsByTimestamp(summariesToSessions(summaries.filter(summary => {
      if (parsedProjectId.agentKind && summary.provider !== parsedProjectId.agentKind) return false;
      return summary.nativeProjectId === nativeProjectId || summary.projectRouteId === projectId;
    })));
    return NextResponse.json(sessions);
  }

  const summaries = await getIndexedSessionSummariesWithFallbacks(providers);
  return paginatedResponse(summaries, limit, offset, includeTotal);
}, 'Error fetching sessions', 'Failed to fetch sessions');
