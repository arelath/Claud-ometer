import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter } from '@/lib/agent-data/registry';
import { getIndexedSessionSummaries } from '@/lib/agent-data/indexer';
import { summariesToDashboardStats } from '@/lib/agent-data/session-summary';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (request: Request) => {
  const agent = new URL(request.url).searchParams.get('agent');
  const providers = getProvidersForFilter(agent);
  if (agent && providers.length === 0) apiError('Invalid provider filter', 400);
  return NextResponse.json(summariesToDashboardStats(getIndexedSessionSummaries(providers)));
}, 'Error fetching stats', 'Failed to fetch stats');
