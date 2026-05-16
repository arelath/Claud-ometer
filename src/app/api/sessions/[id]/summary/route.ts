import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getIndexedSessionSummaries } from '@/lib/agent-data/indexer';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { resolveSessionProvider } from '@/lib/agent-data/registry';
import { summaryToSessionInfo } from '@/lib/agent-data/session-summary';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;
  const parsed = parseRouteId(id);
  const provider = resolveSessionProvider(id);
  if (!provider) apiError('Session not found', 404);

  const summary = getIndexedSessionSummaries([provider]).find(item => (
    item.routeId === id
    || item.nativeId === parsed.nativeId
    || (item.provider === 'claude' && item.nativeId === id)
  ));

  if (!summary) apiError('Session not found', 404);
  return NextResponse.json(summaryToSessionInfo(summary));
}, 'Error fetching session summary', 'Failed to fetch session summary');
