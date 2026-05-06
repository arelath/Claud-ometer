import { NextResponse } from 'next/server';
import { getLiveSessions } from '@/lib/claude-data/live-sessions';
import { withErrorHandler } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (): Promise<Response> => {
  return NextResponse.json(getLiveSessions());
}, 'Error fetching live sessions', 'Failed to fetch live sessions');
