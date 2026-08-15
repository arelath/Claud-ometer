import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDataProvider } from '@/lib/agent-data/provider';
import { createSummaryParsePool, type ParseSummaryTask } from '@/lib/agent-data/session-summary-parse-pool';
import { runParseSummaryTask } from '@/lib/agent-data/session-summary-task-runner';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from '@/lib/agent-data/session-summary';
import type { SourceParseCheckpoint } from '@/lib/agent-data/session-parse-checkpoint';

describe('session summary parse pool', () => {
  const filePath = path.join(process.cwd(), '.test-artifacts', 'parse-pool', 'session.jsonl');
  const source: SessionSummarySource = {
    provider: 'claude',
    parserVersion: 'parser-v1',
    sourceFilePath: filePath,
    sourceSignature: { size: 10, mtimeMs: 20 },
    nativeProjectId: 'project',
    projectName: 'Project',
  };

  function summaryFor(sourceValue = source, overrides: Partial<CachedSessionSummary> = {}): CachedSessionSummary {
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      parserVersion: sourceValue.parserVersion,
      provider: sourceValue.provider,
      nativeId: 'session',
      routeId: `${sourceValue.provider}:session`,
      nativeProjectId: 'project',
      projectRouteId: `${sourceValue.provider}:project`,
      projectName: 'Project',
      sourceFilePath: sourceValue.sourceFilePath,
      sourceSignature: sourceValue.sourceSignature,
      createdAt: '2026-05-08T10:00:00.000Z',
      updatedAt: '2026-05-08T10:00:01.000Z',
      cwd: 'D:/repo',
      gitBranch: '',
      version: '',
      model: 'unknown',
      models: [],
      messageCount: 1,
      userMessageCount: 1,
      assistantMessageCount: 0,
      toolCallCount: 0,
      tokenTotals: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      modelUsage: {},
      toolsUsed: {},
      compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
      ...overrides,
    };
  }

  function checkpointFor(sourceValue = source): SourceParseCheckpoint {
    return {
      sourceKey: `${sourceValue.provider}:${sourceValue.sourceFilePath}`,
      provider: sourceValue.provider,
      parserVersion: sourceValue.parserVersion,
      checkpointVersion: 1,
      sourceFilePath: sourceValue.sourceFilePath,
      sourceSize: sourceValue.sourceSignature.size,
      sourceMtimeMs: sourceValue.sourceSignature.mtimeMs,
      lastCompleteOffset: sourceValue.sourceSignature.size,
      recordCount: 1,
      componentStateJson: '{}',
      accumulatorJson: '{}',
      updatedAt: '2026-05-08T10:00:00.000Z',
    };
  }

  function makeProvider(overrides: Partial<AgentDataProvider> = {}): AgentDataProvider {
    return {
      kind: 'claude',
      parserVersion: 'parser-v1',
      getProjects: vi.fn(),
      getSessions: vi.fn(),
      getProjectSessions: vi.fn(),
      getSessionDetail: vi.fn(),
      searchSessions: vi.fn(),
      getDashboardStats: vi.fn(),
      discoverSessionSources: vi.fn(),
      buildSessionSummary: vi.fn(async (sourceValue: SessionSummarySource) => summaryFor(sourceValue)),
      ...overrides,
    };
  }

  it('routes full parse tasks through provider overrides', async () => {
    const provider = makeProvider();
    const pool = createSummaryParsePool([provider], { concurrency: 2 });

    const [result] = await pool.run([{ provider: 'claude', source, mode: 'full' }]);

    expect(provider.buildSessionSummary).toHaveBeenCalledWith(source);
    expect(result).toMatchObject({
      sourceKey: `claude:${filePath}`,
      provider: 'claude',
      mode: 'full',
      summary: { nativeId: 'session' },
    });
  });

  it('returns per-task errors instead of throwing', async () => {
    const provider = makeProvider({
      buildSessionSummary: vi.fn(async () => {
        throw new Error('parse failed');
      }),
    });
    const pool = createSummaryParsePool([provider], { concurrency: 1 });

    const [result] = await pool.run([{ provider: 'claude', source, mode: 'full' }]);

    expect(result.summary).toBeUndefined();
    expect(result.error).toBe('parse failed');
  });

  it('routes incremental parse tasks through provider overrides', async () => {
    const previousSummary = summaryFor(source);
    const checkpoint = checkpointFor(source);
    const nextCheckpoint = { ...checkpoint, recordCount: 2 };
    const incremental = vi.fn(async () => ({
      summary: summaryFor(source, { messageCount: 2 }),
      checkpoint: nextCheckpoint,
    }));
    const provider = makeProvider({
      incrementalSessionSummary: {
        checkpointVersion: 1,
        buildSessionSummary: incremental,
      },
    });
    const pool = createSummaryParsePool([provider], { concurrency: 1 });
    const task: ParseSummaryTask = {
      provider: 'claude',
      source,
      mode: 'incremental',
      previousSummary,
      checkpoint,
    };

    const [result] = await pool.run([task]);

    expect(incremental).toHaveBeenCalledWith(source, previousSummary, checkpoint);
    expect(result).toMatchObject({
      summary: { messageCount: 2 },
      checkpoint: { recordCount: 2 },
    });
  });

  it('deduplicates duplicate tasks while preserving result order', async () => {
    const secondSource: SessionSummarySource = {
      ...source,
      sourceFilePath: path.join(process.cwd(), '.test-artifacts', 'parse-pool', 'second.jsonl'),
      sourceSignature: { size: 30, mtimeMs: 40 },
    };
    const buildSessionSummary = vi.fn(async (sourceValue: SessionSummarySource) => (
      summaryFor(sourceValue, { nativeId: path.basename(sourceValue.sourceFilePath, '.jsonl') })
    ));
    const provider = makeProvider({ buildSessionSummary });
    const pool = createSummaryParsePool([provider], { concurrency: 2 });

    const results = await pool.run([
      { provider: 'claude', source, mode: 'full' },
      { provider: 'claude', source: secondSource, mode: 'full' },
      { provider: 'claude', source, mode: 'full' },
    ]);

    expect(buildSessionSummary).toHaveBeenCalledTimes(2);
    expect(results.map(result => result.summary?.nativeId)).toEqual([
      'session',
      'second',
      'session',
    ]);
    expect(results[0]).toBe(results[2]);
  });

  it('keeps incremental mode opt-in for worker-style static execution', async () => {
    const result = await runParseSummaryTask({
      provider: 'claude',
      source,
      mode: 'incremental',
      previousSummary: summaryFor(source),
      checkpoint: checkpointFor(source),
    });

    expect(result.summary).toBeUndefined();
    expect(result.error).toContain('does not support incremental summaries');
  });
});
