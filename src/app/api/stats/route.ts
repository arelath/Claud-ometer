import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter } from '@/lib/agent-data/registry';
import { mergeDashboardStats } from '@/lib/agent-data/aggregate';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (request: Request) => {
  const agent = new URL(request.url).searchParams.get('agent');
  const providers = getProvidersForFilter(agent);
  if (agent && providers.length === 0) apiError('Invalid provider filter', 400);
  const stats = await Promise.all(providers.map(provider => provider.getDashboardStats()));
  return NextResponse.json(mergeDashboardStats(stats));
}, 'Error fetching stats', 'Failed to fetch stats');
