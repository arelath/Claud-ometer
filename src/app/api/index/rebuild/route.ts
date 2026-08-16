import { NextResponse } from 'next/server';
import { withErrorHandler } from '@/lib/api-route';
import { getActiveProviders } from '@/lib/agent-data/registry';
import { rebuildSessionIndex } from '@/lib/agent-data/indexer';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandler(async () => {
  const run = await rebuildSessionIndex(getActiveProviders());
  return NextResponse.json(run, { status: 202 });
}, 'Error scheduling index rebuild', 'Failed to schedule index rebuild');
