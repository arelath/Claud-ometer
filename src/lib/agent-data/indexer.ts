import fs from 'fs';
import type { AgentDataProvider } from './provider';
import {
  getCachedSessionSummaries,
  getSessionSummaryCacheStatus,
  rebuildCachedSessionSummaries,
} from './session-summary-store';
import {
  readSessionSummaryCache,
  getSessionSummaryCachePath,
  sourceSummaryCacheKey,
  summaryCacheKey,
  type SessionSummaryCacheStatus,
} from './session-summary-cache';
import { sortSummariesByTimestamp, type CachedSessionSummary } from './session-summary';

export type SessionIndexState = 'fresh' | 'stale' | 'refreshing' | 'empty' | 'error';

export interface SessionIndexStatus extends SessionSummaryCacheStatus {
  status: SessionIndexState;
  unindexedCount: number;
  refreshStartedAt?: string;
  refreshCompletedAt?: string;
  refreshError?: string;
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

function readIndexedSnapshot(providers: AgentDataProvider[]): IndexedSessionSnapshot {
  const refreshProviders = supportedProviders(providers);
  const cache = readSessionSummaryCache();
  const providerKinds = new Set(supportedProviders(providers).map(provider => provider.kind));
  const summaries = cache.summaries
    .filter(summary => providerKinds.has(summary.provider))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const signature = [
    cache.cacheVersion,
    cache.generatedAt,
    runtimeKey(refreshProviders),
    summaries.length,
    summaries
      .map(summary => [
        summary.provider,
        summary.parserVersion,
        summary.sourceFilePath,
        summary.sourceSignature.mtimeMs,
        summary.sourceSignature.size,
      ].join('\0'))
      .join('\n'),
  ].join(':');
  return { summaries, signature };
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

  state.lastRefreshCheckMs = now;
  state.refreshStartedAt = new Date(now).toISOString();
  state.refreshError = undefined;
  state.refreshPromise = getCachedSessionSummaries(refreshProviders)
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
  };
}

export function getQuickSessionIndexStatus(providers: AgentDataProvider[]): SessionIndexStatus {
  const refreshProviders = supportedProviders(providers);
  const providerKinds = refreshProviders.map(provider => provider.kind);
  const state = getRuntimeState(refreshProviders);
  const cache = readSessionSummaryCache();
  const cachePath = getSessionSummaryCachePath();
  const summaryCount = cache.summaries.filter(summary => providerKinds.includes(summary.provider)).length;
  const status: SessionIndexState = state.refreshPromise
    ? 'refreshing'
    : state.refreshError
      ? 'error'
      : summaryCount === 0
        ? 'empty'
        : 'fresh';

  return {
    cachePath,
    exists: fs.existsSync(cachePath),
    generatedAt: cache.generatedAt,
    summaryCount,
    activeProviders: providerKinds,
    sourceCount: summaryCount,
    validCount: summaryCount,
    staleCount: 0,
    missingCount: 0,
    status,
    unindexedCount: 0,
    refreshStartedAt: state.refreshStartedAt,
    refreshCompletedAt: state.refreshCompletedAt,
    refreshError: state.refreshError,
  };
}

export function resetSessionIndexer(): void {
  runtimeByKey.clear();
}

export function resetSessionIndexerForTests(): void {
  resetSessionIndexer();
}
