import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = {
  kind: 'claude',
  parserVersion: 'parser-v1',
  discoverSessionSources: vi.fn(),
  buildSessionSummary: vi.fn(),
  resetCache: vi.fn(),
};
const status = {
  cachePath: 'D:/cache/agent-session-summary-v1.json',
  exists: true,
  generatedAt: '2026-05-08T10:00:00.000Z',
  summaryCount: 1,
  activeProviders: ['claude' as const],
  sourceCount: 1,
  validCount: 1,
  staleCount: 0,
  missingCount: 0,
};
const clearedStatus = {
  ...status,
  exists: false,
  summaryCount: 0,
  validCount: 0,
  status: 'empty',
  unindexedCount: 0,
};

vi.mock('@/lib/agent-data/registry', () => ({
  getActiveProviders: vi.fn(() => [provider]),
}));

vi.mock('@/lib/agent-data/session-summary-store', () => ({
  clearSessionSummaryCache: vi.fn(),
}));

vi.mock('@/lib/agent-data/indexer', () => ({
  ensureSessionIndexRefresh: vi.fn(),
  getQuickSessionIndexStatus: vi.fn(() => clearedStatus),
  getSessionIndexStatus: vi.fn(async () => status),
  rebuildSessionIndex: vi.fn(async () => [{ nativeId: 'session-1' }]),
  resetSessionIndexer: vi.fn(),
}));

vi.mock('@/lib/agent-data/analytics', () => ({
  resetAnalyticsMemo: vi.fn(),
}));

describe('cache API route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cache status', async () => {
    const { GET } = await import('@/app/api/cache/route');

    const body = await (await GET()).json();

    expect(body).toMatchObject({ summaryCount: 1, validCount: 1 });
  });

  it('rebuilds and clears the cache', async () => {
    const [{ POST, DELETE }, store, indexer, analytics] = await Promise.all([
      import('@/app/api/cache/route'),
      import('@/lib/agent-data/session-summary-store'),
      import('@/lib/agent-data/indexer'),
      import('@/lib/agent-data/analytics'),
    ]);

    const rebuild = await (await POST()).json();
    const cleared = await (await DELETE()).json();

    expect(indexer.rebuildSessionIndex).toHaveBeenCalledWith([provider]);
    expect(store.clearSessionSummaryCache).toHaveBeenCalled();
    expect(indexer.resetSessionIndexer).toHaveBeenCalledTimes(2);
    expect(analytics.resetAnalyticsMemo).toHaveBeenCalledTimes(2);
    expect(provider.resetCache).toHaveBeenCalledTimes(2);
    expect(rebuild).toMatchObject({ rebuilt: 1 });
    expect(cleared).toMatchObject({ summaryCount: 0 });
  });

  it('quick status schedules stale refreshes without rebuilding inline', async () => {
    const indexer = await import('@/lib/agent-data/indexer');
    vi.mocked(indexer.getQuickSessionIndexStatus)
      .mockReturnValueOnce({ ...clearedStatus, status: 'stale', staleCount: 1 })
      .mockReturnValueOnce({ ...clearedStatus, status: 'refreshing', staleCount: 1 });
    const { GET } = await import('@/app/api/cache/route');

    const body = await (await GET(new Request('http://localhost/api/cache?quick=1'))).json();

    expect(indexer.ensureSessionIndexRefresh).toHaveBeenCalledWith([provider]);
    expect(indexer.rebuildSessionIndex).not.toHaveBeenCalled();
    expect(body).toMatchObject({ status: 'refreshing', staleCount: 1 });
  });
});
