import type { SessionSummarySource } from './session-summary';

export const SESSION_SOURCE_STABILITY_GRACE_MS = 20 * 60 * 1000;

export function isSessionSourceRecentlyModified(
  source: Pick<SessionSummarySource, 'sourceSignature'>,
  nowMs = Date.now(),
): boolean {
  const mtimeMs = source.sourceSignature.mtimeMs;
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return false;
  return nowMs - mtimeMs < SESSION_SOURCE_STABILITY_GRACE_MS;
}

export function getStableSessionSources<T extends Pick<SessionSummarySource, 'sourceSignature'>>(
  sources: T[],
  nowMs = Date.now(),
): T[] {
  return sources.filter(source => !isSessionSourceRecentlyModified(source, nowMs));
}

export function getRecentSessionSources<T extends Pick<SessionSummarySource, 'sourceSignature'>>(
  sources: T[],
  nowMs = Date.now(),
): T[] {
  return sources.filter(source => isSessionSourceRecentlyModified(source, nowMs));
}
