import { NextResponse } from 'next/server';
import { apiError, withErrorHandler } from '@/lib/api-route';
import {
  getActiveAgentDataSource,
  hasImportedData,
  setDataSource,
  setSelectedAgents,
} from '@/lib/claude-data/data-source';
import { isAgentKind } from '@/lib/agent-data/types';
import { getActiveProviders } from '@/lib/agent-data/registry';
import { resetAnalyticsMemo } from '@/lib/agent-data/analytics';
import { ensureSessionIndexRefresh, resetSessionIndexer } from '@/lib/agent-data/indexer';

export const dynamic = 'force-dynamic';

function resetRuntimeCaches(): void {
  resetAnalyticsMemo();
  resetSessionIndexer();
  for (const provider of getActiveProviders()) provider.resetCache?.();
}

export async function GET() {
  return NextResponse.json(getActiveAgentDataSource());
}

export const PUT = withErrorHandler(async (request: Request) => {
  const { source, agents } = await request.json();
  if (source !== 'live' && source !== 'imported') {
    apiError('Invalid source', 400);
  }
  if (source === 'imported' && !hasImportedData()) {
    apiError('No imported data available', 400);
  }
  if (agents !== undefined) {
    if (!Array.isArray(agents) || agents.some(agent => !isAgentKind(agent))) {
      apiError('Invalid agents', 400);
    }
    setSelectedAgents(agents);
  }
  setDataSource(source);
  resetRuntimeCaches();
  ensureSessionIndexRefresh(getActiveProviders());
  return NextResponse.json(getActiveAgentDataSource());
}, 'Error switching data source', 'Failed to switch data source');
