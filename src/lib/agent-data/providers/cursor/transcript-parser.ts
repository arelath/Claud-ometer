import fs from 'fs';
import path from 'path';
import { calculateCostAllModes, DEFAULT_COST_MODE } from '@/config/pricing';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import type {
  CostEstimates,
  SessionDetail,
  SessionInfo,
  SessionToolCallDisplay,
  SessionMessageDisplay,
  TokenUsage,
} from '@/lib/claude-data/types';
import type { CachedModelUsage } from '@/lib/agent-data/session-summary';
import { makeRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import { asRecord, forEachCursorJsonlLineSync, type CursorTranscriptRecord } from './io';
import type { CursorSessionFileInfo } from './session-index';
import { estimateCursorTokens, resolveCursorModel } from './state-db';

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
const CURSOR_AGENT_DEFAULT_MODEL = 'cursor-agent-auto';
const EMPTY_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
const USER_MARKER = /^\s*user:\s*/i;
const ASSISTANT_MARKER = /^\s*A:\s*/;
const THINKING_MARKER = /^\s*\[Thinking\]\s*/;
const TOOL_CALL_MARKER = /^\s*\[Tool call\]\s*(.+?)\s*$/i;
const TOOL_RESULT_MARKER = /^\s*\[Tool result\]\b/i;
const USER_QUERY_OPEN = '<user_query>';
const USER_QUERY_CLOSE = '</user_query>';

function emptyUsage(): TokenUsage {
  return { ...EMPTY_USAGE };
}

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

function extractToolCallsFromMessage(message: unknown, prefix: string): SessionToolCallDisplay[] {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return [];

  const calls: SessionToolCallDisplay[] = [];
  content.forEach((part, index) => {
    const partRecord = asRecord(part);
    if (!partRecord || partRecord.type !== 'tool_use') return;
    const name = getOptionalString(partRecord, 'name') || 'tool';
    calls.push({
      name: `cursor:${name.toLowerCase()}`,
      id: getOptionalString(partRecord, 'id') || `${prefix}:${index}`,
      summary: name,
      details: [{ key: 'name', label: 'Tool', value: name }],
    });
  });
  return calls;
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function parseToolName(raw: string): string {
  const clean = raw.trim();
  return clean ? clean.toLowerCase().replace(/\s+/g, '-') : 'unknown';
}

function extractUserQuery(userBlock: string): string {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < userBlock.length) {
    const openIndex = userBlock.indexOf(USER_QUERY_OPEN, cursor);
    if (openIndex === -1) break;
    const start = openIndex + USER_QUERY_OPEN.length;
    const closeIndex = userBlock.indexOf(USER_QUERY_CLOSE, start);
    if (closeIndex === -1) {
      chunks.push(userBlock.slice(start).trim());
      break;
    }
    chunks.push(userBlock.slice(start, closeIndex).trim());
    cursor = closeIndex + USER_QUERY_CLOSE.length;
  }

  const combined = chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return combined || userBlock.replace(/\s+/g, ' ').trim();
}

interface ParsedLegacyTurn {
  userMessage: string;
  assistantText: string;
  reasoningText: string;
  tools: string[];
}

function parseLegacyTranscript(raw: string): ParsedLegacyTurn[] {
  const lines = raw.split(/\r?\n/);
  const pendingUsers: string[] = [];
  const turns: ParsedLegacyTurn[] = [];
  let active: 'none' | 'user' | 'assistant' = 'none';
  let userLines: string[] = [];
  let assistantLines: string[] = [];

  const flushUser = () => {
    if (userLines.length > 0) pendingUsers.push(extractUserQuery(userLines.join('\n')));
    userLines = [];
  };

  const flushAssistant = () => {
    if (assistantLines.length === 0) return;
    let assistantText = '';
    let reasoningText = '';
    const tools = new Set<string>();

    for (const line of assistantLines) {
      if (TOOL_RESULT_MARKER.test(line)) continue;
      if (THINKING_MARKER.test(line)) {
        const body = line.replace(THINKING_MARKER, '').trim();
        if (body) reasoningText += `${body}\n`;
        continue;
      }
      const toolMatch = line.match(TOOL_CALL_MARKER);
      if (toolMatch) {
        tools.add(`cursor:${parseToolName(toolMatch[1] || '')}`);
        continue;
      }
      assistantText += `${line}\n`;
    }

    const userMessage = pendingUsers.shift();
    if (userMessage) {
      turns.push({
        userMessage,
        assistantText: assistantText.trim(),
        reasoningText: reasoningText.trim(),
        tools: Array.from(tools),
      });
    }
    assistantLines = [];
  };

  for (const line of lines) {
    if (USER_MARKER.test(line)) {
      if (active === 'user') flushUser();
      if (active === 'assistant') flushAssistant();
      active = 'user';
      userLines = [line.replace(USER_MARKER, '')];
      continue;
    }

    if (ASSISTANT_MARKER.test(line)) {
      if (active === 'user') flushUser();
      if (active === 'assistant') flushAssistant();
      active = 'assistant';
      assistantLines = [line.replace(ASSISTANT_MARKER, '')];
      continue;
    }

    if (active === 'user') userLines.push(line);
    else if (active === 'assistant') assistantLines.push(line);
  }

  if (active === 'user') flushUser();
  if (active === 'assistant') flushAssistant();
  return turns;
}

function addTokenUsage(target: TokenUsage, inputTokens: number, outputTokens: number): void {
  target.input_tokens += inputTokens;
  target.output_tokens += outputTokens;
}

function addModelUsage(
  target: Record<string, CachedModelUsage>,
  model: string,
  inputTokens: number,
  outputTokens: number,
  reasoningOutputTokens = 0,
): void {
  const usage = target[model] || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
  };
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.reasoningOutputTokens = (usage.reasoningOutputTokens || 0) + reasoningOutputTokens;
  target[model] = usage;
}

function costsFromModelUsage(modelUsage: Record<string, CachedModelUsage>): CostEstimates {
  let costs = zeroCosts();
  for (const [model, usage] of Object.entries(modelUsage)) {
    costs = addCosts(
      costs,
      calculateCostAllModes(
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheReadInputTokens,
      ),
    );
  }
  return costs;
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
  const estimatedCosts = costsFromModelUsage(summary.modelUsage);
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
    sourceFilePaths: [filePath],
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
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
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
  let toolCallCount = 0;
  const reasoningOutputTokens = 0;
  const tokenUsage = emptyUsage();
  const model = resolveCursorModel(fileInfo.sourceKind === 'agent' ? fileInfo.model : undefined, CURSOR_AGENT_DEFAULT_MODEL);
  const models = new Set<string>([model]);
  const modelUsage: Record<string, CachedModelUsage> = {};
  const toolsUsed: Record<string, number> = {};

  records.forEach((record, index) => {
    const content = extractTextFromMessage(record.message);
    const toolCalls = extractToolCallsFromMessage(record.message, `${nativeId}:${index}`);
    if (!content && toolCalls.length === 0) return;

    const role = record.role === 'assistant'
      ? 'assistant'
      : record.role === 'user'
        ? 'user'
        : 'system';
    const inputTokens = role === 'user' ? estimateCursorTokens(content.length) : 0;
    const outputTokens = role === 'assistant' ? estimateCursorTokens(content.length) : 0;
    if (role === 'user') {
      userMessageCount++;
      title ||= firstLine(content);
    } else if (role === 'assistant') {
      assistantMessageCount++;
      toolCallCount += toolCalls.length;
      for (const toolCall of toolCalls) {
        toolsUsed[toolCall.name] = (toolsUsed[toolCall.name] || 0) + 1;
      }
    }

    addTokenUsage(tokenUsage, inputTokens, outputTokens);
    addModelUsage(modelUsage, model, inputTokens, outputTokens);
    searchableParts.push(content);
    messages.push({
      role,
      content,
      timestamp: messageTimestamp(fileInfo, index, record),
      model: role === 'assistant' ? model : undefined,
      usage: role === 'assistant' ? { ...EMPTY_USAGE, output_tokens: outputTokens } : undefined,
      estimatedCosts: role === 'assistant' ? costsFromModelUsage({ [model]: {
        inputTokens: 0,
        outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      } }) : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
    toolCallCount,
    model,
    models: Array.from(models),
    tokenUsage,
    reasoningOutputTokens,
    modelUsage,
    toolsUsed,
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
  if (fileInfo.sourceKind === 'chat') {
    return buildChatSummary(fileInfo);
  }
  if (filePath.endsWith('.txt')) {
    return buildSummaryFromParsed(parseCursorTextTranscript(filePath, fileInfo), fileInfo);
  }
  return buildSummaryFromParsed(parseCursorRecords(filePath, readCursorRecords(filePath), fileInfo), fileInfo);
}

function buildSummaryFromParsed(parsed: CursorParsedSession, fileInfo: CursorSessionFileInfo): CursorParsedSessionSummary {
  const createdAt = parsed.info.timestamp;
  const updatedAt = fileInfo.updatedAt || createdAt;
  const modelUsage = parsed.info.model
    ? {
        [parsed.info.model]: {
          inputTokens: parsed.info.totalInputTokens,
          outputTokens: parsed.info.totalOutputTokens,
          cacheReadInputTokens: parsed.info.totalCacheReadTokens,
          cacheCreationInputTokens: parsed.info.totalCacheWriteTokens,
          reasoningOutputTokens: 0,
        },
      }
    : {};
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
    tokenUsage: {
      input_tokens: parsed.info.totalInputTokens,
      output_tokens: parsed.info.totalOutputTokens,
      cache_read_input_tokens: parsed.info.totalCacheReadTokens,
      cache_creation_input_tokens: parsed.info.totalCacheWriteTokens,
    },
    reasoningOutputTokens: 0,
    modelUsage,
    toolsUsed: parsed.info.toolsUsed,
    searchTextPreview: parsed.searchableText.slice(0, SEARCH_PREVIEW_LIMIT),
  };
}

function buildChatSummary(fileInfo: Extract<CursorSessionFileInfo, { sourceKind: 'chat' }>): CursorParsedSessionSummary {
  const userMessageCount = fileInfo.messages.filter(message => message.role === 'user').length;
  const assistantMessageCount = fileInfo.messages.filter(message => message.role === 'assistant').length;
  const duration = Math.max(0, new Date(fileInfo.updatedAt).getTime() - new Date(fileInfo.createdAt).getTime());
  return {
    nativeId: fileInfo.nativeId,
    routeNativeId: fileInfo.routeNativeId,
    title: fileInfo.title,
    nativeProjectId: fileInfo.nativeProjectId,
    projectName: fileInfo.projectName,
    cwd: fileInfo.cwd,
    createdAt: fileInfo.createdAt,
    updatedAt: fileInfo.updatedAt,
    duration: Number.isNaN(duration) ? 0 : duration,
    userMessageCount,
    assistantMessageCount,
    messageCount: fileInfo.messages.length,
    toolCallCount: fileInfo.toolCallCount,
    model: fileInfo.model,
    models: fileInfo.models,
    tokenUsage: fileInfo.tokenUsage,
    reasoningOutputTokens: 0,
    modelUsage: fileInfo.modelUsage,
    toolsUsed: fileInfo.toolsUsed,
    searchTextPreview: fileInfo.searchTextPreview,
  };
}

function parseCursorChatSession(fileInfo: Extract<CursorSessionFileInfo, { sourceKind: 'chat' }>): CursorParsedSession {
  const summary = buildChatSummary(fileInfo);
  const info = buildBaseSessionInfo(fileInfo.filePath, summary);
  return {
    info,
    detail: { ...info, messages: fileInfo.messages },
    searchableText: fileInfo.searchTextPreview,
  };
}

function parseCursorTextTranscript(filePath: string, fileInfo: CursorSessionFileInfo): CursorParsedSession {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const turns = parseLegacyTranscript(raw);
  const messages: SessionMessageDisplay[] = [];
  const searchableParts: string[] = [];
  const tokenUsage = emptyUsage();
  const model = resolveCursorModel(fileInfo.sourceKind === 'agent' ? fileInfo.model : undefined, CURSOR_AGENT_DEFAULT_MODEL);
  const modelUsage: Record<string, CachedModelUsage> = {};
  const toolsUsed: Record<string, number> = {};
  let title = fileInfo.title || '';
  let toolCallCount = 0;
  let reasoningOutputTokens = 0;

  turns.forEach((turn, index) => {
    const userTokens = estimateCursorTokens(turn.userMessage.length);
    const outputTokens = estimateCursorTokens(turn.assistantText.length);
    const reasoningTokens = estimateCursorTokens(turn.reasoningText.length);
    const userTimestamp = messageTimestamp(fileInfo, index * 2, {});
    const assistantTimestamp = messageTimestamp(fileInfo, index * 2 + 1, {});

    title ||= firstLine(turn.userMessage);
    searchableParts.push(turn.userMessage, turn.assistantText, turn.reasoningText);
    addTokenUsage(tokenUsage, userTokens, outputTokens);
    reasoningOutputTokens += reasoningTokens;
    addModelUsage(modelUsage, model, userTokens, outputTokens, reasoningTokens);
    toolCallCount += turn.tools.length;
    for (const tool of turn.tools) toolsUsed[tool] = (toolsUsed[tool] || 0) + 1;

    messages.push({
      role: 'user',
      content: turn.userMessage,
      timestamp: userTimestamp,
    });
    messages.push({
      role: 'assistant',
      content: turn.assistantText,
      timestamp: assistantTimestamp,
      model,
      usage: { ...EMPTY_USAGE, output_tokens: outputTokens },
      estimatedCosts: costsFromModelUsage({ [model]: {
        inputTokens: 0,
        outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: reasoningTokens,
      } }),
      toolCalls: turn.tools.map((tool, toolIndex) => ({
        name: tool,
        id: `${fileInfo.nativeId}:${index}:${toolIndex}`,
        summary: tool,
        details: [{ key: 'name', label: 'Tool', value: tool }],
      })),
      blocks: turn.reasoningText
        ? [{
            type: 'thinking',
            title: 'Thinking',
            summary: `${reasoningTokens} token estimate`,
            details: [{ key: 'tokens', label: 'Tokens', value: String(reasoningTokens) }],
            content: turn.reasoningText,
          }]
        : undefined,
    });
  });

  const createdAt = fileInfo.createdAt || new Date(0).toISOString();
  const updatedAt = fileInfo.updatedAt || createdAt;
  const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(createdAt).getTime());
  const summary: CursorParsedSessionSummary = {
    nativeId: fileInfo.nativeId,
    routeNativeId: fileInfo.routeNativeId,
    title,
    nativeProjectId: fileInfo.nativeProjectId,
    projectName: fileInfo.projectName,
    cwd: fileInfo.cwd,
    createdAt,
    updatedAt,
    duration: Number.isNaN(duration) ? 0 : duration,
    userMessageCount: turns.length,
    assistantMessageCount: turns.length,
    messageCount: messages.length,
    toolCallCount,
    model,
    models: [model],
    tokenUsage,
    reasoningOutputTokens,
    modelUsage,
    toolsUsed,
    searchTextPreview: searchableParts.join('\n').toLowerCase().slice(0, SEARCH_PREVIEW_LIMIT),
  };
  const info = buildBaseSessionInfo(filePath, summary);
  return {
    info,
    detail: { ...info, messages },
    searchableText: searchableParts.join('\n').toLowerCase(),
  };
}

export async function parseCursorSessionFile(filePath: string, fileInfo: CursorSessionFileInfo): Promise<CursorParsedSession> {
  if (fileInfo.sourceKind === 'chat') return parseCursorChatSession(fileInfo);
  if (filePath.endsWith('.txt')) return parseCursorTextTranscript(filePath, fileInfo);
  return parseCursorRecords(filePath, readCursorRecords(filePath), fileInfo);
}
