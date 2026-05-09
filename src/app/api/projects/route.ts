import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import { getProvidersForFilter } from '@/lib/agent-data/registry';
import { sortProjectsByLastActive } from '@/lib/agent-data/aggregate';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (request: Request) => {
  const agent = new URL(request.url).searchParams.get('agent');
  const providers = getProvidersForFilter(agent);
  if (agent && providers.length === 0) apiError('Invalid provider filter', 400);
  const projects = sortProjectsByLastActive((await Promise.all(providers.map(provider => provider.getProjects()))).flat());
  return NextResponse.json(projects);
}, 'Error fetching projects', 'Failed to fetch projects');
