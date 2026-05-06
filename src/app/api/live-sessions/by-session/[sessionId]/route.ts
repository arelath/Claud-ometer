import { NextResponse } from 'next/server';
import { getLiveSessionBySessionId } from '@/lib/claude-data/live-sessions';
import { withErrorHandler } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> => {
  const { sessionId } = await params;
  return NextResponse.json(getLiveSessionBySessionId(sessionId));
}, 'Error fetching live session binding', 'Failed to fetch live session binding');
