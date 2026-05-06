import { NextResponse } from 'next/server';
import { getSessionDetail } from '@/lib/claude-data/reader';
import { apiError, withErrorHandler } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> => {
  const { id } = await params;
  const session = await getSessionDetail(id);
  if (!session) {
    apiError('Session not found', 404);
  }
  return NextResponse.json(session);
}, 'Error fetching session', 'Failed to fetch session');
