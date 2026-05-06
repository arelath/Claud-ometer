import { NextResponse } from 'next/server';
import { withErrorHandler } from '@/lib/api-route';
import { getManagedClaudeSession } from '@/lib/claude-data/managed-pty';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;
  return NextResponse.json(getManagedClaudeSession(id));
}, 'Error fetching managed terminal output', 'Failed to fetch managed terminal output');
