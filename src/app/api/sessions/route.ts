import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter, resolveSessionProvider } from '@/lib/agent-data/registry';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { getProjectSessionsSql, getSessionsSql, type SessionSqlPage } from '@/lib/agent-data/analytics-sql';
import { parseProjectPathRouteId } from '@/lib/agent-data/project-path';
import { parseApiTimeRangeParams } from '@/lib/time-range';
import type { AgentDataProvider } from '@/lib/agent-data/provider';

export const dynamic = 'force-dynamic';

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function paginatedResponse(page: SessionSqlPage, includeTotal: boolean) {
  if (!includeTotal) return NextResponse.json(page.sessions);
  return NextResponse.json({ sessions: page.sessions, total: page.total, limit: page.limit, offset: page.offset });
}

export const GET = withErrorHandler(async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const query = searchParams.get('q') || undefined;
  const agent = searchParams.get('agent');
  const limit = parsePositiveInt(searchParams.get('limit'), 50);
  const offset = parseNonNegativeInt(searchParams.get('offset'), 0);
  const includeTotal = searchParams.get('includeTotal') === '1';
  const providers = getProvidersForFilter(agent);
  if (agent && agent !== 'active' && providers.length === 0) apiError('Invalid provider filter', 400);
  const { range, error } = parseApiTimeRangeParams(searchParams);
  if (error) apiError(error, 400);

  if (projectId) {
    const projectPath = parseProjectPathRouteId(projectId);
    const parsedProjectId = parseRouteId(projectId);
    const projectProviders = !projectPath && parsedProjectId.agentKind
      ? [resolveSessionProvider(projectId)].filter((provider): provider is AgentDataProvider => Boolean(provider))
      : providers;
    const sessions = getProjectSessionsSql(projectProviders, {
      projectId,
      projectPath: projectPath || undefined,
      nativeProjectId: parsedProjectId.nativeId,
      projectAgentKind: projectPath ? undefined : parsedProjectId.agentKind || undefined,
      range,
    }) || [];
    return NextResponse.json(sessions);
  }

  const page = getSessionsSql(providers, { query, range, limit, offset }) || { sessions: [], total: 0, limit, offset };
  return paginatedResponse(page, includeTotal);
}, 'Error fetching sessions', 'Failed to fetch sessions');
