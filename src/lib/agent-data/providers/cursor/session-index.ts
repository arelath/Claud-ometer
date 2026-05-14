import path from 'path';
import {
  asRecord,
  forEachCursorJsonlLineSync,
  getCursorDir,
  getCursorProjectsDir,
  getFileSignature,
  getFileTimestampInfo,
  listCursorTranscriptFiles,
  signatureToString,
} from './io';

export interface CursorSessionFileInfo {
  filePath: string;
  nativeId: string;
  routeNativeId: string;
  projectId: string;
  projectDir: string;
  nativeProjectId: string;
  projectName: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  signature: string;
  sourceSignature: { mtimeMs: number; size: number };
}

interface DiscoveryCacheEntry {
  signature: string;
  value: CursorSessionFileInfo[];
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

function getOptionalString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextFromMessage(message: unknown): string {
  const record = asRecord(message);
  const content = record?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyValue(content || message);

  return content
    .map(part => {
      if (typeof part === 'string') return part;
      const partRecord = asRecord(part);
      if (!partRecord) return stringifyValue(part);
      return getOptionalString(partRecord, 'text')
        || getOptionalString(partRecord, 'content')
        || stringifyValue(partRecord);
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function decodeProjectPath(projectId: string): string {
  const driveMatch = /^([A-Za-z])-(.+)$/.exec(projectId);
  if (!driveMatch) return '';

  const [, drive, rest] = driveMatch;
  return `${drive}:\\${rest.replace(/-/g, '\\')}`;
}

function getProjectName(projectId: string, cwd: string): string {
  if (cwd) return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || projectId;
  return projectId;
}

function readTitle(filePath: string): string | undefined {
  let title: string | undefined;
  try {
    forEachCursorJsonlLineSync(filePath, record => {
      if (title || record.role !== 'user') return;
      const text = extractTextFromMessage(record.message);
      if (text) title = firstLine(text);
    });
  } catch {
    return undefined;
  }
  return title;
}

function getSessionParts(filePath: string): { projectId: string; nativeId: string; projectDir: string } {
  const sessionDir = path.dirname(filePath);
  const nativeId = path.basename(sessionDir);
  const projectDir = path.dirname(path.dirname(sessionDir));
  const projectId = path.basename(projectDir);
  return { projectId, nativeId, projectDir };
}

function readSessionFileInfo(filePath: string): CursorSessionFileInfo {
  const { projectId, nativeId, projectDir } = getSessionParts(filePath);
  const cwd = decodeProjectPath(projectId);
  const sourceSignature = getFileSignature(filePath);
  const timestampInfo = getFileTimestampInfo(filePath);
  return {
    filePath,
    nativeId,
    routeNativeId: `${projectId}:${nativeId}`,
    projectId,
    projectDir,
    nativeProjectId: projectId,
    projectName: getProjectName(projectId, cwd),
    cwd,
    createdAt: timestampInfo.createdAt,
    updatedAt: timestampInfo.updatedAt,
    title: readTitle(filePath),
    signature: signatureToString(sourceSignature),
    sourceSignature,
  };
}

function buildDiscoverySignature(files: string[]): string {
  return files
    .map(filePath => `${filePath}:${signatureToString(getFileSignature(filePath))}`)
    .join('|');
}

export async function discoverCursorSessionFiles(): Promise<CursorSessionFileInfo[]> {
  const cursorDir = getCursorDir();
  const projectsDir = getCursorProjectsDir(cursorDir);
  const files = listCursorTranscriptFiles(projectsDir);
  if (files.length === 0) return [];

  const signature = buildDiscoverySignature(files);
  const cached = discoveryCache.get(cursorDir);
  if (cached?.signature === signature) return cached.value;

  const value = files.map(readSessionFileInfo)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  discoveryCache.set(cursorDir, { signature, value });
  return value;
}

export function resetCursorSessionIndexCacheForTests(): void {
  discoveryCache.clear();
}
