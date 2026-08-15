import fs from 'fs';
import type { AgentDataProvider } from './provider';
import { getLiveSessions } from '@/lib/claude-data/live-sessions';
import {
  getCachedSessionSummaries,
  getLastSessionIndexRefreshMetrics,
  getSessionSummaryCacheStatus,
  rebuildCachedSessionSummaries,
  type SessionIndexRefreshMetrics,
} from './session-summary-store';
import {
  sourceSummaryCacheKey,
  summaryCacheKey,
  type SessionSummaryCacheStatus,
} from './session-summary-cache';
import {
  getSessionSummaryIndexPath,
  getSessionSummaryIndexReadSignature,
  readSessionSummaryIndexCache,
  readSessionSummaryIndexCacheForProviders,
} from './session-summary-sqlite-store';
import { sortSummariesByTimestamp, type CachedSessionSummary } from './session-summary';

export type SessionIndexState = 'fresh' | 'stale' | 'refreshing' | 'empty' | 'error';

export interface SessionIndexStatus extends SessionSummaryCacheStatus {
  status: SessionIndexState;
  unindexedCount: number;
  refreshStartedAt?: string;
  refreshCompletedAt?: string;
  refreshError?: string;
  refreshMetrics?: SessionIndexRefreshMetrics;
}

export interface IndexedSessionSnapshot {
  summaries: CachedSessionSummary[];
  signature: string;
}

interface RuntimeState {
  refreshPromise?: Promise<CachedSessionSummary[]>;
  refreshStartedAt?: string;
  refreshCompletedAt?: string;
  refreshError?: string;
  lastRefreshCheckMs?: number;
}

const REFRESH_CHECK_THROTTLE_MS = 15_000;
const runtimeByKey = new Map<string, RuntimeState>();
const snapshotMemo = new Map<string, IndexedSessionSnapshot>();

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function supportedProviders(providers: AgentDataProvider[]): AgentDataProvider[] {
  return providers.filter(provider => (
    Boolean(provider.parserVersion)
    && typeof provider.discoverSessionSources === 'function'
    && typeof provider.buildSessionSummary === 'function'
  ));
}

function runtimeKey(providers: AgentDataProvider[]): string {
  return supportedProviders(providers)
    .map(provider => `${provider.kind}:${provider.parserVersion || 'none'}`)
    .sort()
    .join(',');
}

function getRuntimeState(providers: AgentDataProvider[]): RuntimeState {
  const key = runtimeKey(providers);
  const state = runtimeByKey.get(key) || {};
  runtimeByKey.set(key, state);
  return state;
}

function hasBusyLiveClaudeSession(providers: AgentDataProvider[]): boolean {
  if (!providers.some(provider => provider.kind === 'claude')) return false;

  try {
    return getLiveSessions().some(session => session.status === 'busy');
  } catch {
    return false;
  }
}

function readIndexedSnapshot(providers: AgentDataProvider[]): IndexedSessionSnapshot {
  const refreshProviders = supportedProviders(providers);
  const providerRuntimeKey = runtimeKey(refreshProviders);
  const providerKinds = supportedProviders(providers).map(provider => provider.kind);
  const cache = readSessionSummaryIndexCacheForProviders(providerKinds);
  const cacheFileSignature = getSessionSummaryIndexReadSignature();
  const snapshotKey = `${providerRuntimeKey}:${cacheFileSignature}`;
  const cached = snapshotMemo.get(snapshotKey);
  if (cached) return cached;

  const summaries = cache.summaries
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const signature = [
    cache.cacheVersion,
    cache.generatedAt,
    providerRuntimeKey,
    cacheFileSignature,
    summaries.length,
  ].join(':');
  const snapshot = { summaries, signature };
  if (snapshotMemo.size > 12) snapshotMemo.clear();
  snapshotMemo.set(snapshotKey, snapshot);
  return snapshot;
}

function readIndexedSummaries(providers: AgentDataProvider[]): CachedSessionSummary[] {
  return readIndexedSnapshot(providers).summaries;
}

function summarizeStatus(cacheStatus: SessionSummaryCacheStatus, state: RuntimeState): Pick<SessionIndexStatus, 'status' | 'unindexedCount'> {
  const unindexedCount = Math.max(cacheStatus.sourceCount - cacheStatus.validCount - cacheStatus.staleCount, 0);
  if (state.refreshPromise) return { status: 'refreshing', unindexedCount };
  if (state.refreshError) return { status: 'error', unindexedCount };
  if (cacheStatus.summaryCount === 0) return { status: 'empty', unindexedCount };
  if (cacheStatus.staleCount > 0 || cacheStatus.missingCount > 0 || unindexedCount > 0) {
    return { status: 'stale', unindexedCount };
  }
  return { status: 'fresh', unindexedCount };
}

function refreshMetricsForProviders(providers: AgentDataProvider[]): SessionIndexRefreshMetrics | undefined {
  const providerKinds = new Set(supportedProviders(providers).map(provider => provider.kind));
  const metrics = getLastSessionIndexRefreshMetrics();
  if (!metrics) return undefined;
  return metrics.providers.some(provider => providerKinds.has(provider)) ? metrics : undefined;
}

export function getIndexedSessionSummaries(providers: AgentDataProvider[]): CachedSessionSummary[] {
  return readIndexedSummaries(providers);
}

export function getIndexedSessionSnapshot(providers: AgentDataProvider[]): IndexedSessionSnapshot {
  return readIndexedSnapshot(providers);
}

async function getLightweightFallbackSummaries(
  providers: AgentDataProvider[],
  cachedSummaries: CachedSessionSummary[],
): Promise<CachedSessionSummary[]> {
  const fallbackProviders = supportedProviders(providers)
    .filter(provider => provider.discoverSessionSources && provider.buildLightweightSessionSummary);
  if (fallbackProviders.length === 0) return [];

  const cachedByKey = new Map(cachedSummaries.map(summary => [summaryCacheKey(summary), summary]));
  const fallbackSummaries: CachedSessionSummary[] = [];

  for (const provider of fallbackProviders) {
    const sources = await provider.discoverSessionSources!();
    for (const source of sources) {
      if (cachedByKey.has(sourceSummaryCacheKey(source))) continue;
      fallbackSummaries.push(provider.buildLightweightSessionSummary!(source));
    }
  }

  return fallbackSummaries;
}

export async function getIndexedSessionSummariesWithFallbacks(providers: AgentDataProvider[]): Promise<CachedSessionSummary[]> {
  const summaries = readIndexedSummaries(providers);
  ensureSessionIndexRefresh(providers);

  const fallbackSummaries = await getLightweightFallbackSummaries(providers, summaries);
  if (fallbackSummaries.length === 0) return summaries;

  const merged = new Map<string, CachedSessionSummary>();
  for (const summary of summaries) merged.set(summaryCacheKey(summary), summary);
  for (const summary of fallbackSummaries) merged.set(summaryCacheKey(summary), summary);
  return sortSummariesByTimestamp(Array.from(merged.values()));
}

export function ensureSessionIndexRefresh(providers: AgentDataProvider[]): void {
  const refreshProviders = supportedProviders(providers);
  if (refreshProviders.length === 0) return;

  const state = getRuntimeState(refreshProviders);
  const now = Date.now();
  if (state.refreshPromise) return;
  if (state.lastRefreshCheckMs && now - state.lastRefreshCheckMs < REFRESH_CHECK_THROTTLE_MS) return;
  if (hasBusyLiveClaudeSession(refreshProviders)) return;

  state.lastRefreshCheckMs = now;
  state.refreshStartedAt = new Date(now).toISOString();
  state.refreshError = undefined;
  state.refreshPromise = (async () => {
    await yieldToEventLoop();
    return getCachedSessionSummaries(refreshProviders);
  })()
    .then((summaries) => {
      state.refreshCompletedAt = new Date().toISOString();
      return summaries;
    })
    .catch((error: unknown) => {
      state.refreshError = error instanceof Error ? error.message : 'Unknown index refresh error';
      return [];
    })
    .finally(() => {
      state.refreshPromise = undefined;
    });
}

export async function rebuildSessionIndex(providers: AgentDataProvider[]): Promise<CachedSessionSummary[]> {
  const refreshProviders = supportedProviders(providers);
  const state = getRuntimeState(refreshProviders);
  state.refreshStartedAt = new Date().toISOString();
  state.refreshError = undefined;
  try {
    const summaries = await rebuildCachedSessionSummaries(refreshProviders);
    state.refreshCompletedAt = new Date().toISOString();
    return summaries;
  } catch (error) {
    state.refreshError = error instanceof Error ? error.message : 'Unknown index rebuild error';
    throw error;
  } finally {
    state.refreshPromise = undefined;
  }
}

export async function getSessionIndexStatus(providers: AgentDataProvider[]): Promise<SessionIndexStatus> {
  const refreshProviders = supportedProviders(providers);
  const cacheStatus = await getSessionSummaryCacheStatus(refreshProviders);
  const state = getRuntimeState(refreshProviders);
  const status = summarizeStatus(cacheStatus, state);
  if (status.status === 'stale' || status.status === 'empty') {
    ensureSessionIndexRefresh(refreshProviders);
  }

  return {
    ...cacheStatus,
    ...summarizeStatus(cacheStatus, getRuntimeState(refreshProviders)),
    refreshStartedAt: state.refreshStartedAt,
    refreshCompletedAt: state.refreshCompletedAt,
    refreshError: state.refreshError,
    refreshMetrics: refreshMetricsForProviders(refreshProviders),
  };
}

export function getQuickSessionIndexStatus(providers: AgentDataProvider[]): SessionIndexStatus {
  const refreshProviders = supportedProviders(providers);
  const providerKinds = refreshProviders.map(provider => provider.kind);
  const parserVersionByProvider = new Map(refreshProviders.map(provider => [provider.kind, provider.parserVersion || 'none']));
  const state = getRuntimeState(refreshProviders);
  const cache = readSessionSummaryIndexCache();
  const cachePath = getSessionSummaryIndexPath();
  const summaries = cache.summaries.filter(summary => providerKinds.includes(summary.provider));
  const summaryCount = summaries.length;
  const staleCount = summaries.filter(summary => summary.parserVersion !== parserVersionByProvider.get(summary.provider)).length;
  const validCount = Math.max(summaryCount - staleCount, 0);
  const status: SessionIndexState = state.refreshPromise
    ? 'refreshing'
    : state.refreshError
      ? 'error'
      : providerKinds.length === 0
        ? 'fresh'
        : summaryCount === 0
        ? 'empty'
        : staleCount > 0
          ? 'stale'
          : 'fresh';

  return {
    cachePath,
    exists: fs.existsSync(cachePath),
    generatedAt: cache.generatedAt,
    summaryCount,
    activeProviders: providerKinds,
    sourceCount: summaryCount,
    validCount,
    staleCount,
    missingCount: 0,
    status,
    unindexedCount: 0,
    refreshStartedAt: state.refreshStartedAt,
    refreshCompletedAt: state.refreshCompletedAt,
    refreshError: state.refreshError,
    refreshMetrics: refreshMetricsForProviders(refreshProviders),
  };
}

export function resetSessionIndexer(): void {
  runtimeByKey.clear();
  snapshotMemo.clear();
}

export function resetSessionIndexerForTests(): void {
  resetSessionIndexer();
}
