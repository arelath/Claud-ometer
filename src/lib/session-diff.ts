import type { SessionMessageDisplay } from '@/lib/claude-data/types';
import { diffArrays } from 'diff';
import { getSessionDiffArtifacts } from '@/lib/artifact-extractor';

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

interface DiffEditRecord {
  path: string;
  oldText: string;
  newText: string;
  startLine: number | null;
  originalStartLine: number | null;
  hunk: SessionDiffHunk;
}

class FileOffsetTracker {
  private offsets: { line: number; delta: number }[] = [];

  recordEdit(startLine: number | null, addedLines: number, removedLines: number): void {
    if (startLine == null) return;
    const delta = addedLines - removedLines;
    if (delta === 0) return;
    this.offsets.push({ line: startLine, delta });
    this.offsets.sort((left, right) => left.line - right.line);
  }

  toOriginal(currentLine: number): number {
    let original = currentLine;
    for (let index = this.offsets.length - 1; index >= 0; index -= 1) {
      const offset = this.offsets[index];
      if (original > offset.line) {
        original -= offset.delta;
      }
    }
    return Math.max(1, original);
  }

  toCurrent(originalLine: number): number {
    let current = originalLine;
    for (const offset of this.offsets) {
      if (current > offset.line) {
        current += offset.delta;
      }
    }
    return Math.max(1, current);
  }
}

function normalizeTextLines(value: string): string[] {
  const normalized = value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n?/g, '\n');
  if (!normalized) return [];
  return normalized.split('\n');
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

function buildSimpleLineDiff(oldLines: string[], newLines: string[]): { type: DiffRowType; text: string }[] {
  return diffArrays(oldLines, newLines).flatMap(part => {
    const type: DiffRowType = part.added ? 'add' : part.removed ? 'remove' : 'context';
    return part.value.map(text => ({ type, text }));
  });
}

function buildDiffRows(
  oldText: string,
  newText: string,
  oldStartLine: number | null,
  newStartLine: number | null,
): SessionDiffRow[] {
  const simpleRows = buildSimpleLineDiff(normalizeTextLines(oldText), normalizeTextLines(newText));
  let oldLineNumber = oldStartLine;
  let newLineNumber = newStartLine;

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
  const recordsByFile = new Map<string, DiffEditRecord[]>();
  const artifacts = getSessionDiffArtifacts(messages);
  const trackers = new Map<string, FileOffsetTracker>();

  for (const artifact of artifacts) {
    if (!trackers.has(artifact.path)) trackers.set(artifact.path, new FileOffsetTracker());
    const tracker = trackers.get(artifact.path)!;
    const originalStartLine = artifact.startLine == null ? null : tracker.toOriginal(artifact.startLine);
    const rows = buildDiffRows(artifact.oldText, artifact.newText, artifact.startLine, artifact.startLine);
    const addedLines = rows.filter(row => row.type === 'add').length;
    const removedLines = rows.filter(row => row.type === 'remove').length;
    const oldLineCount = rows.filter(row => row.type !== 'add').length;
    const newLineCount = rows.filter(row => row.type !== 'remove').length;

    const hunk: SessionDiffHunk = {
      id: `${artifact.messageIndex}-${artifact.toolId || artifact.toolName}-${artifact.path}`,
      filePath: artifact.path,
      toolName: artifact.toolName,
      toolId: artifact.toolId,
      messageIndex: artifact.messageIndex,
      timestamp: artifact.timestamp,
      location: artifact.location,
      oldStartLine: artifact.startLine,
      newStartLine: artifact.startLine,
      oldLineCount,
      newLineCount,
      addedLines,
      removedLines,
      rows,
    };

    const record = {
      path: artifact.path,
      oldText: artifact.oldText,
      newText: artifact.newText,
      startLine: artifact.startLine,
      originalStartLine,
      hunk,
    };
    recordsByFile.set(artifact.path, [...(recordsByFile.get(artifact.path) || []), record]);
    tracker.recordEdit(artifact.startLine, addedLines, removedLines);
  }

  const files = Array.from(recordsByFile.entries())
    .map(([path, records]) => buildDiffFile(path, records, trackers.get(path) || new FileOffsetTracker()))
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
  originalStartLine: number | null;
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
    originalStartLine: record.originalStartLine,
    originalText: normalizeTextLines(record.oldText),
    currentText: normalizeTextLines(record.newText),
    edits: [record],
  };
}

function buildNetHunks(path: string, records: DiffEditRecord[], tracker: FileOffsetTracker): SessionDiffHunk[] {
  const regions: NetDiffRegion[] = [];

  for (const record of records) {
    const region = regions.find(candidate => canMergeRecordIntoRegion(candidate, record));
    if (region && mergeRecordIntoRegion(region, record)) {
      continue;
    }
    regions.push(createRegion(record));
  }

  return regions.map((region, index) => {
    const oldStartLine = region.originalStartLine;
    const newStartLine = oldStartLine == null ? region.startLine : tracker.toCurrent(oldStartLine);
    const rows = buildDiffRows(region.originalText.join('\n'), region.currentText.join('\n'), oldStartLine, newStartLine);
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
      location: oldStartLine != null ? `line ${oldStartLine}` : undefined,
      oldStartLine,
      newStartLine,
      oldLineCount,
      newLineCount,
      addedLines,
      removedLines,
      rows,
    };
  }).filter(hunk => hunk.addedLines > 0 || hunk.removedLines > 0);
}

function buildDiffFile(path: string, records: DiffEditRecord[], tracker: FileOffsetTracker): SessionDiffFile {
  const editHunks = records.map(record => record.hunk).sort((left, right) => left.messageIndex - right.messageIndex);
  const hunks = buildNetHunks(path, records, tracker);
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
