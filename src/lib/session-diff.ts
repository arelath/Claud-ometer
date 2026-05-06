import type { SessionMessageDisplay, SessionToolCallDetail } from '@/lib/claude-data/types';
import { diffArrays } from 'diff';
import { normalizeDisplayPath } from '@/lib/path-utils';
import { detailMatchesKey, parseLineNumber } from '@/lib/string-utils';

export type DiffFileStatus = 'modified' | 'added' | 'deleted';
export type DiffRowType = 'context' | 'add' | 'remove';

export interface SessionDiffRow {
  type: DiffRowType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
}

export interface SessionDiffHunk {
  id: string;
  filePath: string;
  toolName: string;
  toolId: string;
  messageIndex: number;
  timestamp: string;
  location?: string;
  oldStartLine: number | null;
  newStartLine: number | null;
  oldLineCount: number;
  newLineCount: number;
  addedLines: number;
  removedLines: number;
  rows: SessionDiffRow[];
}

export interface SessionDiffFile {
  path: string;
  addedLines: number;
  removedLines: number;
  editCount: number;
  status: DiffFileStatus;
  hunks: SessionDiffHunk[];
  editHunks: SessionDiffHunk[];
}

export interface SessionDiffSummary {
  files: SessionDiffFile[];
  fileCount: number;
  addedLines: number;
  removedLines: number;
  editCount: number;
}

const PATH_DETAIL_KEYS = ['file_path', 'filePath', 'path', 'displayPath', 'filename'];
const START_LINE_DETAIL_KEYS = ['startLine', 'start_line', 'lineStart', 'line_start', 'offset'];

interface FileSnapshot {
  path: string;
  startLine: number;
  content: string;
  messageIndex: number;
}

interface DiffEditRecord {
  path: string;
  oldText: string;
  newText: string;
  startLine: number | null;
  hunk: SessionDiffHunk;
}

function findDetail(details: SessionToolCallDetail[], candidates: string[]): SessionToolCallDetail | undefined {
  return details.find(detail => detailMatchesKey(detail.key, candidates));
}

function normalizePath(pathValue: string): string {
  return normalizeDisplayPath(pathValue).replace(/^\.\//, '');
}

function normalizeTextLines(value: string): string[] {
  const normalized = value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n?/g, '\n');
  if (!normalized) return [];
  return normalized.split('\n');
}

function getStartLineFromDetails(details: SessionToolCallDetail[]): number | null {
  for (const key of START_LINE_DETAIL_KEYS) {
    const detail = findDetail(details, [key]);
    const lineNumber = parseLineNumber(detail?.value);
    if (lineNumber == null) continue;
    return Math.max(1, lineNumber);
  }
  return null;
}

function getToolPath(details: SessionToolCallDetail[]): string | null {
  const value = findDetail(details, PATH_DETAIL_KEYS)?.value;
  if (!value) return null;
  const firstLine = value.split(/\r\n?|\n/).find(line => line.trim());
  return firstLine ? normalizePath(firstLine.trim()) : null;
}

function getReadToolRanges(messages: SessionMessageDisplay[]): Map<string, { path: string; startLine: number | null }> {
  const ranges = new Map<string, { path: string; startLine: number | null }>();

  for (const message of messages) {
    for (const tool of message.toolCalls || []) {
      if (!tool.id || tool.name !== 'Read') continue;
      const path = getToolPath(tool.details);
      if (!path) continue;
      ranges.set(tool.id, {
        path,
        startLine: getStartLineFromDetails(tool.details) ?? 1,
      });
    }
  }

  return ranges;
}

function getFileSnapshots(messages: SessionMessageDisplay[]): FileSnapshot[] {
  const readToolRanges = getReadToolRanges(messages);
  const snapshots: FileSnapshot[] = [];

  messages.forEach((message, messageIndex) => {
    for (const block of message.blocks || []) {
      if (block.type !== 'tool-result' || !block.content) continue;

      const toolUseId = findDetail(block.details, ['tool_use_id', 'toolUseId'])?.value;
      const readRange = toolUseId ? readToolRanges.get(toolUseId) : undefined;
      const path = getToolPath(block.details) || readRange?.path;
      const startLine = getStartLineFromDetails(block.details) ?? readRange?.startLine ?? 1;

      if (!path || startLine == null) continue;
      snapshots.push({
        path,
        startLine,
        content: block.content,
        messageIndex,
      });
    }
  });

  return snapshots;
}

function normalizeLineForMatch(line: string): string {
  return line.replace(/^\s*\d+\s*(?::|\||\s{2,})\s?/, '');
}

function findLineSequenceIndex(haystackLines: string[], needleLines: string[]): number {
  if (needleLines.length === 0) return 0;
  if (needleLines.length > haystackLines.length) return -1;

  for (let startIndex = 0; startIndex <= haystackLines.length - needleLines.length; startIndex += 1) {
    let exact = true;
    for (let offset = 0; offset < needleLines.length; offset += 1) {
      if (haystackLines[startIndex + offset] !== needleLines[offset]) {
        exact = false;
        break;
      }
    }
    if (exact) return startIndex;
  }

  const normalizedHaystack = haystackLines.map(normalizeLineForMatch);
  const normalizedNeedle = needleLines.map(normalizeLineForMatch);
  for (let startIndex = 0; startIndex <= normalizedHaystack.length - normalizedNeedle.length; startIndex += 1) {
    let matched = true;
    for (let offset = 0; offset < normalizedNeedle.length; offset += 1) {
      if (normalizedHaystack[startIndex + offset] !== normalizedNeedle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return startIndex;
  }

  return -1;
}

function inferStartLineFromSnapshots(
  filePath: string,
  oldText: string,
  messageIndex: number,
  snapshots: FileSnapshot[],
): number | null {
  const oldLines = normalizeTextLines(oldText);
  if (oldLines.length === 0) return 1;

  const matchingSnapshots = snapshots
    .filter(snapshot => snapshot.path === filePath && snapshot.messageIndex < messageIndex)
    .sort((left, right) => right.messageIndex - left.messageIndex);

  for (const snapshot of matchingSnapshots) {
    const matchIndex = findLineSequenceIndex(normalizeTextLines(snapshot.content), oldLines);
    if (matchIndex >= 0) return snapshot.startLine + matchIndex;
  }

  return null;
}

function inferStartLineFromPreviousEdits(
  filePath: string,
  oldText: string,
  records: DiffEditRecord[],
): number | null {
  const oldLines = normalizeTextLines(oldText);
  if (oldLines.length === 0) return 1;

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.path !== filePath || record.startLine == null) continue;
    const matchIndex = findLineSequenceIndex(normalizeTextLines(record.newText), oldLines);
    if (matchIndex >= 0) return record.startLine + matchIndex;
  }

  return null;
}

function buildSimpleLineDiff(oldLines: string[], newLines: string[]): { type: DiffRowType; text: string }[] {
  return diffArrays(oldLines, newLines).flatMap(part => {
    const type: DiffRowType = part.added ? 'add' : part.removed ? 'remove' : 'context';
    return part.value.map(text => ({ type, text }));
  });
}

function buildDiffRows(oldText: string, newText: string, startLine: number | null): SessionDiffRow[] {
  const simpleRows = buildSimpleLineDiff(normalizeTextLines(oldText), normalizeTextLines(newText));
  let oldLineNumber = startLine;
  let newLineNumber = startLine;

  return simpleRows.map(row => {
    if (row.type === 'add') {
      const diffRow: SessionDiffRow = {
        type: 'add',
        oldLineNumber: null,
        newLineNumber,
        text: row.text,
      };
      if (newLineNumber != null) newLineNumber += 1;
      return diffRow;
    }

    if (row.type === 'remove') {
      const diffRow: SessionDiffRow = {
        type: 'remove',
        oldLineNumber,
        newLineNumber: null,
        text: row.text,
      };
      if (oldLineNumber != null) oldLineNumber += 1;
      return diffRow;
    }

    const diffRow: SessionDiffRow = {
      type: 'context',
      oldLineNumber,
      newLineNumber,
      text: row.text,
    };
    if (oldLineNumber != null) oldLineNumber += 1;
    if (newLineNumber != null) newLineNumber += 1;
    return diffRow;
  });
}

function getFileStatus(addedLines: number, removedLines: number): DiffFileStatus {
  if (addedLines > 0 && removedLines === 0) return 'added';
  if (removedLines > 0 && addedLines === 0) return 'deleted';
  return 'modified';
}

export function getSessionDiffSummary(messages: SessionMessageDisplay[]): SessionDiffSummary {
  const snapshots = getFileSnapshots(messages);
  const recordsByFile = new Map<string, DiffEditRecord[]>();
  const allRecords: DiffEditRecord[] = [];

  messages.forEach((message, messageIndex) => {
    for (const tool of message.toolCalls || []) {
      if (tool.artifact?.kind !== 'diff') continue;

      const filePath = getToolPath(tool.details);
      const oldText = tool.artifact.oldText || '';
      const newText = tool.artifact.newText || '';
      if (!filePath || (!oldText && !newText)) continue;

      const explicitStartLine = getStartLineFromDetails(tool.details)
        ?? parseLineNumber(tool.artifact.location)
        ?? null;
      const startLine = explicitStartLine
        ?? inferStartLineFromPreviousEdits(filePath, oldText, allRecords)
        ?? inferStartLineFromSnapshots(filePath, oldText, messageIndex, snapshots);
      const rows = buildDiffRows(oldText, newText, startLine);
      const addedLines = rows.filter(row => row.type === 'add').length;
      const removedLines = rows.filter(row => row.type === 'remove').length;
      const oldLineCount = rows.filter(row => row.type !== 'add').length;
      const newLineCount = rows.filter(row => row.type !== 'remove').length;

      const hunk: SessionDiffHunk = {
        id: `${messageIndex}-${tool.id || tool.name}-${filePath}`,
        filePath,
        toolName: tool.name,
        toolId: tool.id,
        messageIndex,
        timestamp: message.timestamp,
        location: tool.artifact.location || (startLine != null ? `line ${startLine}` : undefined),
        oldStartLine: startLine,
        newStartLine: startLine,
        oldLineCount,
        newLineCount,
        addedLines,
        removedLines,
        rows,
      };

      const record = { path: filePath, oldText, newText, startLine, hunk };
      allRecords.push(record);
      recordsByFile.set(filePath, [...(recordsByFile.get(filePath) || []), record]);
    }
  });

  const files = Array.from(recordsByFile.entries())
    .map(([path, records]) => buildDiffFile(path, records))
    .sort((left, right) => right.addedLines + right.removedLines - (left.addedLines + left.removedLines) || left.path.localeCompare(right.path));

  return {
    files,
    fileCount: files.length,
    addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    removedLines: files.reduce((sum, file) => sum + file.removedLines, 0),
    editCount: files.reduce((sum, file) => sum + file.editCount, 0),
  };
}

interface NetDiffRegion {
  startLine: number | null;
  originalText: string[];
  currentText: string[];
  edits: DiffEditRecord[];
}

function getRecordOldLineCount(record: DiffEditRecord): number {
  return normalizeTextLines(record.oldText).length;
}

function canMergeRecordIntoRegion(region: NetDiffRegion, record: DiffEditRecord): boolean {
  const recordOldLines = normalizeTextLines(record.oldText);
  if (findLineSequenceIndex(region.currentText, recordOldLines) >= 0) return true;
  if (region.startLine == null || record.startLine == null) return false;

  const regionEnd = region.startLine + region.originalText.length - 1;
  const recordEnd = record.startLine + Math.max(getRecordOldLineCount(record), 1) - 1;
  return record.startLine <= regionEnd + 1 && recordEnd >= region.startLine - 1;
}

function mergeRecordIntoRegion(region: NetDiffRegion, record: DiffEditRecord): boolean {
  const oldLines = normalizeTextLines(record.oldText);
  const newLines = normalizeTextLines(record.newText);
  const matchIndex = findLineSequenceIndex(region.currentText, oldLines);
  if (matchIndex >= 0) {
    region.currentText.splice(matchIndex, oldLines.length, ...newLines);
    region.edits.push(record);
    return true;
  }

  if (region.startLine == null || record.startLine == null) return false;

  const offset = record.startLine - region.startLine;
  if (offset < 0 || offset > region.currentText.length) return false;

  region.currentText.splice(offset, oldLines.length, ...newLines);
  region.edits.push(record);
  return true;
}

function createRegion(record: DiffEditRecord): NetDiffRegion {
  return {
    startLine: record.startLine,
    originalText: normalizeTextLines(record.oldText),
    currentText: normalizeTextLines(record.newText),
    edits: [record],
  };
}

function buildNetHunks(path: string, records: DiffEditRecord[]): SessionDiffHunk[] {
  const regions: NetDiffRegion[] = [];

  for (const record of records) {
    const region = regions.find(candidate => canMergeRecordIntoRegion(candidate, record));
    if (region && mergeRecordIntoRegion(region, record)) {
      continue;
    }
    regions.push(createRegion(record));
  }

  return regions.map((region, index) => {
    const rows = buildDiffRows(region.originalText.join('\n'), region.currentText.join('\n'), region.startLine);
    const addedLines = rows.filter(row => row.type === 'add').length;
    const removedLines = rows.filter(row => row.type === 'remove').length;
    const oldLineCount = rows.filter(row => row.type !== 'add').length;
    const newLineCount = rows.filter(row => row.type !== 'remove').length;
    const lastEdit = region.edits[region.edits.length - 1];

    return {
      id: `net-${index}-${lastEdit.hunk.id}`,
      filePath: path,
      toolName: 'Net diff',
      toolId: lastEdit.hunk.toolId,
      messageIndex: lastEdit.hunk.messageIndex,
      timestamp: lastEdit.hunk.timestamp,
      location: region.startLine != null ? `line ${region.startLine}` : undefined,
      oldStartLine: region.startLine,
      newStartLine: region.startLine,
      oldLineCount,
      newLineCount,
      addedLines,
      removedLines,
      rows,
    };
  }).filter(hunk => hunk.addedLines > 0 || hunk.removedLines > 0);
}

function buildDiffFile(path: string, records: DiffEditRecord[]): SessionDiffFile {
  const editHunks = records.map(record => record.hunk).sort((left, right) => left.messageIndex - right.messageIndex);
  const hunks = buildNetHunks(path, records);
  const addedLines = hunks.reduce((sum, hunk) => sum + hunk.addedLines, 0);
  const removedLines = hunks.reduce((sum, hunk) => sum + hunk.removedLines, 0);

  return {
    path,
    addedLines,
    removedLines,
    editCount: editHunks.length,
    status: getFileStatus(addedLines, removedLines),
    hunks: hunks.length > 0 ? hunks : editHunks,
    editHunks,
  };
}

function formatPatchRange(start: number | null, count: number): string {
  const safeStart = start ?? 1;
  return count === 1 ? String(safeStart) : `${safeStart},${count}`;
}

function buildHunkPatch(hunk: SessionDiffHunk): string {
  const header = `@@ -${formatPatchRange(hunk.oldStartLine, hunk.oldLineCount)} +${formatPatchRange(hunk.newStartLine, hunk.newLineCount)} @@ ${hunk.toolName}`;
  const lines = hunk.rows.map(row => {
    if (row.type === 'add') return `+${row.text}`;
    if (row.type === 'remove') return `-${row.text}`;
    return ` ${row.text}`;
  });
  return [header, ...lines].join('\n');
}

export function getFilePatchText(file: SessionDiffFile, mode: 'net' | 'edits' = 'net'): string {
  const hunks = mode === 'edits' ? file.editHunks : file.hunks;
  return [
    `diff --git a/${file.path} b/${file.path}`,
    `--- a/${file.path}`,
    `+++ b/${file.path}`,
    ...hunks.map(buildHunkPatch),
  ].join('\n');
}

export function getSessionPatchText(summary: SessionDiffSummary, mode: 'net' | 'edits' = 'net'): string {
  return summary.files.map(file => getFilePatchText(file, mode)).join('\n\n');
}
