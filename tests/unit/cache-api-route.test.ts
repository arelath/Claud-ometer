import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = { kind: 'claude', parserVersion: 'parser-v1', resetCache: vi.fn() };
const status = {
  cachePath: 'D:/cache/agentscope-session-index-v2.db',
  exists: true,
  generatedAt: '2026-05-08T10:00:00.000Z',
  summaryCount: 1,
  activeProviders: ['claude' as const],
  sourceCount: 1,
  validCount: 1,
  staleCount: 0,
  missingCount: 0,
  status: 'fresh' as const,
  state: 'ready' as const,
  revision: 7,
  statusRevision: 3,
  queueDepth: 0,
  activeSources: 0,
  pendingSources: 0,
  failedSources: 0,
  initialBuild: false,
  unindexedCount: 0,
};

vi.mock('@/lib/agent-data/registry', () => ({ getActiveProviders: vi.fn(() => [provider]) }));
vi.mock('@/lib/agent-data/indexer', () => ({
  getQuickSessionIndexStatus: vi.fn(() => status),
  rebuildSessionIndex: vi.fn(async () => ({ runId: 'run-1', state: 'queued' })),
  resetSessionIndexer: vi.fn(),
}));
vi.mock('@/lib/agent-data/analytics', () => ({ resetAnalyticsMemo: vi.fn() }));

describe('cache API route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns constant-time metadata status with the revision ETag', async () => {
    const indexer = await import('@/lib/agent-data/indexer');
    const { GET } = await import('@/app/api/cache/route');
    const response = await GET(new Request('http://localhost/api/cache?quick=1'));

    expect(response.headers.get('etag')).toBe('W/"7-3"');
    await expect(response.json()).resolves.toMatchObject({ revision: 7, status: 'fresh' });
    expect(indexer.getQuickSessionIndexStatus).toHaveBeenCalledWith([provider]);
  });

  it('returns 304 when the committed and status revisions are unchanged', async () => {
    const { GET } = await import('@/app/api/cache/route');
    const response = await GET(new Request('http://localhost/api/cache?quick=1', {
      headers: { 'If-None-Match': 'W/"7-3"' },
    }));

    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('W/"7-3"');
  });

  it('schedules rebuilds without deleting published data or waiting for completion', async () => {
    const [{ POST, DELETE }, indexer] = await Promise.all([
      import('@/app/api/cache/route'),
      import('@/lib/agent-data/indexer'),
    ]);

    const rebuild = await POST();
    const deprecatedClear = await DELETE();

    expect(rebuild.status).toBe(202);
    expect(deprecatedClear.status).toBe(202);
    await expect(rebuild.json()).resolves.toEqual({ runId: 'run-1', state: 'queued' });
    await expect(deprecatedClear.json()).resolves.toMatchObject({ runId: 'run-1', deprecated: true });
    expect(indexer.rebuildSessionIndex).toHaveBeenCalledTimes(2);
  });
});
