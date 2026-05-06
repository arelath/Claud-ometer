import { NextResponse } from 'next/server';
import { getDashboardStats } from '@/lib/claude-data/reader';
import { withErrorHandler } from '@/lib/api-route';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async () => {
  const stats = await getDashboardStats();
  return NextResponse.json(stats);
}, 'Error fetching stats', 'Failed to fetch stats');
