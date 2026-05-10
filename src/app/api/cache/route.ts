import { NextResponse } from 'next/server';
import { withErrorHandler } from '@/lib/api-route';
import { getActiveProviders } from '@/lib/agent-data/registry';
import {
  clearSessionSummaryCache,
} from '@/lib/agent-data/session-summary-store';
import { getSessionIndexStatus, rebuildSessionIndex } from '@/lib/agent-data/indexer';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandler(async () => {
  return NextResponse.json(await getSessionIndexStatus(getActiveProviders()));
}, 'Error reading cache status', 'Failed to read cache status');

export const POST = withErrorHandler(async () => {
  const providers = getActiveProviders();
  const summaries = await rebuildSessionIndex(providers);
  const status = await getSessionIndexStatus(providers);
  return NextResponse.json({ ...status, rebuilt: summaries.length });
}, 'Error rebuilding cache', 'Failed to rebuild cache');

export const DELETE = withErrorHandler(async () => {
  clearSessionSummaryCache();
  return NextResponse.json(await getSessionIndexStatus(getActiveProviders()));
}, 'Error clearing cache', 'Failed to clear cache');
