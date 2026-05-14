import path from 'path';
import { zeroCosts } from '@/lib/claude-data/cost-utils';
import type {
  SessionDetail,
  SessionInfo,
  SessionMessageDisplay,
  TokenUsage,
} from '@/lib/claude-data/types';
import type { CachedModelUsage } from '@/lib/agent-data/session-summary';
import { makeRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import { asRecord, forEachCursorJsonlLineSync, type CursorTranscriptRecord } from './io';
import type { CursorSessionFileInfo } from './session-index';

export interface CursorParsedSession {
  info: SessionInfo;
  detail: SessionDetail;
  searchableText: string;
}

export interface CursorParsedSessionSummary {
  nativeId: string;
  routeNativeId: string;
  title?: string;
  nativeProjectId: string;
  projectName: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  duration: number;
  userMessageCount: number;
  assistantMessageCount: number;
  messageCount: number;
  toolCallCount: number;
  model: string;
  models: string[];
  tokenUsage: TokenUsage;
  reasoningOutputTokens: number;
  modelUsage: Record<string, CachedModelUsage>;
  toolsUsed: Record<string, number>;
  searchTextPreview: string;
}

const SEARCH_PREVIEW_LIMIT = 8 * 1024;
const EMPTY_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function getOptionalString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function firstLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function messageTimestamp(fileInfo: CursorSessionFileInfo, index: number, record: CursorTranscriptRecord): string {
  if (record.timestamp) return record.timestamp;
  const start = new Date(fileInfo.createdAt).getTime();
  if (Number.isNaN(start)) return fileInfo.createdAt;
  return new Date(start + index).toISOString();
}

function buildBaseSessionInfo(
  filePath: string,
  summary: CursorParsedSessionSummary,
): Omit<SessionDetail, 'messages'> {
  const routeId = makeRouteId('cursor', summary.routeNativeId);
  const projectRouteId = qualifyProjectId('cursor', summary.nativeProjectId);
  const estimatedCosts = zeroCosts();
  return {
    id: routeId,
    agentKind: 'cursor',
    nativeId: summary.nativeId,
    routeId,
    projectId: projectRouteId,
    nativeProjectId: summary.nativeProjectId,
    projectRouteId,
    projectName: summary.projectName,
    title: summary.title,
    sourceFilePath: filePath,
    timestamp: summary.createdAt,
    duration: summary.duration,
    messageCount: summary.messageCount,
    userMessageCount: summary.userMessageCount,
    assistantMessageCount: summary.assistantMessageCount,
    toolCallCount: summary.toolCallCount,
    totalInputTokens: summary.tokenUsage.input_tokens,
    totalOutputTokens: summary.tokenUsage.output_tokens,
    totalCacheReadTokens: summary.tokenUsage.cache_read_input_tokens,
    totalCacheWriteTokens: summary.tokenUsage.cache_creation_input_tokens,
    estimatedCost: 0,
    estimatedCosts,
    model: summary.model,
    models: summary.models,
    gitBranch: '',
    cwd: summary.cwd,
    version: '',
    toolsUsed: summary.toolsUsed,
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
  };
}

export function readCursorRecords(filePath: string): CursorTranscriptRecord[] {
  const records: CursorTranscriptRecord[] = [];
  forEachCursorJsonlLineSync(filePath, record => {
    records.push(record);
  });
  return records;
}

export function parseCursorRecords(filePath: string, records: CursorTranscriptRecord[], fileInfo: CursorSessionFileInfo): CursorParsedSession {
  const messages: SessionMessageDisplay[] = [];
  const searchableParts: string[] = [];
  const nativeId = fileInfo.nativeId || path.basename(filePath, '.jsonl');
  let title = fileInfo.title || '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;

  records.forEach((record, index) => {
    const content = extractTextFromMessage(record.message);
    if (!content) return;

    const role = record.role === 'assistant'
      ? 'assistant'
      : record.role === 'user'
        ? 'user'
        : 'system';
    if (role === 'user') {
      userMessageCount++;
      title ||= firstLine(content);
    } else if (role === 'assistant') {
      assistantMessageCount++;
    }

    searchableParts.push(content);
    messages.push({
      role,
      content,
      timestamp: messageTimestamp(fileInfo, index, record),
      model: role === 'assistant' ? 'unknown' : undefined,
      usage: role === 'assistant' ? { ...EMPTY_USAGE } : undefined,
      estimatedCosts: role === 'assistant' ? zeroCosts() : undefined,
    });
  });

  const createdAt = fileInfo.createdAt || new Date(0).toISOString();
  const updatedAt = fileInfo.updatedAt || createdAt;
  const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(createdAt).getTime());
  const summary: CursorParsedSessionSummary = {
    nativeId,
    routeNativeId: `${fileInfo.nativeProjectId}:${nativeId}`,
    title,
    nativeProjectId: fileInfo.nativeProjectId,
    projectName: fileInfo.projectName,
    cwd: fileInfo.cwd,
    createdAt,
    updatedAt,
    duration: Number.isNaN(duration) ? 0 : duration,
    userMessageCount,
    assistantMessageCount,
    messageCount: userMessageCount + assistantMessageCount,
    toolCallCount: 0,
    model: 'unknown',
    models: [],
    tokenUsage: { ...EMPTY_USAGE },
    reasoningOutputTokens: 0,
    modelUsage: {},
    toolsUsed: {},
    searchTextPreview: searchableParts.join('\n').toLowerCase().slice(0, SEARCH_PREVIEW_LIMIT),
  };
  const info = buildBaseSessionInfo(filePath, summary);

  return {
    info,
    detail: { ...info, messages },
    searchableText: searchableParts.join('\n').toLowerCase(),
  };
}

export function parseCursorSessionSummaryFile(filePath: string, fileInfo: CursorSessionFileInfo): CursorParsedSessionSummary {
  return buildSummaryFromParsed(parseCursorRecords(filePath, readCursorRecords(filePath), fileInfo), fileInfo);
}

function buildSummaryFromParsed(parsed: CursorParsedSession, fileInfo: CursorSessionFileInfo): CursorParsedSessionSummary {
  const createdAt = parsed.info.timestamp;
  const updatedAt = fileInfo.updatedAt || createdAt;
  return {
    nativeId: parsed.info.nativeId || fileInfo.nativeId,
    routeNativeId: fileInfo.routeNativeId,
    title: parsed.info.title,
    nativeProjectId: fileInfo.nativeProjectId,
    projectName: fileInfo.projectName,
    cwd: fileInfo.cwd,
    createdAt,
    updatedAt,
    duration: parsed.info.duration,
    userMessageCount: parsed.info.userMessageCount,
    assistantMessageCount: parsed.info.assistantMessageCount,
    messageCount: parsed.info.messageCount,
    toolCallCount: parsed.info.toolCallCount,
    model: parsed.info.model,
    models: parsed.info.models,
    tokenUsage: { ...EMPTY_USAGE },
    reasoningOutputTokens: 0,
    modelUsage: {},
    toolsUsed: {},
    searchTextPreview: parsed.searchableText.slice(0, SEARCH_PREVIEW_LIMIT),
  };
}

export async function parseCursorSessionFile(filePath: string, fileInfo: CursorSessionFileInfo): Promise<CursorParsedSession> {
  return parseCursorRecords(filePath, readCursorRecords(filePath), fileInfo);
}
