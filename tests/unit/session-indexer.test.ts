import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDataProvider } from '@/lib/agent-data/provider';

const mocks = vi.hoisted(() => ({
  requestIndexerCommand: vi.fn(async () => ({ runId: 'run-1', state: 'queued' as const })),
  readMetadata: vi.fn(),
  readCache: vi.fn(),
  readSignature: vi.fn(() => 'sqlite:7'),
}));

vi.mock('@/lib/agent-data/indexer-client', () => ({ requestIndexerCommand: mocks.requestIndexerCommand }));
vi.mock('@/lib/agent-data/session-summary-sqlite-store', () => ({
  getSessionSummaryIndexPath: vi.fn(() => 'D:/cache/index.db'),
  getSessionSummaryIndexReadSignature: mocks.readSignature,
  readSessionSummaryIndexCacheForProviders: mocks.readCache,
  readSessionSummaryIndexMetadata: mocks.readMetadata,
}));

function provider(): AgentDataProvider {
  return {
    kind: 'claude',
    parserVersion: 'claude-summary-v2',
    getProjects: vi.fn(),
    getSessions: vi.fn(),
    getProjectSessions: vi.fn(),
    getSessionDetail: vi.fn(),
    searchSessions: vi.fn(),
    getDashboardStats: vi.fn(),
    discoverSessionSources: vi.fn(),
    buildSessionSummary: vi.fn(),
  };
}

describe('session indexer facade', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.readMetadata.mockReturnValue({
      exists: true,
      generatedAt: '2026-08-16T10:00:00.000Z',
      revision: 7,
      summaryCount: 3,
      sourceCount: 3,
      providerVersions: [{ provider: 'claude', parserVersion: 'claude-summary-v2', count: 3 }],
      runtime: {
        state: 'ready',
        queueDepth: 0,
        activeSources: 0,
        pendingSources: 0,
        failedSources: 0,
        initialBuild: false,
      },
    });
    mocks.readCache.mockReturnValue({ cacheVersion: 4, generatedAt: '', summaries: [] });
    const indexer = await import('@/lib/agent-data/indexer');
    indexer.resetSessionIndexerForTests();
  });

  it('reads constant-time metadata without provider discovery or raw parsing', async () => {
    const candidate = provider();
    const { getQuickSessionIndexStatus, getSessionIndexStatus } = await import('@/lib/agent-data/indexer');

    expect(getQuickSessionIndexStatus([candidate])).toMatchObject({
      status: 'fresh',
      state: 'ready',
      revision: 7,
      summaryCount: 3,
    });
    await expect(getSessionIndexStatus([candidate])).resolves.toMatchObject({ revision: 7 });
    expect(candidate.discoverSessionSources).not.toHaveBeenCalled();
    expect(candidate.buildSessionSummary).not.toHaveBeenCalled();
    expect(mocks.readCache).not.toHaveBeenCalled();
  });

  it('coalesces reconciliation requests and sends rebuilds to the sidecar', async () => {
    const candidate = provider();
    const { ensureSessionIndexRefresh, rebuildSessionIndex } = await import('@/lib/agent-data/indexer');

    ensureSessionIndexRefresh([candidate]);
    ensureSessionIndexRefresh([candidate]);
    await vi.waitFor(() => expect(mocks.requestIndexerCommand).toHaveBeenCalledTimes(1));
    expect(mocks.requestIndexerCommand).toHaveBeenCalledWith('reconcile', ['claude']);

    await expect(rebuildSessionIndex([candidate])).resolves.toEqual({ runId: 'run-1', state: 'queued' });
    expect(mocks.requestIndexerCommand).toHaveBeenLastCalledWith('rebuild', ['claude']);
  });

  it('checks the revision signature before hydrating summary payloads', async () => {
    const candidate = provider();
    const { getIndexedSessionSummaries } = await import('@/lib/agent-data/indexer');

    getIndexedSessionSummaries([candidate]);
    getIndexedSessionSummaries([candidate]);

    expect(mocks.readSignature).toHaveBeenCalledTimes(2);
    expect(mocks.readCache).toHaveBeenCalledTimes(1);
  });
});
