import type { SessionMessageBlockDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';
import { formatDisplayPath } from '@/lib/path-utils';
import { detailMatchesKey, getDetailKeyTail, normalizeDisplayNewlines } from '@/lib/string-utils';
import {
  ANTHROPIC_CODE_PATH_DETAIL_KEYS,
  ANTHROPIC_FILE_DETAIL_KEYS,
  ANTHROPIC_MONOSPACE_DETAIL_KEYS,
} from '@/config/anthropic-schema';
import type { PreviewTone } from './session-render-context';

export function usesMonospaceDetail(key: string): boolean {
  return (ANTHROPIC_MONOSPACE_DETAIL_KEYS as readonly string[]).includes(getDetailKeyTail(key));
}

export function findDetail(
  details: SessionToolCallDisplay['details'],
  candidates: string[],
): SessionToolCallDisplay['details'][number] | undefined {
  return details.find(detail => detailMatchesKey(detail.key, candidates));
}

export function findPreferredDetail(
  details: SessionToolCallDisplay['details'],
  candidates: string[],
): SessionToolCallDisplay['details'][number] | undefined {
  for (const candidate of candidates) {
    const match = details.find(detail => detailMatchesKey(detail.key, [candidate]));
    if (match) return match;
  }
  return undefined;
}

export function omitDetails(
  details: SessionToolCallDisplay['details'],
  candidates: string[],
): SessionToolCallDisplay['details'] {
  return details.filter(detail => !detailMatchesKey(detail.key, candidates));
}

export function getCodePathDetailValue(details: SessionToolCallDisplay['details']): string | undefined {
  return findPreferredDetail(details, [...ANTHROPIC_CODE_PATH_DETAIL_KEYS])?.value;
}

export function isPathDetailKey(key: string): boolean {
  return detailMatchesKey(key, [...ANTHROPIC_FILE_DETAIL_KEYS, 'paths']);
}

export function formatDisplayValue(key: string, value: string, projectRoot?: string): string {
  const normalized = normalizeDisplayNewlines(value);
  if (!isPathDetailKey(key)) return normalized;
  return formatDisplayPath(normalized, projectRoot);
}

export function parseExitCodeValue(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const direct = trimmed.match(/^-?\d+$/);
  if (direct) return Number.parseInt(direct[0], 10);

  const labeled = trimmed.match(/\bexit\s+code\b\s*:?\s*(-?\d+)/i) || trimmed.match(/\bexit\b\s*:?\s*(-?\d+)/i);
  return labeled ? Number.parseInt(labeled[1], 10) : null;
}

export function getExitCodeFromDetails(details: SessionToolCallDisplay['details']): number | null {
  const detail = findDetail(details, ['exitCode']);
  return parseExitCodeValue(detail?.value);
}

export function getOutputExitCode(blocks: SessionMessageBlockDisplay[], content: string): number | null {
  for (const block of blocks) {
    const exitCode = getExitCodeFromDetails(block.details);
    if (exitCode !== null) return exitCode;
  }
  return parseExitCodeValue(content);
}

export function getOutputTone(exitCode: number | null): PreviewTone {
  if (exitCode === null) return 'unknown';
  return exitCode === 0 ? 'success' : 'error';
}
