import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter, resolveSessionProvider } from '@/lib/agent-data/registry';
import { sortSessionsByTimestamp } from '@/lib/agent-data/aggregate';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { getIndexedSessionSummaries } from '@/lib/agent-data/indexer';
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

export const GET = withErrorHandler(async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const query = searchParams.get('q');
  const agent = searchParams.get('agent');
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');
  const providers = getProvidersForFilter(agent);
  if (agent && providers.length === 0) apiError('Invalid provider filter', 400);

  if (query) {
    const summaries = getIndexedSessionSummaries(providers);
    const lowerQuery = query.toLowerCase();
    const sessions = summariesToSessions(summaries
      .filter(summary => summarySearchText(summary).includes(lowerQuery)))
      .slice(0, limit);
    return NextResponse.json(sessions);
  }

  if (projectId) {
    const parsedProjectId = parseRouteId(projectId);
    const projectProviders = parsedProjectId.agentKind
      ? [resolveSessionProvider(projectId)].filter((provider): provider is AgentDataProvider => Boolean(provider))
      : providers;
    const summaries = getIndexedSessionSummaries(projectProviders);
    const nativeProjectId = parsedProjectId.nativeId;
    const sessions = sortSessionsByTimestamp(summariesToSessions(summaries.filter(summary => {
      if (parsedProjectId.agentKind && summary.provider !== parsedProjectId.agentKind) return false;
      return summary.nativeProjectId === nativeProjectId || summary.projectRouteId === projectId;
    })));
    return NextResponse.json(sessions);
  }

  const summaries = getIndexedSessionSummaries(providers);
  const sessions = summariesToSessions(summaries).slice(offset, offset + limit);
  return NextResponse.json(sessions);
}, 'Error fetching sessions', 'Failed to fetch sessions');
