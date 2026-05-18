import { createHash } from 'crypto';
import type { AgentDataProvider } from './provider';
import {
  getSessionSummaryCacheStatus as buildCacheStatus,
  isSummaryValidForSource,
  mergeUpdatedSummaries,
  readSessionSummaryCache,
  sourceSummaryCacheKey,
  summaryCacheKey,
  writeSessionSummaryCache,
  clearSessionSummaryCache as clearPersistentSessionSummaryCache,
  type SessionSummaryCacheStatus,
} from './session-summary-cache';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from './session-summary';

interface MemoEntry {
  key: string;
  value: CachedSessionSummary[];
}

const memo = new Map<string, MemoEntry>();
const inflight = new Map<string, Promise<CachedSessionSummary[]>>();
const SUMMARY_BUILD_CONCURRENCY = 1;

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function providerHasSummarySupport(provider: AgentDataProvider): boolean {
  return Boolean(provider.parserVersion && provider.discoverSessionSources && provider.buildSessionSummary);
}

async function discoverSources(providers: AgentDataProvider[]): Promise<SessionSummarySource[]> {
  const results: SessionSummarySource[][] = [];
  for (const provider of providers.filter(providerHasSummarySupport)) {
    await yieldToEventLoop();
    results.push(await provider.discoverSessionSources!());
  }
  return results.flat().sort((left, right) => {
    const providerCompare = left.provider.localeCompare(right.provider);
    if (providerCompare) return providerCompare;
    return left.sourceFilePath.localeCompare(right.sourceFilePath);
  });
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

async function buildSummaries(providers: AgentDataProvider[], sources: SessionSummarySource[]): Promise<CachedSessionSummary[]> {
  const cache = readSessionSummaryCache();
  const cachedByKey = new Map(cache.summaries.map(summary => [summaryCacheKey(summary), summary]));
  const providerByKind = new Map(providers.map(provider => [provider.kind, provider]));

  const updatedSummaries = (await mapWithConcurrency(sources, SUMMARY_BUILD_CONCURRENCY, async (source) => {
    const cached = cachedByKey.get(sourceSummaryCacheKey(source));
    if (cached && isSummaryValidForSource(cached, source)) {
      return cached;
    }

    const provider = providerByKind.get(source.provider);
    return provider?.buildSessionSummary ? provider.buildSessionSummary(source) : null;
  })).filter((summary): summary is CachedSessionSummary => Boolean(summary));

  writeSessionSummaryCache({
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    summaries: mergeUpdatedSummaries(cache.summaries, updatedSummaries, sources),
  });

  return updatedSummaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function getCachedSessionSummaries(providers: AgentDataProvider[]): Promise<CachedSessionSummary[]> {
  const supportedProviders = providers.filter(providerHasSummarySupport);
  if (supportedProviders.length === 0) return [];

  const sources = await discoverSources(supportedProviders);
  const key = manifestKey(supportedProviders, sources);
  const memoKey = supportedProviders.map(provider => provider.kind).sort().join(',');
  const cached = memo.get(memoKey);
  if (cached?.key === key) return cached.value;

  const running = inflight.get(key);
  if (running) return running;

  const promise = buildSummaries(supportedProviders, sources)
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
  const sources = await discoverSources(supportedProviders);
  const summaries = await mapWithConcurrency(sources, SUMMARY_BUILD_CONCURRENCY, async (source) => {
    const provider = supportedProviders.find(item => item.kind === source.provider);
    return provider!.buildSessionSummary!(source);
  });
  writeSessionSummaryCache({
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    summaries: mergeUpdatedSummaries(readSessionSummaryCache().summaries, summaries, sources),
  });
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
}

export function resetSessionSummaryStoreForTests(): void {
  resetSessionSummaryStore();
}
