import { ANTHROPIC_FILE_DETAIL_KEYS, ANTHROPIC_START_LINE_DETAIL_KEYS, ANTHROPIC_TOOL_NAMES } from '@/config/anthropic-schema';
import type { SessionMessageDisplay, SessionToolCallDetail } from '@/lib/claude-data/types';
import { normalizeDisplayPath } from '@/lib/path-utils';
import { detailMatchesKey, parseLineNumber } from '@/lib/string-utils';

interface FileSnapshot {
  path: string;
  startLine: number;
  content: string;
  messageIndex: number;
}

export interface SessionDiffArtifact {
  path: string;
  toolName: string;
  toolId: string;
  messageIndex: number;
  timestamp: string;
  location?: string;
  oldText: string;
  newText: string;
  startLine: number | null;
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
  for (const key of ANTHROPIC_START_LINE_DETAIL_KEYS) {
    const detail = findDetail(details, [key]);
    const lineNumber = parseLineNumber(detail?.value);
    if (lineNumber == null) continue;
    return Math.max(1, lineNumber);
  }
  return null;
}

function getToolPath(details: SessionToolCallDetail[]): string | null {
  const value = findDetail(details, [...ANTHROPIC_FILE_DETAIL_KEYS])?.value;
  if (!value) return null;
  const firstLine = value.split(/\r\n?|\n/).find(line => line.trim());
  return firstLine ? normalizePath(firstLine.trim()) : null;
}

function getReadToolRanges(messages: SessionMessageDisplay[]): Map<string, { path: string; startLine: number | null }> {
  const ranges = new Map<string, { path: string; startLine: number | null }>();

  for (const message of messages) {
    for (const tool of message.toolCalls || []) {
      if (!tool.id || tool.name !== ANTHROPIC_TOOL_NAMES.read) continue;
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

function hasEnoughLineMatchConfidence(needleLines: string[]): boolean {
  const meaningfulLines = needleLines
    .map(line => normalizeLineForMatch(line).trim())
    .filter(Boolean);

  if (meaningfulLines.length >= 2) return true;
  const onlyLine = meaningfulLines[0];
  if (!onlyLine) return false;
  if (onlyLine.length <= 2) return false;
  return !/^[{}()[\];,]+$/.test(onlyLine);
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
  if (!hasEnoughLineMatchConfidence(oldLines)) return null;

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
  artifacts: SessionDiffArtifact[],
): number | null {
  const oldLines = normalizeTextLines(oldText);
  if (oldLines.length === 0) return 1;
  if (!hasEnoughLineMatchConfidence(oldLines)) return null;

  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (artifact.path !== filePath || artifact.startLine == null) continue;
    const matchIndex = findLineSequenceIndex(normalizeTextLines(artifact.newText), oldLines);
    if (matchIndex >= 0) return artifact.startLine + matchIndex;
  }

  return null;
}

export function getSessionDiffArtifacts(messages: SessionMessageDisplay[]): SessionDiffArtifact[] {
  const snapshots = getFileSnapshots(messages);
  const artifacts: SessionDiffArtifact[] = [];

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
        ?? inferStartLineFromPreviousEdits(filePath, oldText, artifacts)
        ?? inferStartLineFromSnapshots(filePath, oldText, messageIndex, snapshots);

      artifacts.push({
        path: filePath,
        toolName: tool.name,
        toolId: tool.id,
        messageIndex,
        timestamp: message.timestamp,
        location: tool.artifact.location || (startLine != null ? `line ${startLine}` : undefined),
        oldText,
        newText,
        startLine,
      });
    }
  });

  return artifacts;
}
