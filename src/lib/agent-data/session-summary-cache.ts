import fs from 'fs';
import path from 'path';
import { getImportDir } from './data-source';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from './session-summary';
import type { AgentKind } from './types';

export interface SessionSummaryCacheFile {
  cacheVersion: number;
  generatedAt: string;
  summaries: CachedSessionSummary[];
}

export interface SessionSummaryCacheStatus {
  cachePath: string;
  exists: boolean;
  generatedAt: string;
  summaryCount: number;
  activeProviders: AgentKind[];
  sourceCount: number;
  validCount: number;
  staleCount: number;
  missingCount: number;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function getSessionSummaryCacheDir(): string {
  return process.env.CLAUD_OMETER_CACHE_DIR?.trim() || path.join(getImportDir(), 'cache');
}

export function getSessionSummaryCachePath(): string {
  return path.join(getSessionSummaryCacheDir(), 'agent-session-summary-v3.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseCacheFile(value: unknown): SessionSummaryCacheFile | null {
  if (!isRecord(value) || value.cacheVersion !== SESSION_SUMMARY_CACHE_VERSION || !Array.isArray(value.summaries)) {
    return null;
  }
  return {
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    summaries: value.summaries.filter(isRecord) as unknown as CachedSessionSummary[],
  };
}

export function readSessionSummaryCache(cachePath = getSessionSummaryCachePath()): SessionSummaryCacheFile {
  if (!fs.existsSync(cachePath)) {
    return { cacheVersion: SESSION_SUMMARY_CACHE_VERSION, generatedAt: '', summaries: [] };
  }

  try {
    const parsed = parseCacheFile(JSON.parse(fs.readFileSync(cachePath, 'utf-8')));
    return parsed || { cacheVersion: SESSION_SUMMARY_CACHE_VERSION, generatedAt: '', summaries: [] };
  } catch {
    return { cacheVersion: SESSION_SUMMARY_CACHE_VERSION, generatedAt: '', summaries: [] };
  }
}

export function writeSessionSummaryCache(cache: SessionSummaryCacheFile, cachePath = getSessionSummaryCachePath()): void {
  ensureDir(path.dirname(cachePath));
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({
    cacheVersion: SESSION_SUMMARY_CACHE_VERSION,
    generatedAt: cache.generatedAt || new Date().toISOString(),
    summaries: cache.summaries,
  }, null, 2));
  fs.renameSync(tmpPath, cachePath);
}

export function clearSessionSummaryCache(cachePath = getSessionSummaryCachePath()): void {
  if (fs.existsSync(cachePath)) fs.rmSync(cachePath, { force: true });
}

export function sourceCacheKey(provider: AgentKind, sourceFilePath: string): string {
  return `${provider}:${sourceFilePath}`;
}

export function summaryCacheKey(summary: Pick<CachedSessionSummary, 'provider' | 'sourceFilePath'>): string {
  return sourceCacheKey(summary.provider, summary.sourceFilePath);
}

export function sourceSummaryCacheKey(source: Pick<SessionSummarySource, 'provider' | 'sourceFilePath'>): string {
  return sourceCacheKey(source.provider, source.sourceFilePath);
}

export function isSummaryValidForSource(summary: CachedSessionSummary, source: SessionSummarySource): boolean {
  return summary.cacheVersion === SESSION_SUMMARY_CACHE_VERSION
    && summary.provider === source.provider
    && summary.parserVersion === source.parserVersion
    && summary.sourceFilePath === source.sourceFilePath
    && summary.sourceSignature.size === source.sourceSignature.size
    && summary.sourceSignature.mtimeMs === source.sourceSignature.mtimeMs;
}

export function mergeUpdatedSummaries(
  existing: CachedSessionSummary[],
  updated: CachedSessionSummary[],
  discoveredSources: SessionSummarySource[],
): CachedSessionSummary[] {
  const touchedProviders = new Set(discoveredSources.map(source => source.provider));
  const discoveredKeys = new Set(discoveredSources.map(sourceSummaryCacheKey));
  const updatedByKey = new Map(updated.map(summary => [summaryCacheKey(summary), summary]));
  const merged = new Map<string, CachedSessionSummary>();

  for (const summary of existing) {
    const key = summaryCacheKey(summary);
    if (updatedByKey.has(key)) continue;
    if (touchedProviders.has(summary.provider) && !discoveredKeys.has(key)) continue;
    merged.set(key, summary);
  }

  for (const summary of updated) {
    merged.set(summaryCacheKey(summary), summary);
  }

  return Array.from(merged.values()).sort((left, right) => {
    const providerCompare = left.provider.localeCompare(right.provider);
    if (providerCompare) return providerCompare;
    return left.sourceFilePath.localeCompare(right.sourceFilePath);
  });
}

export function getSessionSummaryCacheStatus(
  activeProviders: AgentKind[],
  sources: SessionSummarySource[],
  cache = readSessionSummaryCache(),
): SessionSummaryCacheStatus {
  const summariesByKey = new Map(cache.summaries.map(summary => [summaryCacheKey(summary), summary]));
  let validCount = 0;
  let staleCount = 0;

  for (const source of sources) {
    const summary = summariesByKey.get(sourceSummaryCacheKey(source));
    if (!summary) continue;
    if (isSummaryValidForSource(summary, source)) {
      validCount++;
    } else {
      staleCount++;
    }
  }

  const sourceKeys = new Set(sources.map(sourceSummaryCacheKey));
  const missingCount = cache.summaries.filter(summary => activeProviders.includes(summary.provider) && !sourceKeys.has(summaryCacheKey(summary))).length;

  return {
    cachePath: getSessionSummaryCachePath(),
    exists: fs.existsSync(getSessionSummaryCachePath()),
    generatedAt: cache.generatedAt,
    summaryCount: cache.summaries.length,
    activeProviders,
    sourceCount: sources.length,
    validCount,
    staleCount,
    missingCount,
  };
}
