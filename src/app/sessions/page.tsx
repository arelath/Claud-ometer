import { Suspense } from 'react';
import { SessionsClient } from '@/components/pages/sessions-client';
import { getSessions, searchSessions } from '@/lib/claude-data/reader';

export default async function SessionsPage({ searchParams }: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = '' } = await searchParams;
  const initialSessions = q ? await searchSessions(q, 100) : await getSessions(100, 0);

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
