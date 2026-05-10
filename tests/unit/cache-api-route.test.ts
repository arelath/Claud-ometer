import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = {
  kind: 'claude',
  parserVersion: 'parser-v1',
  discoverSessionSources: vi.fn(),
  buildSessionSummary: vi.fn(),
};
const status = {
  cachePath: 'D:/cache/agent-session-summary-v1.json',
  exists: true,
  generatedAt: '2026-05-08T10:00:00.000Z',
  summaryCount: 1,
  activeProviders: ['claude'],
  sourceCount: 1,
  validCount: 1,
  staleCount: 0,
  missingCount: 0,
};

vi.mock('@/lib/agent-data/registry', () => ({
  getActiveProviders: vi.fn(() => [provider]),
}));

vi.mock('@/lib/agent-data/session-summary-store', () => ({
  clearSessionSummaryCache: vi.fn(),
  getSessionSummaryCacheStatus: vi.fn(async () => status),
  rebuildCachedSessionSummaries: vi.fn(async () => [{ nativeId: 'session-1' }]),
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
    const [{ POST, DELETE }, store] = await Promise.all([
      import('@/app/api/cache/route'),
      import('@/lib/agent-data/session-summary-store'),
    ]);

    const rebuild = await (await POST()).json();
    const cleared = await (await DELETE()).json();

    expect(store.rebuildCachedSessionSummaries).toHaveBeenCalledWith([provider]);
    expect(store.clearSessionSummaryCache).toHaveBeenCalled();
    expect(rebuild).toMatchObject({ rebuilt: 1 });
    expect(cleared).toMatchObject({ summaryCount: 1 });
  });
});
