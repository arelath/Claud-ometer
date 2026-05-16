import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import {
  ensureSessionIndexRefresh,
  getIndexedSessionSummaries,
  getSessionIndexStatus,
  resetSessionIndexerForTests,
} from '@/lib/agent-data/indexer';
import {
  clearSessionSummaryCache,
  resetSessionSummaryStoreForTests,
} from '@/lib/agent-data/session-summary-store';
import { writeSessionSummaryCache } from '@/lib/agent-data/session-summary-cache';
import { SESSION_SUMMARY_CACHE_VERSION, type CachedSessionSummary, type SessionSummarySource } from '@/lib/agent-data/session-summary';

describe('session indexer', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'session-indexer');
  const filePath = path.join(root, 'session.jsonl');

  function sourceFor(parserVersion: string): SessionSummarySource {
    const stat = fs.statSync(filePath);
    return {
      provider: 'claude',
      parserVersion,
      sourceFilePath: filePath,
      sourceSignature: { size: stat.size, mtimeMs: stat.mtimeMs },
      nativeProjectId: 'project',
      projectName: 'Project',
    };
  }

  function summaryFor(source: SessionSummarySource): CachedSessionSummary {
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      parserVersion: source.parserVersion,
      provider: source.provider,
      nativeId: 'session',
      routeId: 'claude:session',
      nativeProjectId: 'project',
      projectRouteId: 'claude:project',
      projectName: 'Project',
      sourceFilePath: source.sourceFilePath,
      sourceSignature: source.sourceSignature,
      createdAt: '2026-05-08T10:00:00.000Z',
      updatedAt: '2026-05-08T10:00:01.000Z',
      cwd: 'D:/repo',
      gitBranch: '',
      version: '',
      model: 'unknown',
      models: [],
      messageCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
      tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      modelUsage: {},
      toolsUsed: {},
      compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
    };
  }

  function makeProvider(parserVersion: string, buildSessionSummary: AgentDataProvider['buildSessionSummary']): AgentDataProvider {
    return {
      kind: 'claude',
      parserVersion,
      getProjects: vi.fn(),
      getSessions: vi.fn(),
      getProjectSessions: vi.fn(),
      getSessionDetail: vi.fn(),
      searchSessions: vi.fn(),
      getDashboardStats: vi.fn(),
      discoverSessionSources: vi.fn(async () => [sourceFor(parserVersion)]),
      buildSessionSummary,
    };
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath, 'one');
    process.env.CLAUD_OMETER_CACHE_DIR = root;
    resetSessionIndexerForTests();
    resetSessionSummaryStoreForTests();
  });

  afterEach(() => {
    clearSessionSummaryCache();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.CLAUD_OMETER_CACHE_DIR;
  });

  it('returns stale cache immediately and refreshes only when requested', async () => {
    writeSessionSummaryCache({
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      generatedAt: '2026-05-08T10:00:00.000Z',
      summaries: [summaryFor(sourceFor('parser-v1'))],
    });
    let resolveBuild!: (summary: CachedSessionSummary) => void;
    const buildPromise = new Promise<CachedSessionSummary>(resolve => {
      resolveBuild = resolve;
    });
    const buildSessionSummary = vi.fn(() => buildPromise);
    const provider = makeProvider('parser-v2', buildSessionSummary);

    const fastSummaries = getIndexedSessionSummaries([provider]);

    expect(fastSummaries).toHaveLength(1);
    expect(fastSummaries[0].parserVersion).toBe('parser-v1');
    expect(buildSessionSummary).not.toHaveBeenCalled();

    ensureSessionIndexRefresh([provider]);

    await vi.waitFor(() => expect(buildSessionSummary).toHaveBeenCalledTimes(1));
    await expect(getSessionIndexStatus([provider])).resolves.toMatchObject({ status: 'refreshing', staleCount: 1 });

    resolveBuild(summaryFor(sourceFor('parser-v2')));

    await vi.waitFor(async () => {
      await expect(getSessionIndexStatus([provider])).resolves.toMatchObject({ status: 'fresh', staleCount: 0 });
    });
    expect(getIndexedSessionSummaries([provider])[0].parserVersion).toBe('parser-v2');
  });

  it('deduplicates refreshes and exposes refresh failures', async () => {
    const error = new Error('parse failed');
    const buildSessionSummary = vi.fn(async () => {
      throw error;
    });
    const provider = makeProvider('parser-v1', buildSessionSummary);

    ensureSessionIndexRefresh([provider]);
    ensureSessionIndexRefresh([provider]);

    await vi.waitFor(() => expect(buildSessionSummary).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      await expect(getSessionIndexStatus([provider])).resolves.toMatchObject({
        status: 'error',
        refreshError: 'parse failed',
      });
    });
  });
});
