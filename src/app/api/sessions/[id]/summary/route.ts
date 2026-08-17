import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getSessionSummarySql } from '@/lib/agent-data/analytics-sql';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { resolveSessionProvider } from '@/lib/agent-data/registry';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;
  const parsed = parseRouteId(id);
  const provider = resolveSessionProvider(id);
  if (!provider) apiError('Session not found', 404);

  const summary = getSessionSummarySql([provider], id)
    ?? (parsed.nativeId !== id ? getSessionSummarySql([provider], parsed.nativeId) : null);

  if (!summary) apiError('Session not found', 404);
  return NextResponse.json(summary);
}, 'Error fetching session summary', 'Failed to fetch session summary');
