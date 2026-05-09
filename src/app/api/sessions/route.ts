import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter, resolveSessionProvider } from '@/lib/agent-data/registry';
import { sortSessionsByTimestamp } from '@/lib/agent-data/aggregate';
import { parseRouteId } from '@/lib/agent-data/route-id';

export const dynamic = 'force-dynamic';

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
    const sessions = sortSessionsByTimestamp((await Promise.all(providers.map(provider => provider.searchSessions(query, limit)))).flat()).slice(0, limit);
    return NextResponse.json(sessions);
  }

  if (projectId) {
    const parsedProjectId = parseRouteId(projectId);
    const projectProviders = parsedProjectId.agentKind
      ? [resolveSessionProvider(projectId)].filter(Boolean)
      : providers;
    const sessions = sortSessionsByTimestamp((await Promise.all(projectProviders.map(provider => provider!.getProjectSessions(projectId)))).flat());
    return NextResponse.json(sessions);
  }

  const sessions = sortSessionsByTimestamp((await Promise.all(providers.map(provider => provider.getSessions(limit + offset, 0)))).flat()).slice(offset, offset + limit);
  return NextResponse.json(sessions);
}, 'Error fetching sessions', 'Failed to fetch sessions');
