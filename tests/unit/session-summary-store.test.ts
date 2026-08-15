import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSqliteAvailable } from '@/lib/sqlite';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import {
  clearSessionSummaryCache,
  getCachedSessionSummaries,
  getLastSessionIndexRefreshMetrics,
  resetSessionSummaryStoreForTests,
} from '@/lib/agent-data/session-summary-store';
import {
  commitSessionSummaryIndex,
  readSourceParseCheckpoints,
} from '@/lib/agent-data/session-summary-sqlite-store';
import { sourceSummaryCacheKey } from '@/lib/agent-data/session-summary-cache';
import { SESSION_SUMMARY_CACHE_VERSION, type CachedSessionSummary, type SessionSummarySource } from '@/lib/agent-data/session-summary';
import type { SourceParseCheckpoint } from '@/lib/agent-data/session-parse-checkpoint';

describe('session summary store', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'session-summary-store');
  const filePath = path.join(root, 'session.jsonl');
  const sqliteIt = isSqliteAvailable() ? it : it.skip;

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
