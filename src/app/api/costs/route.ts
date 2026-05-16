import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter } from '@/lib/agent-data/registry';
import { getCachedCostAnalytics } from '@/lib/agent-data/analytics';
import { parseApiTimeRangeParams } from '@/lib/time-range';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const agent = searchParams.get('agent');
  const providers = getProvidersForFilter(agent);
  if (agent && agent !== 'active' && providers.length === 0) apiError('Invalid provider filter', 400);
  const { range, error } = parseApiTimeRangeParams(searchParams);
  if (error) apiError(error, 400);

  return NextResponse.json(getCachedCostAnalytics(providers, range));
}, 'Error fetching cost analytics', 'Failed to fetch cost analytics');
