import { NextResponse } from 'next/server';
import { withErrorHandler } from '@/lib/api-route';
import { getActiveProviders } from '@/lib/agent-data/registry';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import { resetAnalyticsMemo } from '@/lib/agent-data/analytics';
import {
  clearSessionSummaryCache,
} from '@/lib/agent-data/session-summary-store';
import {
  getQuickSessionIndexStatus,
  getSessionIndexStatus,
  rebuildSessionIndex,
  resetSessionIndexer,
} from '@/lib/agent-data/indexer';

export const dynamic = 'force-dynamic';

function resetRuntimeCaches(providers: AgentDataProvider[]): void {
  resetAnalyticsMemo();
  resetSessionIndexer();
  for (const provider of providers) provider.resetCache?.();
}

export const GET = withErrorHandler(async (request?: Request) => {
  const searchParams = request ? new URL(request.url).searchParams : new URLSearchParams();
  const providers = getActiveProviders();
  if (searchParams.get('quick') === '1') {
    return NextResponse.json(await getSessionIndexStatus(providers));
  }
  return NextResponse.json(await getSessionIndexStatus(providers));
}, 'Error reading cache status', 'Failed to read cache status');

export const POST = withErrorHandler(async () => {
  const providers = getActiveProviders();
  resetRuntimeCaches(providers);
  const summaries = await rebuildSessionIndex(providers);
  const status = await getSessionIndexStatus(providers);
  return NextResponse.json({ ...status, rebuilt: summaries.length });
}, 'Error rebuilding cache', 'Failed to rebuild cache');

export const DELETE = withErrorHandler(async () => {
  const providers = getActiveProviders();
  clearSessionSummaryCache();
  resetRuntimeCaches(providers);
  return NextResponse.json(getQuickSessionIndexStatus(providers));
}, 'Error clearing cache', 'Failed to clear cache');
