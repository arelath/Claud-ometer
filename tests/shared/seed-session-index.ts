import { SESSION_SUMMARY_CACHE_VERSION } from '@/lib/agent-data/session-summary';

/**
 * Test-only equivalent of a completed sidecar commit.  Request handlers must
 * never call the raw providers to populate this; tests seed the committed
 * SQLite snapshot explicitly so route assertions exercise read-only paths.
 */
export async function seedSessionSummaryIndex(): Promise<void> {
  const [{ getActiveProviders }, { writeSessionSummaryIndexCache }] = await Promise.all([
    import('@/lib/agent-data/registry'),
    import('@/lib/agent-data/session-summary-sqlite-store'),
  ]);
  const summaries = [];
  for (const provider of getActiveProviders()) {
    if (!provider.discoverSessionSources || !provider.buildSessionSummary) continue;
    const sources = await provider.discoverSessionSources();
    for (const source of sources) summaries.push(await provider.buildSessionSummary(source));
  }
  writeSessionSummaryIndexCache({
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    summaries,
  });
}
