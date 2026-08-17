import type { AgentDataProvider } from './provider';
import { requestIndexerCommand } from './indexer-client';
import type { IndexerRunAccepted } from './indexer-protocol';
import type { SessionIndexRefreshMetrics } from './session-summary-store';
import {
  getSessionSummaryIndexPath,
  getSessionSummaryIndexReadSignature,
  readSessionSummaryIndexCacheForProviders,
  readSessionSummaryIndexMetadata,
} from './session-summary-sqlite-store';
import type { SessionSummaryCacheStatus } from './session-summary-cache';
import type { CachedSessionSummary } from './session-summary';
import type { AgentKind } from './types';

export type SessionIndexState = 'fresh' | 'stale' | 'refreshing' | 'empty' | 'error';

export interface SessionIndexStatus extends SessionSummaryCacheStatus {
  status: SessionIndexState;
  state: 'ready' | 'building' | 'degraded' | 'paused';
  revision: number;
  statusRevision: number;
  lastCommittedAt?: string;
  queueDepth: number;
  activeSources: number;
  pendingSources: number;
  failedSources: number;
  initialBuild: boolean;
  totalSources?: number;
  processedSources?: number;
  committedSources?: number;
  currentProvider?: AgentKind;
  heapUsedBytes?: number;
  rssBytes?: number;
  run?: { id: string; state: 'queued' | 'running' | 'completed' | 'failed'; startedAt?: string; completedAt?: string };
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

const REFRESH_CHECK_THROTTLE_MS = 15_000;
const lastRefreshRequestByKey = new Map<string, number>();
const snapshotMemo = new Map<string, IndexedSessionSnapshot>();

function supportedProviders(providers: AgentDataProvider[]): AgentDataProvider[] {
  return providers.filter(provider => Boolean(provider.parserVersion));
}

function runtimeKey(providers: AgentDataProvider[]): string {
  return supportedProviders(providers)
    .map(provider => `${provider.kind}:${provider.parserVersion || 'none'}`)
    .sort()
    .join(',');
}

function providerKinds(providers: AgentDataProvider[]) {
  return supportedProviders(providers).map(provider => provider.kind);
}

function readIndexedSnapshot(providers: AgentDataProvider[]): IndexedSessionSnapshot {
  const kinds = providerKinds(providers);
  const signature = `${runtimeKey(providers)}:${getSessionSummaryIndexReadSignature()}`;
  const cached = snapshotMemo.get(signature);
  if (cached) return cached;
  const summaries = readSessionSummaryIndexCacheForProviders(kinds).summaries
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const snapshot = { summaries, signature };
  if (snapshotMemo.size > 12) snapshotMemo.clear();
  snapshotMemo.set(signature, snapshot);
  return snapshot;
}

export function getIndexedSessionSummaries(providers: AgentDataProvider[]): CachedSessionSummary[] {
  return readIndexedSnapshot(providers).summaries;
}

export function getIndexedSessionSnapshot(providers: AgentDataProvider[]): IndexedSessionSnapshot {
  return readIndexedSnapshot(providers);
}

export async function getIndexedSessionSummariesWithFallbacks(providers: AgentDataProvider[]): Promise<CachedSessionSummary[]> {
  ensureSessionIndexRefresh(providers);
  return getIndexedSessionSummaries(providers);
}

export function ensureSessionIndexRefresh(providers: AgentDataProvider[]): void {
  const kinds = providerKinds(providers);
  if (kinds.length === 0) return;
  const key = runtimeKey(providers);
  const now = Date.now();
  const previous = lastRefreshRequestByKey.get(key);
  if (previous && now - previous < REFRESH_CHECK_THROTTLE_MS) return;
  lastRefreshRequestByKey.set(key, now);
  void requestIndexerCommand<IndexerRunAccepted>('reconcile', kinds).catch(() => {
    // The durable status reports sidecar failures. Reads continue using the last committed index.
  });
}

export function rebuildSessionIndex(providers: AgentDataProvider[]): Promise<IndexerRunAccepted> {
  return requestIndexerCommand<IndexerRunAccepted>('rebuild', providerKinds(providers));
}

export function getQuickSessionIndexStatus(providers: AgentDataProvider[]): SessionIndexStatus {
  const refreshProviders = supportedProviders(providers);
  const kinds = providerKinds(refreshProviders);
  const parserVersionByProvider = new Map(refreshProviders.map(provider => [provider.kind, provider.parserVersion || 'none']));
  const metadata = readSessionSummaryIndexMetadata(kinds);
  const staleCount = metadata.providerVersions.reduce((count, item) => (
    count + (item.parserVersion === parserVersionByProvider.get(item.provider) ? 0 : item.count)
  ), 0);
  const validCount = Math.max(metadata.summaryCount - staleCount, 0);
  const runtime = metadata.runtime;
  const state = runtime?.state || (metadata.summaryCount > 0 ? 'ready' : 'building');
  const status: SessionIndexState = state === 'degraded'
    ? 'error'
    : state === 'building' && metadata.summaryCount === 0
      ? 'refreshing'
      : metadata.summaryCount === 0 && kinds.length > 0
        ? 'empty'
        : staleCount > 0
          ? 'stale'
          : 'fresh';

  return {
    cachePath: getSessionSummaryIndexPath(),
    exists: metadata.exists,
    generatedAt: metadata.generatedAt,
    summaryCount: metadata.summaryCount,
    activeProviders: kinds,
    sourceCount: metadata.sourceCount,
    validCount,
    staleCount,
    missingCount: 0,
    status,
    state,
    revision: metadata.revision,
    statusRevision: metadata.statusRevision || 0,
    lastCommittedAt: runtime?.lastCommittedAt,
    queueDepth: runtime?.queueDepth || 0,
    activeSources: runtime?.activeSources || 0,
    pendingSources: runtime?.pendingSources || 0,
    failedSources: runtime?.failedSources || 0,
    initialBuild: runtime?.initialBuild ?? metadata.summaryCount === 0,
    totalSources: runtime?.totalSources,
    processedSources: runtime?.processedSources,
    committedSources: runtime?.committedSources,
    currentProvider: runtime?.currentProvider,
    heapUsedBytes: runtime?.heapUsedBytes,
    rssBytes: runtime?.rssBytes,
    run: runtime?.run,
    unindexedCount: Math.max(runtime?.pendingSources || 0, 0),
    refreshStartedAt: runtime?.run?.startedAt,
    refreshCompletedAt: runtime?.run?.completedAt,
    refreshError: runtime?.lastError,
  };
}

export async function getSessionIndexStatus(providers: AgentDataProvider[]): Promise<SessionIndexStatus> {
  return getQuickSessionIndexStatus(providers);
}

export function resetSessionIndexer(): void {
  lastRefreshRequestByKey.clear();
  snapshotMemo.clear();
}

export function resetSessionIndexerForTests(): void {
  resetSessionIndexer();
}
