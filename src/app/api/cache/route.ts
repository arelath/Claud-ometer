import { NextResponse } from 'next/server';
import { withErrorHandler } from '@/lib/api-route';
import { getActiveProviders } from '@/lib/agent-data/registry';
import {
  clearSessionSummaryCache,
  getSessionSummaryCacheStatus,
  rebuildCachedSessionSummaries,
} from '@/lib/agent-data/session-summary-store';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async () => {
  return NextResponse.json(await getSessionSummaryCacheStatus(getActiveProviders()));
}, 'Error reading cache status', 'Failed to read cache status');

export const POST = withErrorHandler(async () => {
  const providers = getActiveProviders();
  const summaries = await rebuildCachedSessionSummaries(providers);
  const status = await getSessionSummaryCacheStatus(providers);
  return NextResponse.json({ ...status, rebuilt: summaries.length });
}, 'Error rebuilding cache', 'Failed to rebuild cache');

export const DELETE = withErrorHandler(async () => {
  clearSessionSummaryCache();
  return NextResponse.json(await getSessionSummaryCacheStatus(getActiveProviders()));
}, 'Error clearing cache', 'Failed to clear cache');
