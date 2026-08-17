import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSqliteAvailable, openDatabase } from '@/lib/sqlite';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import {
  clearSessionSummaryCache,
  boundedIncrementalPreviousSummary,
  getCachedSessionSummaries,
  getLastSessionIndexRefreshMetrics,
  reconcileSessionSummaryIndex,
  resetSessionSummaryStoreForTests,
} from '@/lib/agent-data/session-summary-store';
import {
  commitSessionSummaryIndex,
  getSessionSummaryIndexPath,
  readSessionSummaryIndexSourceState,
  readSourceParseCheckpoints,
  readSessionSummaryIndexCache,
} from '@/lib/agent-data/session-summary-sqlite-store';
import { sourceSummaryCacheKey } from '@/lib/agent-data/session-summary-cache';
import { SESSION_SUMMARY_CACHE_VERSION, type CachedSessionSummary, type SessionSummarySource } from '@/lib/agent-data/session-summary';
import type { SourceParseCheckpoint } from '@/lib/agent-data/session-parse-checkpoint';
import { SessionSummaryDeferredError } from '@/lib/agent-data/session-summary-deferred';

describe('session summary store', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'session-summary-store');
  const filePath = path.join(root, 'session.jsonl');
  const sqliteIt = isSqliteAvailable() ? it : it.skip;

  it('bounds the previous summary sent to incremental workers independently of event history', () => {
    const source = {
      provider: 'claude' as const,
      parserVersion: 'parser-v1',
      sourceFilePath: 'session.jsonl',
      sourceSignature: { size: 10, mtimeMs: 20 },
      nativeProjectId: 'project',
      projectName: 'Project',
    };
    const baseline = summaryFor(source);
    const withHistory = {
      ...baseline,
      usageEvents: Array.from({ length: 10_000 }, () => ({
        timestamp: baseline.updatedAt,
        messageCount: 1,
        userMessageCount: 1,
        assistantMessageCount: 0,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
      })),
    } satisfies CachedSessionSummary;

    const bounded = boundedIncrementalPreviousSummary(withHistory);

    expect(bounded.usageEvents).toBeUndefined();
    expect(bounded.changeEvents).toBeUndefined();
    expect(JSON.stringify(bounded).length).toBeLessThan(2_000);
  });

  function sourceFor(file: string, parserVersion = 'parser-v1'): SessionSummarySource {
    const stat = fs.statSync(file);
    return {
      provider: 'claude',
      parserVersion,
      sourceFilePath: file,
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
      nativeId: path.basename(source.sourceFilePath, '.jsonl'),
      routeId: `claude:${path.basename(source.sourceFilePath, '.jsonl')}`,
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

  function makeProvider(parserVersion = 'parser-v1') {
    const buildSessionSummary = vi.fn(async (source: SessionSummarySource) => summaryFor(source));
    const provider: AgentDataProvider = {
      kind: 'claude',
      parserVersion,
      getProjects: vi.fn(),
      getSessions: vi.fn(),
      getProjectSessions: vi.fn(),
      getSessionDetail: vi.fn(),
      searchSessions: vi.fn(),
      getDashboardStats: vi.fn(),
      discoverSessionSources: vi.fn(async () => [sourceFor(filePath, parserVersion)]),
      buildSessionSummary,
    };
    return { provider, buildSessionSummary };
  }

  function checkpointFor(source: SessionSummarySource, overrides: Partial<SourceParseCheckpoint> = {}): SourceParseCheckpoint {
    return {
      sourceKey: sourceSummaryCacheKey(source),
      provider: source.provider,
      parserVersion: source.parserVersion,
      checkpointVersion: 1,
      sourceFilePath: source.sourceFilePath,
      sourceSize: source.sourceSignature.size,
      sourceMtimeMs: source.sourceSignature.mtimeMs,
      lastCompleteOffset: source.sourceSignature.size,
      recordCount: 1,
      componentStateJson: '{}',
      accumulatorJson: '{}',
      updatedAt: '2026-05-08T10:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(filePath, 'one');
    process.env.AGENT_SCOPE_CACHE_DIR = root;
    resetSessionSummaryStoreForTests();
  });

  afterEach(() => {
    clearSessionSummaryCache();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AGENT_SCOPE_CACHE_DIR;
  });

  it('parses once and reuses memory cache for unchanged sources', async () => {
    const { provider, buildSessionSummary } = makeProvider();

    await expect(getCachedSessionSummaries([provider])).resolves.toHaveLength(1);
    await expect(getCachedSessionSummaries([provider])).resolves.toHaveLength(1);

    expect(buildSessionSummary).toHaveBeenCalledTimes(1);
  });

  it('reuses persistent cache after memory reset', async () => {
    const first = makeProvider();
    await getCachedSessionSummaries([first.provider]);
    resetSessionSummaryStoreForTests();

    const second = makeProvider();
    await expect(getCachedSessionSummaries([second.provider])).resolves.toHaveLength(1);

    expect(second.buildSessionSummary).not.toHaveBeenCalled();
  });

  it('rebuilds only when the source signature changes', async () => {
    const first = makeProvider();
    await getCachedSessionSummaries([first.provider]);
    fs.appendFileSync(filePath, 'two');
    resetSessionSummaryStoreForTests();

    const second = makeProvider();
    await getCachedSessionSummaries([second.provider]);

    expect(second.buildSessionSummary).toHaveBeenCalledTimes(1);
  });

  it('shares concurrent in-flight rebuilds', async () => {
    const { provider, buildSessionSummary } = makeProvider();

    await Promise.all([
      getCachedSessionSummaries([provider]),
      getCachedSessionSummaries([provider]),
    ]);

    expect(buildSessionSummary).toHaveBeenCalledTimes(1);
  });

  it('deduplicates duplicate discovered sources before building summaries', async () => {
    const stableDate = new Date('2026-05-08T10:00:00.000Z');
    fs.utimesSync(filePath, stableDate, stableDate);
    const buildSessionSummary = vi.fn(async (source: SessionSummarySource) => summaryFor(source));
    const provider: AgentDataProvider = {
      ...makeProvider().provider,
      discoverSessionSources: vi.fn(async () => [
        sourceFor(filePath),
        sourceFor(filePath),
      ]),
      buildSessionSummary,
    };

    const summaries = await getCachedSessionSummaries([provider]);

    expect(summaries).toHaveLength(1);
    expect(buildSessionSummary).toHaveBeenCalledTimes(1);
    expect(getLastSessionIndexRefreshMetrics()).toMatchObject({
      sourceCount: 1,
      fullBuildCount: 1,
    });
  });

  sqliteIt('publishes each source before parsing the next source', async () => {
    const secondFilePath = path.join(root, 'zz-second.jsonl');
    fs.writeFileSync(secondFilePath, 'two');
    const stableDate = new Date('2026-05-08T10:00:00.000Z');
    fs.utimesSync(filePath, stableDate, stableDate);
    fs.utimesSync(secondFilePath, stableDate, stableDate);
    const sources = [sourceFor(filePath), sourceFor(secondFilePath)];
    const buildSessionSummary = vi.fn(async (source: SessionSummarySource) => {
      if (source.sourceFilePath === secondFilePath) {
        expect(readSessionSummaryIndexCache().summaries.map(summary => summary.sourceFilePath)).toContain(filePath);
      }
      return summaryFor(source);
    });
    const provider: AgentDataProvider = {
      ...makeProvider().provider,
      discoverSessionSources: vi.fn(async () => sources),
      buildSessionSummary,
    };

    const result = await reconcileSessionSummaryIndex([provider]);

    expect(buildSessionSummary).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ processedSources: 2, committedSources: 2, failedSources: 0 });
    expect(readSessionSummaryIndexCache().summaries).toHaveLength(2);
  });

  sqliteIt('isolates a source publication failure and continues the provider', async () => {
    const secondFilePath = path.join(root, 'zz-second.jsonl');
    fs.writeFileSync(secondFilePath, 'two');
    const stableDate = new Date('2026-05-08T10:00:00.000Z');
    fs.utimesSync(filePath, stableDate, stableDate);
    fs.utimesSync(secondFilePath, stableDate, stableDate);
    const sources = [sourceFor(filePath), sourceFor(secondFilePath)];
    const provider: AgentDataProvider = {
      ...makeProvider().provider,
      discoverSessionSources: vi.fn(async () => sources),
      buildSessionSummary: vi.fn(async source => ({
        ...summaryFor(source),
        routeId: 'claude:duplicate-route',
      })),
    };

    const result = await reconcileSessionSummaryIndex([provider]);

    expect(result).toMatchObject({ processedSources: 2, committedSources: 1, failedSources: 1 });
    expect(readSessionSummaryIndexCache().summaries).toHaveLength(1);
    const db = openDatabase(getSessionSummaryIndexPath());
    try {
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_sessions WHERE job_state = 'failed'")?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  sqliteIt('completes durable provider state when a manifest is memoized', async () => {
    const stableDate = new Date('2026-05-08T10:00:00.000Z');
    fs.utimesSync(filePath, stableDate, stableDate);
    const { provider } = makeProvider();
    await reconcileSessionSummaryIndex([provider]);

    await reconcileSessionSummaryIndex([provider]);

    const db = openDatabase(getSessionSummaryIndexPath());
    try {
      expect(db.get<{ state: string }>(
        'SELECT state FROM provider_reconciliations WHERE provider = ?',
        ['claude'],
      )?.state).toBe('complete');
    } finally {
      db.close();
    }
  });

  sqliteIt('keeps failed manifests degraded and retries after backoff', async () => {
    const stableDate = new Date('2026-05-08T10:00:00.000Z');
    fs.utimesSync(filePath, stableDate, stableDate);
    let nowMs = new Date('2026-05-08T12:00:00.000Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const buildSessionSummary = vi.fn(async () => {
      throw new Error('transient parse failure');
    });
    const provider: AgentDataProvider = {
      ...makeProvider().provider,
      buildSessionSummary,
    };

    try {
      await expect(reconcileSessionSummaryIndex([provider])).resolves.toMatchObject({
        failedSources: 1,
        lastError: 'transient parse failure',
      });
      resetSessionSummaryStoreForTests();
      await expect(reconcileSessionSummaryIndex([provider])).resolves.toMatchObject({
        failedSources: 1,
        lastError: 'transient parse failure',
      });
      expect(buildSessionSummary).toHaveBeenCalledTimes(1);

      nowMs += 31_000;
      await expect(reconcileSessionSummaryIndex([provider])).resolves.toMatchObject({ failedSources: 1 });
      expect(buildSessionSummary).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  sqliteIt('keeps an unterminated active bootstrap pending without retry backoff', async () => {
    let complete = false;
    let nowMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const buildSessionSummaryWithCheckpoint = vi.fn(async (source: SessionSummarySource) => {
      if (!complete) throw new SessionSummaryDeferredError('unterminated JSONL record');
      return { summary: summaryFor(source), checkpoint: checkpointFor(source) };
    });
    const provider: AgentDataProvider = {
      ...makeProvider().provider,
      discoverSessionSources: vi.fn(async () => [sourceFor(filePath)]),
      buildSessionSummaryWithCheckpoint,
      incrementalSessionSummary: {
        checkpointVersion: 1,
        buildRecentAsFull: true,
        buildSessionSummary: vi.fn(),
      },
    };

    try {
      const initialSource = sourceFor(filePath);
      const result = await reconcileSessionSummaryIndex([provider]);
      const state = readSessionSummaryIndexSourceState(initialSource);

      expect(buildSessionSummaryWithCheckpoint).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ processedSources: 1, committedSources: 0, failedSources: 0, deferredSources: 1 });
      expect(result.lastError).toBeUndefined();
      expect(state).toMatchObject({ jobState: 'pending' });
      expect(state.retryAfter).toBeUndefined();
      expect(state.lastError).toBeUndefined();

      fs.appendFileSync(filePath, '\n');
      complete = true;
      nowMs += 1_001;
      await expect(reconcileSessionSummaryIndex([provider])).resolves.toMatchObject({
        committedSources: 1,
        failedSources: 0,
        deferredSources: 0,
      });
      expect(buildSessionSummaryWithCheckpoint).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('records refresh metrics for index builds', async () => {
    const { provider } = makeProvider();

    await getCachedSessionSummaries([provider]);

    expect(getLastSessionIndexRefreshMetrics()).toMatchObject({
      providers: ['claude'],
      sourceCount: 1,
      recentCount: 1,
      failedBuildCount: 0,
      workerMode: 'inline',
    });
    expect(getLastSessionIndexRefreshMetrics()?.workerPoolSize).toBeGreaterThan(0);
  });

  sqliteIt('reads persisted refresh metrics after memory reset', async () => {
    const { provider } = makeProvider();

    await getCachedSessionSummaries([provider]);
    const runId = getLastSessionIndexRefreshMetrics()?.runId;
    resetSessionSummaryStoreForTests();

    expect(getLastSessionIndexRefreshMetrics()).toMatchObject({
      runId,
      providers: ['claude'],
      sourceCount: 1,
      workerMode: 'inline',
    });
  });

  it('keeps a previous summary when a stale full build fails', async () => {
    const stableDate = new Date('2026-05-08T10:00:00.000Z');
    fs.utimesSync(filePath, stableDate, stableDate);
    const first = makeProvider();
    const previous = await getCachedSessionSummaries([first.provider]);

    fs.appendFileSync(filePath, 'two');
    fs.utimesSync(filePath, new Date('2026-05-08T11:00:00.000Z'), new Date('2026-05-08T11:00:00.000Z'));
    resetSessionSummaryStoreForTests();
    const buildSessionSummary = vi.fn(async () => {
      throw new Error('parse failed');
    });
    const provider: AgentDataProvider = {
      ...makeProvider().provider,
      buildSessionSummary,
    };

    await expect(getCachedSessionSummaries([provider])).resolves.toEqual(previous);
    expect(buildSessionSummary).toHaveBeenCalledTimes(1);
    expect(getLastSessionIndexRefreshMetrics()).toMatchObject({
      fullBuildCount: 1,
      failedBuildCount: 1,
    });
  });

  sqliteIt('uses an eligible checkpoint for incremental summary builds', async () => {
    const stableDate = new Date('2026-05-08T10:00:00.000Z');
    fs.utimesSync(filePath, stableDate, stableDate);
    const previousSource = sourceFor(filePath);
    const previousSummary = summaryFor(previousSource);
    const previousCheckpoint = checkpointFor(previousSource);

    commitSessionSummaryIndex({
      touchedProviders: ['claude'],
      discoveredSources: [previousSource],
      updatedSummaries: [previousSummary],
      updatedCheckpoints: [previousCheckpoint],
    });

    fs.appendFileSync(filePath, 'two');
    fs.utimesSync(filePath, new Date('2026-05-08T11:00:00.000Z'), new Date('2026-05-08T11:00:00.000Z'));
    const incrementalBuild = vi.fn(async (
      source: SessionSummarySource,
      previous: CachedSessionSummary,
      checkpoint: SourceParseCheckpoint,
    ) => {
      const summary = {
        ...summaryFor(source),
        messageCount: previous.messageCount + 1,
      };
      return {
        summary,
        checkpoint: {
          ...checkpoint,
          sourceSize: source.sourceSignature.size,
          sourceMtimeMs: source.sourceSignature.mtimeMs,
          lastCompleteOffset: source.sourceSignature.size,
          recordCount: checkpoint.recordCount + 1,
          updatedAt: '2026-05-08T11:00:00.000Z',
        },
      };
    });
    const fullBuild = vi.fn(async (source: SessionSummarySource) => summaryFor(source));
    const provider: AgentDataProvider = {
      ...makeProvider().provider,
      buildSessionSummary: fullBuild,
      incrementalSessionSummary: {
        checkpointVersion: 1,
        buildSessionSummary: incrementalBuild,
      },
    };

    await expect(getCachedSessionSummaries([provider])).resolves.toMatchObject([{ messageCount: 1 }]);

    const sourceKey = sourceSummaryCacheKey(sourceFor(filePath));
    expect(incrementalBuild).toHaveBeenCalledTimes(1);
    expect(fullBuild).not.toHaveBeenCalled();
    expect(readSourceParseCheckpoints([sourceFor(filePath)]).get(sourceKey)).toMatchObject({
      sourceSize: fs.statSync(filePath).size,
      recordCount: 2,
    });
    expect(getLastSessionIndexRefreshMetrics()).toMatchObject({
      incrementalBuildCount: 1,
      failedBuildCount: 0,
    });
  });
});
