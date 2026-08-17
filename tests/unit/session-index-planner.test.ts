import path from 'path';
import { describe, expect, it } from 'vitest';
import { createSessionRefreshPlan } from '@/lib/agent-data/session-index-planner';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from '@/lib/agent-data/session-summary';
import type { SourceParseCheckpoint } from '@/lib/agent-data/session-parse-checkpoint';

describe('session index planner', () => {
  const root = path.join(process.cwd(), '.test-artifacts', 'session-index-planner');
  const oldNow = new Date('2026-05-08T10:00:00.000Z').getTime();

  function source(name: string, overrides: Partial<SessionSummarySource> = {}): SessionSummarySource {
    return {
      provider: 'claude',
      parserVersion: 'parser-v1',
      sourceFilePath: path.join(root, `${name}.jsonl`),
      sourceSignature: { size: 10, mtimeMs: oldNow - 60 * 60 * 1000 },
      nativeProjectId: 'project',
      projectName: 'Project',
      ...overrides,
    };
  }

  function summaryFor(sourceValue: SessionSummarySource, overrides: Partial<CachedSessionSummary> = {}): CachedSessionSummary {
    return {
      cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
      parserVersion: sourceValue.parserVersion,
      provider: sourceValue.provider,
      nativeId: path.basename(sourceValue.sourceFilePath, '.jsonl'),
      routeId: `${sourceValue.provider}:${path.basename(sourceValue.sourceFilePath, '.jsonl')}`,
      nativeProjectId: sourceValue.nativeProjectId || 'project',
      projectRouteId: `${sourceValue.provider}:${sourceValue.nativeProjectId || 'project'}`,
      projectName: sourceValue.projectName || 'Project',
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

  function checkpointFor(
    sourceValue: SessionSummarySource,
    overrides: Partial<SourceParseCheckpoint> = {},
  ): SourceParseCheckpoint {
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
      ...overrides,
    };
  }

  it('classifies valid, stale, recent, and missing cached sources', () => {
    const valid = source('valid');
    const stale = source('stale', { sourceSignature: { size: 20, mtimeMs: oldNow - 60 * 60 * 1000 } });
    const recent = source('recent', { sourceSignature: { size: 30, mtimeMs: oldNow - 5 * 60 * 1000 } });
    const deleted = source('deleted');

    const plan = createSessionRefreshPlan({
      sources: [valid, stale, recent],
      cachedSummaries: [
        summaryFor(valid),
        summaryFor(stale, { sourceSignature: { size: 10, mtimeMs: oldNow - 60 * 60 * 1000 } }),
        summaryFor(deleted),
      ],
      touchedProviders: ['claude'],
      nowMs: oldNow,
    });

    expect(plan.valid.map(item => path.basename(item.sourceFilePath))).toEqual(['valid.jsonl']);
    expect(plan.fullBuild.map(item => path.basename(item.sourceFilePath))).toEqual(['stale.jsonl']);
    expect(plan.recent.map(item => path.basename(item.sourceFilePath))).toEqual(['recent.jsonl']);
    expect(plan.incrementalBuild).toEqual([]);
    expect(plan.missingCachedKeys).toEqual([`claude:${deleted.sourceFilePath}`]);
  });

  it('forces stable sources to rebuild without changing recent-source handling', () => {
    const stable = source('stable');
    const recent = source('recent', { sourceSignature: { size: 30, mtimeMs: oldNow - 5 * 60 * 1000 } });

    const plan = createSessionRefreshPlan({
      sources: [stable, recent],
      cachedSummaries: [summaryFor(stable), summaryFor(recent)],
      touchedProviders: ['claude'],
      force: true,
      nowMs: oldNow,
    });

    expect(plan.valid).toEqual([]);
    expect(plan.fullBuild.map(item => path.basename(item.sourceFilePath))).toEqual(['stable.jsonl']);
    expect(plan.recent.map(item => path.basename(item.sourceFilePath))).toEqual(['recent.jsonl']);
  });

  it('routes stale append-only sources to incremental builds when checkpoints are valid', () => {
    const appended = source('appended', {
      sourceSignature: { size: 20, mtimeMs: oldNow - 60 * 60 * 1000 },
    });
    const previousSignature = { size: 10, mtimeMs: oldNow - 2 * 60 * 60 * 1000 };
    const previousSummary = summaryFor(appended, { sourceSignature: previousSignature });
    const checkpoint = checkpointFor(appended, {
      sourceSize: previousSignature.size,
      sourceMtimeMs: previousSignature.mtimeMs,
      lastCompleteOffset: previousSignature.size,
    });

    const plan = createSessionRefreshPlan({
      sources: [appended],
      cachedSummaries: [previousSummary],
      checkpointsByKey: new Map([[checkpoint.sourceKey, checkpoint]]),
      incrementalSupport: { claude: { checkpointVersion: 1 } },
      touchedProviders: ['claude'],
      nowMs: oldNow,
    });

    expect(plan.incrementalBuild.map(item => path.basename(item.sourceFilePath))).toEqual(['appended.jsonl']);
    expect(plan.fullBuild).toEqual([]);
  });

  it('routes an actively changing source to incremental mode before recent-source fallback', () => {
    const active = source('active', {
      sourceSignature: { size: 20, mtimeMs: oldNow - 50 },
    });
    const previousSignature = { size: 10, mtimeMs: oldNow - 1_000 };
    const previousSummary = summaryFor(active, { sourceSignature: previousSignature });
    const checkpoint = checkpointFor(active, {
      sourceSize: previousSignature.size,
      sourceMtimeMs: previousSignature.mtimeMs,
      lastCompleteOffset: previousSignature.size,
    });

    const plan = createSessionRefreshPlan({
      sources: [active],
      cachedSummaries: [previousSummary],
      checkpointsByKey: new Map([[checkpoint.sourceKey, checkpoint]]),
      incrementalSupport: { claude: { checkpointVersion: 1 } },
      touchedProviders: ['claude'],
      nowMs: oldNow,
    });

    expect(plan.incrementalBuild).toEqual([active]);
    expect(plan.recent).toEqual([]);
  });

  it('routes active contract-provider bootstrap work to full indexing instead of lightweight recent mode', () => {
    const active = source('active-bootstrap', {
      sourceSignature: { size: 20, mtimeMs: oldNow - 50 },
    });

    const plan = createSessionRefreshPlan({
      sources: [active],
      cachedSummaries: [],
      incrementalSupport: { claude: { checkpointVersion: 1, buildRecentAsFull: true } },
      touchedProviders: ['claude'],
      nowMs: oldNow,
    });

    expect(plan.fullBuild).toEqual([active]);
    expect(plan.recent).toEqual([]);
  });

  it('falls back to full builds when checkpoints are not eligible', () => {
    const appended = source('appended', {
      sourceSignature: { size: 20, mtimeMs: oldNow - 60 * 60 * 1000 },
    });
    const previousSignature = { size: 10, mtimeMs: oldNow - 2 * 60 * 60 * 1000 };
    const previousSummary = summaryFor(appended, { sourceSignature: previousSignature });
    const checkpoint = checkpointFor(appended, {
      checkpointVersion: 0,
      sourceSize: previousSignature.size,
      sourceMtimeMs: previousSignature.mtimeMs,
      lastCompleteOffset: previousSignature.size,
    });

    const plan = createSessionRefreshPlan({
      sources: [appended],
      cachedSummaries: [previousSummary],
      checkpointsByKey: new Map([[checkpoint.sourceKey, checkpoint]]),
      incrementalSupport: { claude: { checkpointVersion: 1 } },
      touchedProviders: ['claude'],
      nowMs: oldNow,
    });

    expect(plan.incrementalBuild).toEqual([]);
    expect(plan.fullBuild.map(item => path.basename(item.sourceFilePath))).toEqual(['appended.jsonl']);
  });

  it('falls back when append-only checkpoint invariants are violated', () => {
    const previousSignature = { size: 10, mtimeMs: oldNow - 2 * 60 * 60 * 1000 };
    const current = source('appended', {
      sourceSignature: { size: 20, mtimeMs: oldNow - 60 * 60 * 1000 },
    });
    const previousSummary = summaryFor(current, { sourceSignature: previousSignature });

    const invalidCheckpoints = [
      checkpointFor(current, {
        sourceKey: `claude:${path.join(root, 'other.jsonl')}`,
        sourceSize: previousSignature.size,
        sourceMtimeMs: previousSignature.mtimeMs,
      }),
      checkpointFor(current, {
        sourceSize: previousSignature.size,
        sourceMtimeMs: previousSignature.mtimeMs,
        lastCompleteOffset: current.sourceSignature.size + 1,
      }),
      checkpointFor(current, {
        sourceSize: current.sourceSignature.size + 1,
        sourceMtimeMs: previousSignature.mtimeMs,
      }),
      checkpointFor(current, {
        sourceSize: previousSignature.size,
        sourceMtimeMs: oldNow + 1,
      }),
    ];

    for (const checkpoint of invalidCheckpoints) {
      const plan = createSessionRefreshPlan({
        sources: [current],
        cachedSummaries: [previousSummary],
        checkpointsByKey: new Map([[`claude:${current.sourceFilePath}`, checkpoint]]),
        incrementalSupport: { claude: { checkpointVersion: 1 } },
        touchedProviders: ['claude'],
        nowMs: oldNow,
      });

      expect(plan.incrementalBuild).toEqual([]);
      expect(plan.fullBuild.map(item => path.basename(item.sourceFilePath))).toEqual(['appended.jsonl']);
    }
  });

  it('keeps partial summaries out of incremental mode unless the provider explicitly opts in', () => {
    const appended = source('appended', {
      sourceSignature: { size: 20, mtimeMs: oldNow - 60 * 60 * 1000 },
    });
    const previousSignature = { size: 10, mtimeMs: oldNow - 2 * 60 * 60 * 1000 };
    const partialSummary = summaryFor(appended, {
      sourceSignature: previousSignature,
      isPartial: true,
    });
    const checkpoint = checkpointFor(appended, {
      sourceSize: previousSignature.size,
      sourceMtimeMs: previousSignature.mtimeMs,
      lastCompleteOffset: previousSignature.size,
    });

    const fallbackPlan = createSessionRefreshPlan({
      sources: [appended],
      cachedSummaries: [partialSummary],
      checkpointsByKey: new Map([[checkpoint.sourceKey, checkpoint]]),
      incrementalSupport: { claude: { checkpointVersion: 1 } },
      touchedProviders: ['claude'],
      nowMs: oldNow,
    });
    const promotedPlan = createSessionRefreshPlan({
      sources: [appended],
      cachedSummaries: [partialSummary],
      checkpointsByKey: new Map([[checkpoint.sourceKey, checkpoint]]),
      incrementalSupport: { claude: { checkpointVersion: 1, supportsPartialPromotion: true } },
      touchedProviders: ['claude'],
      nowMs: oldNow,
    });

    expect(fallbackPlan.incrementalBuild).toEqual([]);
    expect(fallbackPlan.fullBuild.map(item => path.basename(item.sourceFilePath))).toEqual(['appended.jsonl']);
    expect(promotedPlan.incrementalBuild.map(item => path.basename(item.sourceFilePath))).toEqual(['appended.jsonl']);
  });
});
