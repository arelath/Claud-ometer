import type { SessionMessageDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';

const CONTEXT_FILE_DETAIL_KEYS = ['content.file.filePath', 'filePath', 'file_path', 'path', 'displayPath', 'filename'];
const CONTEXT_LOADED_LINE_DETAIL_KEYS = ['content.file.numLines', 'numLines'];
const CONTEXT_TOTAL_LINE_DETAIL_KEYS = ['content.file.totalLines', 'totalLines'];
const CONTEXT_START_LINE_DETAIL_KEYS = ['startLine'];
const CONTEXT_END_LINE_DETAIL_KEYS = ['endLine'];
const CONTEXT_TOOL_ID_DETAIL_KEYS = ['tool_use_id', 'toolUseId'];

export type ContextFileKind = 'in-context' | 'referenced';

export interface ContextLineRange {
  start: number;
  end: number;
}

export interface ContextFileInfo {
  fullPath: string;
  fileName: string;
  kind: ContextFileKind;
  attached: boolean;
  firstMessageIndex: number;
  messageIndexes: number[];
  loadedLines?: string;
  totalLines?: string;
  loadedRanges: ContextLineRange[];
}

export interface ContextFileGroups {
  inContext: ContextFileInfo[];
  referenced: ContextFileInfo[];
}

function getDetailKeyTail(key: string): string {
  const parts = key.split('.');
  return parts[parts.length - 1] || key;
}

function detailMatchesKey(key: string, candidates: string[]): boolean {
  const keyTail = getDetailKeyTail(key);
  return candidates.includes(key) || candidates.includes(keyTail);
}

function findPreferredDetail(
  details: SessionToolCallDisplay['details'],
  candidates: string[],
): SessionToolCallDisplay['details'][number] | undefined {
  for (const candidate of candidates) {
    const match = details.find(detail => detailMatchesKey(detail.key, [candidate]));
    if (match) return match;
  }
  return undefined;
}

function isLikelyFilePath(value: string): boolean {
  if (!value || value === '[]' || value === '""') return false;
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,12}$/.test(value);
}

function isBasenameOnly(value: string): boolean {
  return !/[\\/]/.test(value);
}

function getFileBasename(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export function parseContextLineCount(value?: string): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, '').trim();
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
}

function chooseBetterCount(current?: string, candidate?: string): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentCount = parseContextLineCount(current);
  const candidateCount = parseContextLineCount(candidate);
  if (currentCount == null || candidateCount == null) return current;
  return candidateCount > currentCount ? candidate : current;
}

function chooseBetterPath(current: string, candidate: string): string {
  if (isBasenameOnly(current) && !isBasenameOnly(candidate)) return candidate;
  return current;
}

export function buildContextLineRange(
  startLine: number | null,
  endLine: number | null,
  loadedLines: number | null,
): ContextLineRange | null {
  if (startLine == null && endLine == null) return null;

  let start = startLine;
  let end = endLine;

  if (start != null && end == null && loadedLines != null && loadedLines > 0) {
    end = start + loadedLines - 1;
  }

  if (end != null && start == null && loadedLines != null && loadedLines > 0) {
    start = end - loadedLines + 1;
  }

  if (start == null || end == null) return null;

  const normalizedStart = Math.max(1, Math.min(start, end));
  const normalizedEnd = Math.max(normalizedStart, Math.max(start, end));
  return { start: normalizedStart, end: normalizedEnd };
}

function clampContextLineRange(range: ContextLineRange, totalLines?: number): ContextLineRange | null {
  const maxLine = totalLines && totalLines > 0 ? totalLines : Number.MAX_SAFE_INTEGER;
  const start = Math.min(Math.max(1, range.start), maxLine);
  const end = Math.min(Math.max(start, range.end), maxLine);
  if (end < start) return null;
  return { start, end };
}

export function mergeContextLineRanges(ranges: ContextLineRange[], totalLines?: number): ContextLineRange[] {
  const normalized = ranges
    .map(range => clampContextLineRange(range, totalLines))
    .filter(Boolean) as ContextLineRange[];

  normalized.sort((left, right) => left.start - right.start || left.end - right.end);

  return normalized.reduce<ContextLineRange[]>((merged, range) => {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range });
      return merged;
    }

    previous.end = Math.max(previous.end, range.end);
    return merged;
  }, []);
}

export function getContextRangeLineCount(ranges: ContextLineRange[], totalLines?: number): number | null {
  const merged = mergeContextLineRanges(ranges, totalLines);
  if (merged.length === 0) return null;
  return merged.reduce((sum, range) => sum + range.end - range.start + 1, 0);
}

export function getContextLoadedLineCount(file: ContextFileInfo): number | null {
  const totalCount = parseContextLineCount(file.totalLines) ?? undefined;
  return getContextRangeLineCount(file.loadedRanges, totalCount) ?? parseContextLineCount(file.loadedLines);
}

export function formatContextRanges(ranges: ContextLineRange[]): string {
  if (ranges.length === 0) return '';
  return ranges.map(range => `L${range.start}-${range.end}`).join(', ');
}

export function getContextFilePathsText(files: ContextFileInfo[]): string {
  return files.map(file => file.fullPath).join('\n');
}

function sortContextFiles(files: ContextFileInfo[]): ContextFileInfo[] {
  return [...files].sort((left, right) => {
    const nameCompare = left.fileName.localeCompare(right.fileName);
    if (nameCompare !== 0) return nameCompare;
    return left.fullPath.localeCompare(right.fullPath);
  });
}

export function getContextFileGroups(messages: SessionMessageDisplay[]): ContextFileGroups {
  const files = new Map<string, ContextFileInfo>();
  const readToolById = new Map<string, {
    startLine: number | null;
    endLine: number | null;
  }>();

  const upsertCandidate = (
    rawValue: string | undefined,
    next: Omit<ContextFileInfo, 'fullPath' | 'fileName' | 'loadedRanges'> & { loadedRanges?: ContextLineRange[] },
  ) => {
    if (!rawValue) return;
    let candidate = rawValue.replace(/\r?\n/g, ' ').trim();
    if (!isLikelyFilePath(candidate)) return;

    let mapKey = candidate.toLowerCase();
    let existing = files.get(mapKey);

    if (!existing) {
      for (const [existingKey, existingValue] of files.entries()) {
        if (getFileBasename(existingValue.fullPath).toLowerCase() !== getFileBasename(candidate).toLowerCase()) continue;
        if (isBasenameOnly(existingValue.fullPath) && !isBasenameOnly(candidate)) {
          existing = existingValue;
          mapKey = existingKey;
          break;
        }
        if (!isBasenameOnly(existingValue.fullPath) && isBasenameOnly(candidate)) {
          existing = existingValue;
          mapKey = existingKey;
          candidate = existingValue.fullPath;
          break;
        }
      }
    }

    const fullPath = existing ? chooseBetterPath(existing.fullPath, candidate) : candidate;
    const merged: ContextFileInfo = {
      fullPath,
      fileName: getFileBasename(fullPath),
      kind: existing?.kind === 'in-context' || next.kind === 'in-context' ? 'in-context' : 'referenced',
      attached: Boolean(existing?.attached || next.attached),
      firstMessageIndex: Math.min(existing?.firstMessageIndex ?? next.firstMessageIndex, next.firstMessageIndex),
      messageIndexes: Array.from(new Set([...(existing?.messageIndexes || []), ...next.messageIndexes])).sort((left, right) => left - right),
      loadedLines: chooseBetterCount(existing?.loadedLines, next.loadedLines),
      totalLines: chooseBetterCount(existing?.totalLines, next.totalLines),
      loadedRanges: mergeContextLineRanges([...(existing?.loadedRanges || []), ...(next.loadedRanges || [])]),
    };

    files.delete(mapKey);
    files.set(fullPath.toLowerCase(), merged);
  };

  messages.forEach((message) => {
    for (const tool of message.toolCalls || []) {
      if (tool.name !== 'Read') continue;

      readToolById.set(tool.id, {
        startLine: parseContextLineCount(findPreferredDetail(tool.details, CONTEXT_START_LINE_DETAIL_KEYS)?.value),
        endLine: parseContextLineCount(findPreferredDetail(tool.details, CONTEXT_END_LINE_DETAIL_KEYS)?.value),
      });
    }
  });

  messages.forEach((message, messageIndex) => {
    for (const tool of message.toolCalls || []) {
      if (tool.name !== 'Read') continue;

      const fileDetail = findPreferredDetail(tool.details, CONTEXT_FILE_DETAIL_KEYS);
      const readTool = readToolById.get(tool.id);
      const loadedRange = buildContextLineRange(readTool?.startLine ?? null, readTool?.endLine ?? null, null);

      upsertCandidate(fileDetail?.value, {
        kind: 'referenced',
        attached: false,
        firstMessageIndex: messageIndex,
        messageIndexes: [messageIndex],
        loadedRanges: loadedRange ? [loadedRange] : [],
      });
    }

    for (const block of message.blocks || []) {
      const fileDetail = findPreferredDetail(block.details, CONTEXT_FILE_DETAIL_KEYS);
      if (!fileDetail) continue;

      const loadedLines = findPreferredDetail(block.details, CONTEXT_LOADED_LINE_DETAIL_KEYS)?.value;
      const totalLines = findPreferredDetail(block.details, CONTEXT_TOTAL_LINE_DETAIL_KEYS)?.value;
      const loadedCount = parseContextLineCount(loadedLines);
      const totalCount = parseContextLineCount(totalLines);
      const toolUseId = findPreferredDetail(block.details, CONTEXT_TOOL_ID_DETAIL_KEYS)?.value;
      const readTool = toolUseId ? readToolById.get(toolUseId) : undefined;
      const startLine = parseContextLineCount(findPreferredDetail(block.details, CONTEXT_START_LINE_DETAIL_KEYS)?.value) ?? readTool?.startLine ?? null;
      const endLine = parseContextLineCount(findPreferredDetail(block.details, CONTEXT_END_LINE_DETAIL_KEYS)?.value) ?? readTool?.endLine ?? null;
      const loadedRange =
        buildContextLineRange(startLine, endLine, loadedCount) ||
        (readTool && loadedCount != null && totalCount != null ? { start: 1, end: Math.min(loadedCount, totalCount) } : null);
      const attached = block.type === 'event' && block.title.startsWith('Attachment:');
      const inContext = attached || Boolean(block.content) || Boolean(loadedLines) || Boolean(totalLines);

      upsertCandidate(fileDetail.value, {
        kind: inContext ? 'in-context' : 'referenced',
        attached,
        firstMessageIndex: messageIndex,
        messageIndexes: [messageIndex],
        loadedLines,
        totalLines,
        loadedRanges: loadedRange ? [loadedRange] : [],
      });
    }
  });

  const allFiles = Array.from(files.values());
  return {
    inContext: sortContextFiles(allFiles.filter(file => file.kind === 'in-context')),
    referenced: sortContextFiles(allFiles.filter(file => file.kind === 'referenced')),
  };
}
