import { NextResponse } from 'next/server';
import { getSessions, getProjectSessions, searchSessions } from '@/lib/claude-data/reader';
import { withErrorHandler } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const query = searchParams.get('q');
  const limit = parseInt(searchParams.get('limit') || '50');
  const offset = parseInt(searchParams.get('offset') || '0');

  if (query) {
    const sessions = await searchSessions(query, limit);
    return NextResponse.json(sessions);
  }

  if (projectId) {
    const sessions = await getProjectSessions(projectId);
    return NextResponse.json(sessions);
  }

  const sessions = await getSessions(limit, offset);
  return NextResponse.json(sessions);
}, 'Error fetching sessions', 'Failed to fetch sessions');
