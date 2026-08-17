import os from 'os';
import { createHash, randomUUID } from 'crypto';
import type { AgentDataProvider } from './provider';
import {
  summaryCacheKey,
  sourceSummaryCacheKey,
  type SessionSummaryCacheStatus,
} from './session-summary-cache';
import {
  beginSessionSummaryProviderReconciliations,
  clearSessionSummaryIndexCache as clearPersistentSessionSummaryCache,
  commitSessionSummaryIndexSource,
  commitSessionSummaryIndex,
  finalizeSessionSummaryIndexDiscovery,
  deferSessionSummaryIndexSource,
  failSessionSummaryProviderReconciliation,
  getSessionSummaryIndexStatus as buildCacheStatus,
  readSessionSummaryIndexRefreshMetrics,
  readSessionSummaryIndexSourceState,
  observeSessionSummaryIndexSource,
  recordSessionSummaryIndexSourceFailure,
  readSourceParseCheckpoints,
  readSessionSummaryIndexCache,
  writeSessionSummaryIndexRefreshMetrics,
} from './session-summary-sqlite-store';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from './session-summary';
import { createSessionRefreshPlan } from './session-index-planner';
import type {
  IncrementalSessionSummarySupportByProvider,
  SourceParseCheckpoint,
} from './session-parse-checkpoint';
import {
  createSummaryParsePool,
  type ParseSummaryResult,
  type ParseSummaryTask,
  type SummaryParsePoolMode,
} from './session-summary-parse-pool';
import type { AgentKind } from './types';
import { SESSION_SOURCE_STABILITY_GRACE_MS } from './source-stability';

interface MemoEntry {
  key: string;
  value: CachedSessionSummary[];
}

export interface SessionIndexRefreshMetrics {
  runId: string;
  startedAt: string;
  completedAt?: string;
  providers: AgentKind[];
  sourceCount: number;
  validCount: number;
  recentCount: number;
  fullBuildCount: number;
  incrementalBuildCount: number;
  failedBuildCount: number;
  discoveryMsByProvider: Record<string, number>;
  parseMsByProvider: Record<string, number>;
  commitMs: number;
  sqliteRowsWritten: number;
  workerPoolSize: number;
  workerMode: SummaryParsePoolMode;
  error?: string;
}

const memo = new Map<string, MemoEntry>();
const inflight = new Map<string, Promise<CachedSessionSummary[]>>();
interface ProgressiveManifestState {
  key: string;
  result: ProgressiveSessionIndexResult;
  failureCount: number;
  nextReconcileAt: number;
}

const progressiveManifest = new Map<string, ProgressiveManifestState>();
const progressiveInflight = new Map<string, Promise<ProgressiveSessionIndexResult>>();
const DEFAULT_MAX_SUMMARY_BUILD_CONCURRENCY = 1;
const SUMMARY_BUILD_CONCURRENCY_ENV = 'AGENT_SCOPE_SUMMARY_BUILD_CONCURRENCY';
let lastRefreshMetrics: SessionIndexRefreshMetrics | undefined;

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function providerHasSummarySupport(provider: AgentDataProvider): boolean {
  return Boolean(provider.parserVersion && provider.discoverSessionSources && provider.buildSessionSummary);
}

function elapsedMs(start: number): number {
  return Math.max(0, Date.now() - start);
}

function getSummaryBuildConcurrency(): number {
  const configured = Number.parseInt(process.env[SUMMARY_BUILD_CONCURRENCY_ENV] || '', 10);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(configured, 32));
  }

  const parallelism = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Math.min(Math.max(1, parallelism - 1), DEFAULT_MAX_SUMMARY_BUILD_CONCURRENCY));
}

function addProviderMs(target: Record<string, number>, provider: AgentKind, ms: number): void {
  target[provider] = (target[provider] || 0) + ms;
}

function startRefreshMetrics(
  providers: AgentDataProvider[],
  discoveryMsByProvider: Record<string, number>,
  workerPoolSize: number,
  workerMode: SummaryParsePoolMode,
): SessionIndexRefreshMetrics {
  return {
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    providers: providers.map(provider => provider.kind),
    sourceCount: 0,
    validCount: 0,
    recentCount: 0,
    fullBuildCount: 0,
    incrementalBuildCount: 0,
    failedBuildCount: 0,
    discoveryMsByProvider,
    parseMsByProvider: {},
    commitMs: 0,
    sqliteRowsWritten: 0,
    workerPoolSize,
    workerMode,
  };
}

function completeRefreshMetrics(metrics: SessionIndexRefreshMetrics, error?: unknown): void {
  metrics.completedAt = new Date().toISOString();
  if (error) {
    metrics.error = error instanceof Error ? error.message : String(error);
  }
  lastRefreshMetrics = { ...metrics };
  writeSessionSummaryIndexRefreshMetrics(lastRefreshMetrics);
}

function estimateRowsWritten(
  discoveredSources: SessionSummarySource[],
  updatedSummaries: CachedSessionSummary[],
  missingCount: number,
): number {
  let rows = discoveredSources.length + missingCount + 2;
  for (const summary of updatedSummaries) {
    rows += 2; // sources + session_summaries
    rows += Object.keys(summary.modelUsage || {}).length;
    rows += Object.keys(summary.toolsUsed || {}).length;
    rows += summary.usageEvents?.length || 1;
    rows += summary.changeEvents?.length || 1;
  }
  return rows;
}

function getIncrementalSupport(providers: AgentDataProvider[]): IncrementalSessionSummarySupportByProvider {
  const support: IncrementalSessionSummarySupportByProvider = {};
  for (const provider of providers) {
    if (provider.incrementalSessionSummary) {
      support[provider.kind] = {
        checkpointVersion: provider.incrementalSessionSummary.checkpointVersion,
        buildRecentAsFull: provider.incrementalSessionSummary.buildRecentAsFull,
      };
    }
  }
  return support;
}

function parseResultMs(result: ParseSummaryResult): number {
  return result.timings.readMs + result.timings.parseMs + result.timings.summarizeMs;
}

export function boundedIncrementalPreviousSummary(summary: CachedSessionSummary): CachedSessionSummary {
  return {
    ...summary,
    usageEvents: undefined,
    changeEvents: undefined,
  };
}

interface DiscoveryResult {
  sources: SessionSummarySource[];
  discoveryMsByProvider: Record<string, number>;
  successfulProviders: AgentDataProvider[];
  failures: Array<{ provider: AgentKind; error: string }>;
}

async function discoverSourcesWithMetrics(
  providers: AgentDataProvider[],
  discoverProvider?: (provider: AgentDataProvider) => Promise<SessionSummarySource[]>,
): Promise<DiscoveryResult> {
  const results: SessionSummarySource[][] = [];
  const discoveryMsByProvider: Record<string, number> = {};
  const successfulProviders: AgentDataProvider[] = [];
  const failures: Array<{ provider: AgentKind; error: string }> = [];
  for (const provider of providers.filter(providerHasSummarySupport)) {
    await yieldToEventLoop();
    const started = Date.now();
    try {
      results.push(discoverProvider
        ? await discoverProvider(provider)
        : await provider.discoverSessionSources!());
      successfulProviders.push(provider);
    } catch (error) {
      failures.push({
        provider: provider.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      discoveryMsByProvider[provider.kind] = elapsedMs(started);
    }
  }
  const sources = results.flat().sort((left, right) => {
    const providerCompare = left.provider.localeCompare(right.provider);
    if (providerCompare) return providerCompare;
      return left.sourceFilePath.localeCompare(right.sourceFilePath);
  });
  const uniqueSources: SessionSummarySource[] = [];
  const seenKeys = new Set<string>();
  for (const source of sources) {
    const key = sourceSummaryCacheKey(source);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueSources.push(source);
  }
  return { sources: uniqueSources, discoveryMsByProvider, successfulProviders, failures };
}

async function discoverSources(providers: AgentDataProvider[]): Promise<SessionSummarySource[]> {
  return (await discoverSourcesWithMetrics(providers)).sources;
}

function manifestKey(providers: AgentDataProvider[], sources: SessionSummarySource[]): string {
  const providerPart = providers.map(provider => `${provider.kind}:${provider.parserVersion || 'none'}`).sort().join(',');
  const hash = createHash('sha256');
  hash.update(`${SESSION_SUMMARY_CACHE_VERSION}:${providerPart}\n`);
  for (const source of sources) {
    hash.update(source.provider);
    hash.update('\0');
    hash.update(source.parserVersion);
    hash.update('\0');
    hash.update(source.sourceFilePath);
    hash.update('\0');
    hash.update(String(source.sourceSignature.mtimeMs));
    hash.update('\0');
    hash.update(String(source.sourceSignature.size));
    hash.update('\n');
  }
  return `${SESSION_SUMMARY_CACHE_VERSION}:${providerPart}:${hash.digest('hex')}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  callback: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await yieldToEventLoop();
      results[index] = await callback(items[index], index);
    }
  }));

  return results;
}

function getReusableRecentSummaries(sources: SessionSummarySource[]): Map<string, CachedSessionSummary> {
  const cache = readSessionSummaryIndexCache();
  const summariesByKey = new Map(cache.summaries.map(summary => [summaryCacheKey(summary), summary]));
  const reusable = new Map<string, CachedSessionSummary>();

  for (const source of sources) {
    const key = sourceSummaryCacheKey(source);
    const summary = summariesByKey.get(key);
    if (
      summary?.cacheVersion === SESSION_SUMMARY_CACHE_VERSION
      && summary.provider === source.provider
      && summary.parserVersion === source.parserVersion
      && summary.sourceFilePath === source.sourceFilePath
    ) {
      reusable.set(key, summary);
    }
  }

  return reusable;
}

function summaryMatchesSourceSignature(summary: CachedSessionSummary, source: SessionSummarySource): boolean {
  return summary.sourceSignature.size === source.sourceSignature.size
    && summary.sourceSignature.mtimeMs === source.sourceSignature.mtimeMs;
}

async function buildRecentSummaries(
  providers: AgentDataProvider[],
  sources: SessionSummarySource[],
  reusableByKey: Map<string, CachedSessionSummary>,
  concurrency: number,
  metrics: SessionIndexRefreshMetrics,
  options: { allowExactReuse?: boolean } = {},
): Promise<CachedSessionSummary[]> {
  const providerByKind = new Map(providers.map(provider => [provider.kind, provider]));
  const summaries = await mapWithConcurrency(sources, concurrency, async (source) => {
    const provider = providerByKind.get(source.provider);
    const started = Date.now();
    try {
      if (provider?.buildLightweightSessionSummary) {
        return {
          ...provider.buildLightweightSessionSummary(source),
          isPartial: true,
        };
      }
      const reusable = reusableByKey.get(sourceSummaryCacheKey(source));
      if (options.allowExactReuse !== false && reusable && summaryMatchesSourceSignature(reusable, source)) {
        return reusable;
      }
      if (provider?.buildSessionSummary) return provider.buildSessionSummary(source);
    } catch {
      metrics.failedBuildCount += 1;
      // Keep the last indexed prefix if a hot log is between writes.
    } finally {
      addProviderMs(metrics.parseMsByProvider, source.provider, elapsedMs(started));
    }
    return reusableByKey.get(sourceSummaryCacheKey(source)) || null;
  });

  return summaries.filter((summary): summary is CachedSessionSummary => Boolean(summary));
}

interface ParseResultCollections {
  updatedSummaries: CachedSessionSummary[];
  updatedCheckpoints: SourceParseCheckpoint[];
  deletedCheckpointKeys: string[];
  failedFallbackSummaries: CachedSessionSummary[];
}

function collectParseResults(
  results: ParseSummaryResult[],
  tasksBySourceKey: Map<string, ParseSummaryTask>,
  existingCheckpointsByKey: Map<string, SourceParseCheckpoint>,
  metrics: SessionIndexRefreshMetrics,
): ParseResultCollections {
  const updatedSummaries: CachedSessionSummary[] = [];
  const updatedCheckpoints: SourceParseCheckpoint[] = [];
  const deletedCheckpointKeys: string[] = [];
  const failedFallbackSummaries: CachedSessionSummary[] = [];
  const checkpointUpdateKeys = new Set<string>();

  for (const result of results) {
    addProviderMs(metrics.parseMsByProvider, result.provider, parseResultMs(result));
    const task = tasksBySourceKey.get(result.sourceKey);
    if (result.error || !result.summary) {
      metrics.failedBuildCount += 1;
      if (task?.previousSummary && !task.previousSummary.isPartial) {
        failedFallbackSummaries.push(task.previousSummary);
      }
      continue;
    }

    updatedSummaries.push(result.summary);
    if (result.checkpoint) {
      updatedCheckpoints.push(result.checkpoint);
      checkpointUpdateKeys.add(result.sourceKey);
    }
    if (result.mode === 'full' && existingCheckpointsByKey.has(result.sourceKey) && !checkpointUpdateKeys.has(result.sourceKey)) {
      deletedCheckpointKeys.push(result.sourceKey);
    }
  }

  return {
    updatedSummaries,
    updatedCheckpoints,
    deletedCheckpointKeys,
    failedFallbackSummaries,
  };
}

async function buildSummaries(
  providers: AgentDataProvider[],
  sources: SessionSummarySource[],
  options: { force?: boolean; nowMs?: number; discoveryMsByProvider?: Record<string, number> } = {},
): Promise<CachedSessionSummary[]> {
  const nowMs = options.nowMs ?? Date.now();
  const concurrency = getSummaryBuildConcurrency();
  const cache = readSessionSummaryIndexCache();
  const cachedSummaries = cache.summaries;
  const cachedByKey = new Map(cachedSummaries.map(summary => [summaryCacheKey(summary), summary]));
  const checkpointsByKey = readSourceParseCheckpoints(sources);
  const parsePool = createSummaryParsePool(providers, { concurrency });
  const plan = createSessionRefreshPlan({
    sources,
    cachedSummaries,
    touchedProviders: providers.map(provider => provider.kind),
    checkpointsByKey,
    incrementalSupport: getIncrementalSupport(providers),
    force: options.force,
    nowMs,
  });
  const metrics = startRefreshMetrics(providers, options.discoveryMsByProvider || {}, parsePool.size, parsePool.mode);
  metrics.sourceCount = sources.length;
  metrics.validCount = plan.valid.length;
  metrics.recentCount = plan.recent.length;
  metrics.fullBuildCount = plan.fullBuild.length;
  metrics.incrementalBuildCount = plan.incrementalBuild.length;
  lastRefreshMetrics = metrics;

  const validSummaries = plan.valid
    .map(source => cachedByKey.get(sourceSummaryCacheKey(source)))
    .filter((summary): summary is CachedSessionSummary => Boolean(summary));
  const recentSummariesByKey = getReusableRecentSummaries(plan.recent);
  try {
    const recentSummaries = await buildRecentSummaries(
      providers,
      plan.recent,
      recentSummariesByKey,
      concurrency,
      metrics,
      { allowExactReuse: !options.force },
    );
    const parseTasks: ParseSummaryTask[] = [
      ...plan.fullBuild.map(source => ({
        provider: source.provider,
        source,
        mode: 'full' as const,
        previousSummary: cachedByKey.get(sourceSummaryCacheKey(source)),
      })),
      ...plan.incrementalBuild.map(source => ({
        provider: source.provider,
        source,
        mode: 'incremental' as const,
        previousSummary: cachedByKey.get(sourceSummaryCacheKey(source))
          ? boundedIncrementalPreviousSummary(cachedByKey.get(sourceSummaryCacheKey(source))!)
          : undefined,
        checkpoint: checkpointsByKey.get(sourceSummaryCacheKey(source)),
      })),
    ];
    const tasksBySourceKey = new Map(parseTasks.map(task => [sourceSummaryCacheKey(task.source), task]));
    const parseResults = await parsePool.run(parseTasks);
    const {
      updatedSummaries,
      updatedCheckpoints,
      deletedCheckpointKeys,
      failedFallbackSummaries,
    } = collectParseResults(parseResults, tasksBySourceKey, checkpointsByKey, metrics);
    const summariesToCommit = [...updatedSummaries, ...recentSummaries];
    const commitStarted = Date.now();
    commitSessionSummaryIndex({
      touchedProviders: plan.touchedProviders,
      discoveredSources: sources,
      updatedSummaries: summariesToCommit,
      updatedCheckpoints,
      deletedCheckpointKeys,
    });
    metrics.commitMs = elapsedMs(commitStarted);
    metrics.sqliteRowsWritten = estimateRowsWritten(sources, summariesToCommit, plan.missingCachedKeys.length);
    completeRefreshMetrics(metrics);

    return [...validSummaries, ...updatedSummaries, ...recentSummaries, ...failedFallbackSummaries]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (error) {
    completeRefreshMetrics(metrics, error);
    throw error;
  } finally {
    await parsePool.close();
  }
}

export interface ProgressiveSessionIndexProgress {
  totalSources: number;
  processedSources: number;
  committedSources: number;
  failedSources: number;
  currentProvider?: AgentKind;
  heapUsedBytes: number;
  rssBytes: number;
}

export interface ProgressiveSessionIndexResult extends ProgressiveSessionIndexProgress {
  validSources: number;
  recentSources: number;
  fullBuildSources: number;
  incrementalBuildSources: number;
  deferredSources: number;
  lastError?: string;
}

export interface ProgressiveSessionIndexOptions {
  force?: boolean;
  parsePool?: ReturnType<typeof createSummaryParsePool>;
  discoverProvider?: (provider: AgentDataProvider) => Promise<SessionSummarySource[]>;
  onProgress?: (progress: ProgressiveSessionIndexProgress) => void;
}

function memoryProgress(
  totalSources: number,
  processedSources: number,
  committedSources: number,
  failedSources: number,
  currentProvider?: AgentKind,
): ProgressiveSessionIndexProgress {
  const memory = process.memoryUsage();
  return {
    totalSources,
    processedSources,
    committedSources,
    failedSources,
    currentProvider,
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
  };
}

async function reconcileDiscoveredSources(
  providers: AgentDataProvider[],
  sources: SessionSummarySource[],
  discoveryMsByProvider: Record<string, number>,
  options: ProgressiveSessionIndexOptions,
): Promise<ProgressiveSessionIndexResult> {
  const nowMs = Date.now();
  const providerByKind = new Map(providers.map(provider => [provider.kind, provider]));
  const pool = options.parsePool || createSummaryParsePool(providers, { concurrency: 1 });
  const ownsPool = !options.parsePool;
  const metrics = startRefreshMetrics(providers, discoveryMsByProvider, 1, pool.mode);
  metrics.sourceCount = sources.length;
  lastRefreshMetrics = metrics;

  let processedSources = 0;
  let committedSources = 0;
  let failedSources = 0;
  let deferredSources = 0;
  let validSources = 0;
  let lastError: string | undefined;

  const publish = (currentProvider?: AgentKind) => {
    options.onProgress?.(memoryProgress(
      sources.length,
      processedSources,
      committedSources,
      failedSources,
      currentProvider,
    ));
  };

  publish();
  try {
    for (const source of sources) {
      const provider = providerByKind.get(source.provider);
      const state = readSessionSummaryIndexSourceState(source);
      const retryAt = state.retryAfter ? new Date(state.retryAfter).getTime() : 0;
      if (state.jobState === 'failed' && Number.isFinite(retryAt) && retryAt > Date.now()) {
        failedSources += 1;
        lastError = state.lastError || `Source ${sourceSummaryCacheKey(source)} is waiting to retry`;
        processedSources += 1;
        publish(source.provider);
        continue;
      }
      observeSessionSummaryIndexSource(source);
      const checkpoints = state.checkpoint
        ? new Map([[sourceSummaryCacheKey(source), state.checkpoint]])
        : new Map<string, SourceParseCheckpoint>();
      const plan = createSessionRefreshPlan({
        sources: [source],
        cachedSummaries: state.summary ? [state.summary] : [],
        touchedProviders: [source.provider],
        checkpointsByKey: checkpoints,
        incrementalSupport: getIncrementalSupport(providers),
        force: options.force,
        nowMs,
      });

      metrics.validCount += plan.valid.length;
      metrics.recentCount += plan.recent.length;
      metrics.fullBuildCount += plan.fullBuild.length;
      metrics.incrementalBuildCount += plan.incrementalBuild.length;
      validSources += plan.valid.length;
      publish(source.provider);

      if (plan.valid.length) {
        processedSources += 1;
        publish();
        continue;
      }

      try {
        let result: ParseSummaryResult | undefined;
        if (plan.recent.length) {
          [result] = await pool.run([{
            provider: source.provider,
            source,
            mode: 'recent',
          }]);
        } else {
          const mode = plan.incrementalBuild.length ? 'incremental' as const : 'full' as const;
          const task: ParseSummaryTask = {
            provider: source.provider,
            source,
            mode,
            previousSummary: mode === 'incremental' && state.summary
              ? boundedIncrementalPreviousSummary(state.summary)
              : undefined,
            checkpoint: mode === 'incremental' ? state.checkpoint : undefined,
          };
          [result] = await pool.run([task]);
        }

        if (result?.deferred) {
          deferredSources += 1;
          deferSessionSummaryIndexSource(source);
        } else if (!result?.summary || result.error) {
          failedSources += 1;
          metrics.failedBuildCount += 1;
          lastError = result?.error || `Provider ${source.provider} returned no summary`;
          recordSessionSummaryIndexSourceFailure(source, lastError);
        } else {
          const commitStarted = Date.now();
          addProviderMs(metrics.parseMsByProvider, result.provider, parseResultMs(result));
          try {
            commitSessionSummaryIndexSource({
              source,
              summary: result.summary,
              checkpoint: result.checkpoint,
              mutations: result.mutations,
              deleteCheckpoint: result.mode !== 'incremental' && Boolean(state.checkpoint) && !result.checkpoint,
            });
            metrics.sqliteRowsWritten += estimateRowsWritten([source], [result.summary], 0);
            committedSources += 1;
          } catch (error) {
            failedSources += 1;
            metrics.failedBuildCount += 1;
            lastError = error instanceof Error ? error.message : String(error);
            recordSessionSummaryIndexSourceFailure(source, lastError);
          } finally {
            metrics.commitMs += elapsedMs(commitStarted);
          }
        }
      } finally {
        provider?.resetCache?.();
      }

      processedSources += 1;
      publish();
    }

    const finalizeStarted = Date.now();
    finalizeSessionSummaryIndexDiscovery(providers.map(provider => provider.kind), sources);
    metrics.commitMs += elapsedMs(finalizeStarted);
    completeRefreshMetrics(metrics);
  } catch (error) {
    completeRefreshMetrics(metrics, error);
    throw error;
  } finally {
    if (ownsPool) await pool.close();
  }

  return {
    ...memoryProgress(sources.length, processedSources, committedSources, failedSources),
    validSources,
    recentSources: metrics.recentCount,
    fullBuildSources: metrics.fullBuildCount,
    incrementalBuildSources: metrics.incrementalBuildCount,
    deferredSources,
    lastError,
  };
}

/**
 * Bounded-memory production reconciliation. It plans and publishes one source
 * at a time and never returns or memoizes the complete summary corpus.
 */
export async function reconcileSessionSummaryIndex(
  providers: AgentDataProvider[],
  options: ProgressiveSessionIndexOptions = {},
): Promise<ProgressiveSessionIndexResult> {
  const supportedProviders = providers.filter(providerHasSummarySupport);
  if (supportedProviders.length === 0) {
    return { ...memoryProgress(0, 0, 0, 0), validSources: 0, recentSources: 0, fullBuildSources: 0, incrementalBuildSources: 0, deferredSources: 0 };
  }

  beginSessionSummaryProviderReconciliations(supportedProviders.map(provider => provider.kind));
  const { sources, discoveryMsByProvider, successfulProviders, failures } = await discoverSourcesWithMetrics(
    supportedProviders,
    options.discoverProvider,
  );
  for (const failure of failures) {
    failSessionSummaryProviderReconciliation(failure.provider, failure.error);
  }
  if (successfulProviders.length === 0) {
    return {
      ...memoryProgress(0, 0, 0, failures.length),
      validSources: 0,
      recentSources: 0,
      fullBuildSources: 0,
      incrementalBuildSources: 0,
      deferredSources: 0,
      lastError: failures.map(failure => `${failure.provider}: ${failure.error}`).join('; '),
    };
  }
  const key = manifestKey(successfulProviders, sources);
  const memoKey = successfulProviders.map(provider => provider.kind).sort().join(',');
  const priorManifest = progressiveManifest.get(memoKey);
  if (
    !options.force
    && priorManifest?.key === key
    && Date.now() < priorManifest.nextReconcileAt
  ) {
    finalizeSessionSummaryIndexDiscovery(
      successfulProviders.map(provider => provider.kind),
      sources,
    );
    return {
      ...priorManifest.result,
      ...memoryProgress(sources.length, sources.length, 0, 0),
      failedSources: priorManifest.result.failedSources,
      lastError: priorManifest.result.lastError,
    };
  }

  const inflightKey = `${options.force ? 'force:' : ''}${key}`;
  const current = progressiveInflight.get(inflightKey);
  if (current) return current;

  const running = reconcileDiscoveredSources(successfulProviders, sources, discoveryMsByProvider, options)
    .then((result) => {
      if (failures.length > 0) {
        result.failedSources += failures.length;
        result.lastError = failures.map(failure => `${failure.provider}: ${failure.error}`).join('; ');
      }
      const priorFailureCount = priorManifest?.key === key ? priorManifest.failureCount : 0;
      const failureCount = result.failedSources > 0 ? priorFailureCount + 1 : 0;
      const failureDelayMs = result.failedSources > 0
        ? Math.min(
            (result.lastError?.includes('exited') ? 5 * 60_000 : 30_000) * (2 ** Math.max(0, failureCount - 1)),
            30 * 60_000,
          )
        : Number.POSITIVE_INFINITY;
      const recentPromotionTimes = sources
        .map(source => source.sourceSignature.mtimeMs + SESSION_SOURCE_STABILITY_GRACE_MS)
        .filter(promotionAt => promotionAt > Date.now());
      const nextRecentPromotionAt = result.recentSources > 0 && recentPromotionTimes.length > 0
        ? Math.min(...recentPromotionTimes)
        : Number.POSITIVE_INFINITY;
      const nextDeferredRetryAt = result.deferredSources > 0
        ? Date.now() + 1_000
        : Number.POSITIVE_INFINITY;
      progressiveManifest.set(memoKey, {
        key,
        result,
        failureCount,
        nextReconcileAt: Math.min(Date.now() + failureDelayMs, nextRecentPromotionAt, nextDeferredRetryAt),
      });
      return result;
    })
    .finally(() => progressiveInflight.delete(inflightKey));
  progressiveInflight.set(inflightKey, running);
  return running;
}

export async function getCachedSessionSummaries(providers: AgentDataProvider[]): Promise<CachedSessionSummary[]> {
  const supportedProviders = providers.filter(providerHasSummarySupport);
  if (supportedProviders.length === 0) return [];

  const { sources, discoveryMsByProvider } = await discoverSourcesWithMetrics(supportedProviders);
  const nowMs = Date.now();
  const key = manifestKey(supportedProviders, sources);
  const memoKey = supportedProviders.map(provider => provider.kind).sort().join(',');
  const cached = memo.get(memoKey);
  if (cached?.key === key) return cached.value;

  const running = inflight.get(key);
  if (running) return running;

  const promise = buildSummaries(supportedProviders, sources, { nowMs, discoveryMsByProvider })
    .then((summaries) => {
      memo.set(memoKey, { key, value: summaries });
      return summaries;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

export async function getSessionSummaryCacheStatus(providers: AgentDataProvider[]): Promise<SessionSummaryCacheStatus> {
  const supportedProviders = providers.filter(providerHasSummarySupport);
  const sources = await discoverSources(supportedProviders);
  return buildCacheStatus(supportedProviders.map(provider => provider.kind), sources);
}

export async function rebuildCachedSessionSummaries(providers: AgentDataProvider[]): Promise<CachedSessionSummary[]> {
  resetSessionSummaryStoreForTests();
  const supportedProviders = providers.filter(providerHasSummarySupport);
  const { sources, discoveryMsByProvider } = await discoverSourcesWithMetrics(supportedProviders);
  const nowMs = Date.now();
  const summaries = await buildSummaries(supportedProviders, sources, { force: true, nowMs, discoveryMsByProvider });
  const key = manifestKey(supportedProviders, sources);
  const memoKey = supportedProviders.map(provider => provider.kind).sort().join(',');
  memo.set(memoKey, { key, value: summaries });
  return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function clearSessionSummaryCache(): void {
  clearPersistentSessionSummaryCache();
  resetSessionSummaryStore();
}

export function resetSessionSummaryStore(): void {
  memo.clear();
  inflight.clear();
  progressiveManifest.clear();
  progressiveInflight.clear();
}

export function getLastSessionIndexRefreshMetrics(): SessionIndexRefreshMetrics | undefined {
  if (lastRefreshMetrics) return { ...lastRefreshMetrics };
  const persisted = readSessionSummaryIndexRefreshMetrics<SessionIndexRefreshMetrics>();
  return persisted ? { ...persisted } : undefined;
}

export function resetSessionSummaryStoreForTests(): void {
  resetSessionSummaryStore();
  lastRefreshMetrics = undefined;
}
