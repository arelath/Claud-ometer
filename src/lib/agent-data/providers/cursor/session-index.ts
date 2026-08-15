import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  asRecord,
  forEachCursorJsonlPrefixLineSync,
  getCursorDir,
  getCursorProjectsDir,
  getCursorStateDbPath,
  getFileSignature,
  getFileTimestampInfo,
  listCursorTranscriptFiles,
  signatureToString,
} from './io';
import { discoverCursorChatSessions, getCursorConversationSummary, resetCursorStateDbCache, type CursorChatSessionInfo } from './state-db';

export interface CursorAgentSessionFileInfo {
  sourceKind: 'agent';
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
  model?: string;
  signature: string;
  sourceSignature: { mtimeMs: number; size: number };
}

export type CursorSessionFileInfo = CursorAgentSessionFileInfo | CursorChatSessionInfo;

interface DiscoveryCacheEntry {
  signature: string;
  value: CursorSessionFileInfo[];
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const TITLE_PREFIX_BYTES = 128 * 1024;

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

function readJsonlTitle(filePath: string): string | undefined {
  let title: string | undefined;
  try {
    forEachCursorJsonlPrefixLineSync(filePath, TITLE_PREFIX_BYTES, record => {
      if (title) return false;
      if (record.role !== 'user') return;
      const text = extractTextFromMessage(record.message);
      if (text) title = firstLine(text);
      return title ? false : undefined;
    });
  } catch {
    return undefined;
  }
  return title;
}

function readTextTitle(filePath: string): string | undefined {
  try {
    const prefix = fs.readFileSync(filePath, 'utf-8').slice(0, TITLE_PREFIX_BYTES);
    const userQuery = prefix.match(/<user_query>([\s\S]*?)(?:<\/user_query>|$)/i)?.[1];
    if (userQuery?.trim()) return firstLine(userQuery);

    const userBlock = prefix.match(/^\s*user:\s*([\s\S]*?)(?:\r?\n\s*A:\s*|$)/im)?.[1];
    return userBlock?.trim() ? firstLine(userBlock) : undefined;
  } catch {
    return undefined;
  }
}

function readTitle(filePath: string): string | undefined {
  return filePath.endsWith('.txt') ? readTextTitle(filePath) : readJsonlTitle(filePath);
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nativeIdFromTranscriptPath(filePath: string): string {
  const ext = path.extname(filePath);
  const fileStem = path.basename(filePath, ext);
  if (UUID_LIKE.test(fileStem)) return fileStem;

  const parent = path.basename(path.dirname(filePath));
  if (parent !== 'agent-transcripts' && parent !== 'subagents') return parent;

  return createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

function getSessionParts(filePath: string): { projectId: string; nativeId: string; projectDir: string } {
  const parts = filePath.split(/[\\/]+/);
  const projectsIndex = parts.lastIndexOf('projects');
  const projectId = projectsIndex >= 0 && parts[projectsIndex + 1]
    ? parts[projectsIndex + 1]
    : path.basename(path.dirname(path.dirname(path.dirname(filePath))));
  const projectDir = projectsIndex >= 0
    ? parts.slice(0, projectsIndex + 2).join(path.sep)
    : path.dirname(path.dirname(path.dirname(filePath)));
  const nativeId = nativeIdFromTranscriptPath(filePath);
  return { projectId, nativeId, projectDir };
}

function readSessionFileInfo(filePath: string): CursorAgentSessionFileInfo {
  const { projectId, nativeId, projectDir } = getSessionParts(filePath);
  const cwd = decodeProjectPath(projectId);
  const sourceSignature = getFileSignature(filePath);
  const timestampInfo = getFileTimestampInfo(filePath);
  const summary = getCursorConversationSummary(nativeId);
  return {
    sourceKind: 'agent',
    filePath,
    nativeId,
    routeNativeId: `${projectId}:${nativeId}`,
    projectId,
    projectDir,
    nativeProjectId: projectId,
    projectName: getProjectName(projectId, cwd),
    cwd,
    createdAt: timestampInfo.createdAt,
    updatedAt: summary?.updatedAt || timestampInfo.updatedAt,
    title: summary?.title || readTitle(filePath),
    model: summary?.model,
    signature: signatureToString(sourceSignature),
    sourceSignature,
  };
}

function buildDiscoverySignature(files: string[], chatSessions: CursorChatSessionInfo[]): string {
  return files
    .map(filePath => `${filePath}:${signatureToString(getFileSignature(filePath))}`)
    .concat(chatSessions.map(session => `${session.filePath}:${session.signature}`))
    .join('|');
}

export async function discoverCursorSessionFiles(): Promise<CursorSessionFileInfo[]> {
  const cursorDir = getCursorDir();
  const projectsDir = getCursorProjectsDir(cursorDir);
  const files = listCursorTranscriptFiles(projectsDir);
  const dbPath = fs.existsSync(getCursorStateDbPath(cursorDir))
    ? getCursorStateDbPath(cursorDir)
    : getCursorStateDbPath();
  const chatSessions = discoverCursorChatSessions(dbPath);
  if (files.length === 0 && chatSessions.length === 0) return [];

  const signature = buildDiscoverySignature(files, chatSessions);
  const cached = discoveryCache.get(`${cursorDir}:${dbPath}`);
  if (cached?.signature === signature) return cached.value;

  const value: CursorSessionFileInfo[] = [
    ...files.map(readSessionFileInfo),
    ...chatSessions,
  ]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  discoveryCache.set(`${cursorDir}:${dbPath}`, { signature, value });
  return value;
}

export function resetCursorSessionIndexCache(): void {
  discoveryCache.clear();
  resetCursorStateDbCache();
}

export function resetCursorSessionIndexCacheForTests(): void {
  resetCursorSessionIndexCache();
}
