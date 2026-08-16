import {
  isSummaryValidForSource,
  sourceSummaryCacheKey,
  summaryCacheKey,
} from './session-summary-cache';
import {
  SESSION_SUMMARY_CACHE_VERSION,
  type CachedSessionSummary,
  type SessionSummarySource,
} from './session-summary';
import type {
  IncrementalSessionSummarySupportByProvider,
  SourceParseCheckpoint,
} from './session-parse-checkpoint';
import { isSessionSourceRecentlyModified } from './source-stability';
import type { AgentKind } from './types';

export interface RefreshPlan {
  valid: SessionSummarySource[];
  recent: SessionSummarySource[];
  fullBuild: SessionSummarySource[];
  incrementalBuild: SessionSummarySource[];
  missingCachedKeys: string[];
  touchedProviders: AgentKind[];
}

export interface RefreshPlanInput {
  sources: SessionSummarySource[];
  cachedSummaries: CachedSessionSummary[];
  touchedProviders: AgentKind[];
  checkpointsByKey?: Map<string, SourceParseCheckpoint>;
  incrementalSupport?: IncrementalSessionSummarySupportByProvider;
  force?: boolean;
  nowMs?: number;
}

function canIncrementallyBuild(
  source: SessionSummarySource,
  cached: CachedSessionSummary | undefined,
  checkpoint: SourceParseCheckpoint | undefined,
  incrementalSupport: IncrementalSessionSummarySupportByProvider,
): boolean {
  const support = incrementalSupport[source.provider];
  if (!support || !cached || !checkpoint) return false;
  if (cached.isPartial && !support.supportsPartialPromotion) return false;
  const sourceKey = sourceSummaryCacheKey(source);
  return cached.cacheVersion === SESSION_SUMMARY_CACHE_VERSION
    && cached.provider === source.provider
    && cached.parserVersion === source.parserVersion
    && cached.sourceFilePath === source.sourceFilePath
    && checkpoint.sourceKey === sourceKey
    && checkpoint.provider === source.provider
    && checkpoint.parserVersion === source.parserVersion
    && checkpoint.checkpointVersion === support.checkpointVersion
    && checkpoint.sourceFilePath === source.sourceFilePath
    && checkpoint.sourceSize === cached.sourceSignature.size
    && checkpoint.sourceMtimeMs === cached.sourceSignature.mtimeMs
    && checkpoint.lastCompleteOffset <= checkpoint.sourceSize
    && source.sourceSignature.size >= checkpoint.sourceSize
    && source.sourceSignature.mtimeMs >= checkpoint.sourceMtimeMs
    && checkpoint.lastCompleteOffset <= source.sourceSignature.size;
}

export function createSessionRefreshPlan({
  sources,
  cachedSummaries,
  touchedProviders,
  checkpointsByKey = new Map(),
  incrementalSupport = {},
  force = false,
  nowMs = Date.now(),
}: RefreshPlanInput): RefreshPlan {
  const cachedByKey = new Map(cachedSummaries.map(summary => [summaryCacheKey(summary), summary]));
  const discoveredKeys = new Set(sources.map(sourceSummaryCacheKey));
  const touchedProviderSet = new Set(touchedProviders);
  const plan: RefreshPlan = {
    valid: [],
    recent: [],
    fullBuild: [],
    incrementalBuild: [],
    missingCachedKeys: [],
    touchedProviders,
  };

  for (const source of sources) {
    const cached = cachedByKey.get(sourceSummaryCacheKey(source));
    if (!force && cached && isSummaryValidForSource(cached, source)) {
      plan.valid.push(source);
      continue;
    }

    if (!force && canIncrementallyBuild(source, cached, checkpointsByKey.get(sourceSummaryCacheKey(source)), incrementalSupport)) {
      plan.incrementalBuild.push(source);
      continue;
    }

    if (isSessionSourceRecentlyModified(source, nowMs)) {
      plan.recent.push(source);
      continue;
    }

    plan.fullBuild.push(source);
  }

  for (const summary of cachedSummaries) {
    if (!touchedProviderSet.has(summary.provider)) continue;
    const key = summaryCacheKey(summary);
    if (!discoveredKeys.has(key)) plan.missingCachedKeys.push(key);
  }

  return plan;
}
