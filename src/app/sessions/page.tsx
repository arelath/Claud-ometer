import { Suspense } from 'react';
import { SessionsClient } from '@/components/pages/sessions-client';
import { getActiveProviders } from '@/lib/agent-data/registry';
import { sortSessionsByTimestamp } from '@/lib/agent-data/aggregate';

export default async function SessionsPage({ searchParams }: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = '' } = await searchParams;
  const providers = getActiveProviders();
  const initialSessions = sortSessionsByTimestamp(
    q
      ? (await Promise.all(providers.map(provider => provider.searchSessions(q, 100)))).flat()
      : (await Promise.all(providers.map(provider => provider.getSessions(100, 0)))).flat(),
  ).slice(0, 100);

  return (
    <Suspense fallback={
      <div className="flex h-[80vh] items-center justify-center">
        <div className="space-y-3 text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading sessions...</p>
        </div>
      </div>
    }>
      <SessionsClient initialSessions={initialSessions} initialQuery={q} />
    </Suspense>
  );
}
