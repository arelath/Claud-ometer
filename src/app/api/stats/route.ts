import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter } from '@/lib/agent-data/registry';
import { getIndexedSessionSummaries } from '@/lib/agent-data/indexer';
import { summariesToDashboardStats } from '@/lib/agent-data/session-summary';
import { filterByTimeRange, parseApiTimeRangeParams } from '@/lib/time-range';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const agent = searchParams.get('agent');
  const providers = getProvidersForFilter(agent);
  if (agent && agent !== 'active' && providers.length === 0) apiError('Invalid provider filter', 400);
  const { range, error } = parseApiTimeRangeParams(searchParams);
  if (error) apiError(error, 400);
  const summaries = filterByTimeRange(getIndexedSessionSummaries(providers), range, summary => summary.createdAt);
  return NextResponse.json(summariesToDashboardStats(summaries));
}, 'Error fetching stats', 'Failed to fetch stats');
