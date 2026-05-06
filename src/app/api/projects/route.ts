import { NextResponse } from 'next/server';
import { getProjects } from '@/lib/claude-data/reader';
import { withErrorHandler } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async () => {
  const projects = await getProjects();
  return NextResponse.json(projects);
}, 'Error fetching projects', 'Failed to fetch projects');
