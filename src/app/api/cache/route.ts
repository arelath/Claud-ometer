import { NextResponse } from 'next/server';
import { withErrorHandler } from '@/lib/api-route';
import { getActiveProviders } from '@/lib/agent-data/registry';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import { resetAnalyticsMemo } from '@/lib/agent-data/analytics';
import {
  getQuickSessionIndexStatus,
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
  const providers = getActiveProviders();
  const status = getQuickSessionIndexStatus(providers);
  const etag = `W/"${status.revision}-${status.statusRevision}"`;
  if (request?.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }
  return NextResponse.json(status, { headers: { ETag: etag } });
}, 'Error reading cache status', 'Failed to read cache status');

export const POST = withErrorHandler(async () => {
  const providers = getActiveProviders();
  resetRuntimeCaches(providers);
  const run = await rebuildSessionIndex(providers);
  return NextResponse.json(run, { status: 202 });
}, 'Error rebuilding cache', 'Failed to rebuild cache');

export const DELETE = withErrorHandler(async () => {
  const providers = getActiveProviders();
  resetRuntimeCaches(providers);
  const run = await rebuildSessionIndex(providers);
  return NextResponse.json({ ...run, deprecated: true }, { status: 202 });
}, 'Error clearing cache', 'Failed to clear cache');
