import { NextResponse } from 'next/server';
import { getLiveSessionById } from '@/lib/claude-data/live-sessions';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { parseRouteId } from '@/lib/agent-data/route-id';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;
  const parsed = parseRouteId(id);
  if (parsed.agentKind && parsed.agentKind !== 'claude') apiError(`${parsed.agentKind} live sessions are not supported yet.`, 404);
  const session = getLiveSessionById(parsed.nativeId);
  if (!session) apiError('Live session not found', 404);
  return NextResponse.json(session);
}, 'Error fetching live session', 'Failed to fetch live session');
