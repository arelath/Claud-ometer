import { NextResponse } from 'next/server';
import { getLiveSessionBySessionId } from '@/lib/claude-data/live-sessions';
import { withErrorHandler } from '@/lib/api-route';
import { parseRouteId } from '@/lib/agent-data/route-id';
import { getSelectedAgents } from '@/lib/agent-data/data-source';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> => {
  const { sessionId } = await params;
  const parsed = parseRouteId(sessionId);
  if (parsed.agentKind && parsed.agentKind !== 'claude') return NextResponse.json(null);
  if (!getSelectedAgents().includes('claude')) return NextResponse.json(null);
  return NextResponse.json(getLiveSessionBySessionId(parsed.nativeId));
}, 'Error fetching live session binding', 'Failed to fetch live session binding');
