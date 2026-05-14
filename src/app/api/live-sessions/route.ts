import { NextResponse } from 'next/server';
import { getLiveSessions } from '@/lib/claude-data/live-sessions';
import { withErrorHandler } from '@/lib/api-route';
import { getSelectedAgents } from '@/lib/agent-data/data-source';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (): Promise<Response> => {
  if (!getSelectedAgents().includes('claude')) return NextResponse.json([]);
  return NextResponse.json(getLiveSessions());
}, 'Error fetching live sessions', 'Failed to fetch live sessions');
