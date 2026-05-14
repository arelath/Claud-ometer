import path from 'path';
import { calculateCostAllModes, DEFAULT_COST_MODE } from '@/config/pricing';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import type {
  CostEstimates,
  SessionArtifactDisplay,
  SessionDetail,
  SessionInfo,
  SessionMessageBlockDisplay,
  SessionMessageDisplay,
  SessionToolCallDetail,
  SessionToolCallDisplay,
  TokenUsage,
} from '@/lib/claude-data/types';
import type { CachedModelUsage } from '@/lib/agent-data/session-summary';
import { makeRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import { asRecord, forEachCopilotJsonlLineSync, type CopilotTranscriptRecord } from './io';
import type { CopilotSessionFileInfo } from './session-index';
import {
  getCopilotChatSessionSummary,
  type CopilotChatSessionSummary,
  type CopilotRequestUsage,
  type CopilotUsageTotals,
} from './chat-session';

export interface CopilotParsedSession {
  info: SessionInfo;
  detail: SessionDetail;
  searchableText: string;
}

export interface CopilotParsedSessionSummary {
  nativeId: string;
  routeNativeId: string;
  title?: string;
  workspaceHash: string;
  nativeProjectId: string;
  projectName: string;
  cwd: string;
  version: string;
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

const SUMMARY_SEARCH_PREVIEW_LIMIT = 8 * 1024;
const SUMMARY_SEARCH_PART_LIMIT = 256;

const EMPTY_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function toTokenUsage(usage: CopilotUsageTotals): TokenUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
  };
}

function hasTokenUsage(usage: TokenUsage): boolean {
  return usage.input_tokens > 0
    || usage.output_tokens > 0
    || usage.cache_creation_input_tokens > 0
    || usage.cache_read_input_tokens > 0;
}

function buildAssistantRequestUsageMap(
  records: CopilotTranscriptRecord[],
  requestUsages: CopilotRequestUsage[],
): Map<number, CopilotRequestUsage> {
  const usageByRequest = new Map(requestUsages.map(usage => [usage.index, usage]));
  const lastAssistantByRequest = new Map<number, number>();
  let requestIndex = 0;
  let assistantIndex = 0;
  let currentHasUser = false;
  let currentHasAssistant = false;

  for (const record of records) {
    if (record.type === 'user.message') {
      if (currentHasUser || currentHasAssistant) requestIndex++;
      currentHasUser = true;
      currentHasAssistant = false;
      continue;
    }

    if (record.type !== 'assistant.message') continue;
    lastAssistantByRequest.set(requestIndex, assistantIndex);
    assistantIndex++;
    currentHasUser = false;
    currentHasAssistant = true;
  }

  const usageByAssistant = new Map<number, CopilotRequestUsage>();
  for (const [index, assistant] of lastAssistantByRequest) {
    const usage = usageByRequest.get(index);
    if (usage) usageByAssistant.set(assistant, usage);
  }
  return usageByAssistant;
}

function buildCopilotModelUsage(chatSummary: CopilotChatSessionSummary): Record<string, CachedModelUsage> {
  const modelUsage: Record<string, CachedModelUsage> = {};
  for (const [model, usage] of Object.entries(chatSummary.modelUsage)) {
    modelUsage[model] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      contextWindow: usage.contextWindow,
      maxOutputTokens: usage.maxOutputTokens,
    };
  }
  return modelUsage;
}

function calculateCopilotCosts(modelUsage: Record<string, CachedModelUsage>): CostEstimates {
  let costs = zeroCosts();
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!model || model === 'unknown') continue;
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

function getCopilotSidecarSummary(fileInfo: CopilotSessionFileInfo): CopilotChatSessionSummary {
  return getCopilotChatSessionSummary(fileInfo.chatSessionFilePath);
}

const TOOL_NAME_MAP: Record<string, string> = {
  create_file: 'Write',
  delete_file: 'Delete',
  file_search: 'Search',
  grep_search: 'Grep',
  multi_replace_string_in_file: 'MultiEdit',
  read_file: 'Read',
  replace_string_in_file: 'Edit',
  run_in_terminal: 'Bash',
  semantic_search: 'Search',
};

function getOptionalString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getOptionalNumber(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getTimestamp(record: CopilotTranscriptRecord, data: Record<string, unknown> | null = asRecord(record.data)): string {
  return record.timestamp || getOptionalString(data, 'timestamp') || new Date(0).toISOString();
}

function normalizeToolName(rawName: string): string {
  return TOOL_NAME_MAP[rawName] || rawName || 'tool_call';
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value)) || {};
    } catch {
      return value.trim() ? { arguments: value } : {};
    }
  }
  return asRecord(value) || {};
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

function addDetail(details: SessionToolCallDetail[], key: string, value: unknown, label = key): void {
  const stringValue = stringifyValue(value);
  if (!stringValue) return;
  details.push({ key, label, value: stringValue });
}

function getFirstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getOptionalString(args, key);
    if (value) return value;
  }
  return undefined;
}

function getFirstNumber(args: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = getOptionalNumber(args, key);
    if (value != null) return value;
  }
  return undefined;
}

function buildDiffArtifact(args: Record<string, unknown>, filePath: string | undefined): SessionArtifactDisplay | undefined {
  const oldText = getFirstString(args, ['oldString', 'old_string', 'oldText', 'old_text']);
  const newText = getFirstString(args, ['newString', 'new_string', 'newText', 'new_text', 'content']);
  if (oldText == null && newText == null) return undefined;

  const startLine = getFirstNumber(args, ['startLine', 'start_line', 'line']);
  return {
    kind: 'diff',
    title: filePath ? `Edit ${filePath}` : 'Edit',
    oldText: oldText || '',
    newText: newText || '',
    location: startLine ? `line ${startLine}` : filePath,
  };
}

function buildToolCall(rawName: string, toolCallId: string, args: Record<string, unknown>): SessionToolCallDisplay {
  const name = normalizeToolName(rawName);
  const details: SessionToolCallDetail[] = [];
  const filePath = getFirstString(args, ['filePath', 'file_path', 'path', 'targetPath']);
  const command = getFirstString(args, ['command', 'cmd']);
  const query = getFirstString(args, ['query', 'searchQuery', 'pattern']);
  const startLine = getFirstNumber(args, ['startLine', 'start_line', 'lineStart', 'line_start']);
  const endLine = getFirstNumber(args, ['endLine', 'end_line', 'lineEnd', 'line_end']);

  addDetail(details, 'tool_use_id', toolCallId, 'tool_use_id');
  addDetail(details, 'copilot_tool_name', rawName, 'copilot tool');
  addDetail(details, 'file_path', filePath, 'file_path');
  addDetail(details, 'command', command);
  addDetail(details, 'query', query);
  addDetail(details, 'startLine', startLine);
  addDetail(details, 'endLine', endLine);

  for (const [key, value] of Object.entries(args)) {
    if (details.some(detail => detail.key === key || (key === 'filePath' && detail.key === 'file_path'))) continue;
    addDetail(details, key, value);
  }

  const primary = filePath || command || query || stringifyValue(args);
  return {
    name,
    id: toolCallId,
    summary: primary ? `${name}: ${primary}` : name,
    details,
    artifact: buildDiffArtifact(args, filePath),
  };
}

function getToolRequests(data: Record<string, unknown>): SessionToolCallDisplay[] {
  const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
  return requests
    .map(request => {
      const record = asRecord(request);
      if (!record) return null;
      const toolCallId = getOptionalString(record, 'toolCallId') || getOptionalString(record, 'id');
      const name = getOptionalString(record, 'name') || getOptionalString(record, 'toolName') || 'tool_call';
      if (!toolCallId) return null;
      return buildToolCall(name, toolCallId, parseArguments(record.arguments));
    })
    .filter((tool): tool is SessionToolCallDisplay => Boolean(tool));
}

function buildToolStartCall(data: Record<string, unknown>): SessionToolCallDisplay | null {
  const toolCallId = getOptionalString(data, 'toolCallId') || getOptionalString(data, 'id');
  const name = getOptionalString(data, 'toolName') || getOptionalString(data, 'name') || 'tool_call';
  if (!toolCallId) return null;
  return buildToolCall(name, toolCallId, parseArguments(data.arguments));
}

function buildToolResultBlock(data: Record<string, unknown>, startTool?: SessionToolCallDisplay): SessionMessageBlockDisplay {
  const toolCallId = getOptionalString(data, 'toolCallId') || getOptionalString(data, 'id') || startTool?.id || '';
  const success = data.success === true;
  const failed = data.success === false;
  const status = success ? 'completed' : failed ? 'failed' : 'finished';
  const details: SessionToolCallDetail[] = [];

  addDetail(details, 'tool_use_id', toolCallId, 'tool_use_id');
  addDetail(details, 'status', status);
  if (startTool) {
    for (const detail of startTool.details) {
      if (details.some(existing => existing.key === detail.key && existing.value === detail.value)) continue;
      details.push(detail);
    }
  }
  addDetail(details, 'error', getOptionalString(data, 'error') || getOptionalString(data, 'message'));

  const content = getOptionalString(data, 'output')
    || getOptionalString(data, 'result')
    || getOptionalString(data, 'content')
    || '';

  return {
    type: 'tool-result',
    title: startTool ? `${startTool.name} result` : 'Tool result',
    summary: status,
    content,
    details,
  };
}

function createBoundedSearchCollector() {
  const parts: string[] = [];
  const seen = new Set<string>();
  let length = 0;

  return {
    add(value: string | undefined) {
      const normalized = value?.trim();
      if (!normalized || length >= SUMMARY_SEARCH_PREVIEW_LIMIT || parts.length >= SUMMARY_SEARCH_PART_LIMIT || seen.has(normalized)) return;
      seen.add(normalized);
      const remaining = SUMMARY_SEARCH_PREVIEW_LIMIT - length;
      const clipped = normalized.length > remaining ? normalized.slice(0, remaining) : normalized;
      parts.push(clipped);
      length += clipped.length + 1;
    },
    value() {
      return parts.join('\n').toLowerCase();
    },
  };
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function buildBaseSessionInfo(
  filePath: string,
  summary: CopilotParsedSessionSummary,
): Omit<SessionDetail, 'messages'> {
  const routeId = makeRouteId('copilot', summary.routeNativeId);
  const projectRouteId = qualifyProjectId('copilot', summary.nativeProjectId);
  const estimatedCosts = calculateCopilotCosts(summary.modelUsage);
  return {
    id: routeId,
    agentKind: 'copilot',
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
    estimatedCost: estimatedCosts[DEFAULT_COST_MODE],
    estimatedCosts,
    model: summary.model,
    models: summary.models,
    gitBranch: '',
    cwd: summary.cwd,
    version: summary.version,
    toolsUsed: summary.toolsUsed,
    compaction: {
      compactions: 0,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps: [],
    },
  };
}

function updateTime(record: CopilotTranscriptRecord, data: Record<string, unknown>, state: { first: string; last: string }): string {
  const timestamp = getTimestamp(record, data);
  if (timestamp) {
    if (!state.first) state.first = timestamp;
    state.last = timestamp;
  }
  return timestamp;
}

export function readCopilotRecords(filePath: string): CopilotTranscriptRecord[] {
  const records: CopilotTranscriptRecord[] = [];
  forEachCopilotJsonlLineSync(filePath, record => {
    records.push(record);
  });
  return records;
}

export function parseCopilotSessionSummaryFile(filePath: string, fileInfo: CopilotSessionFileInfo): CopilotParsedSessionSummary {
  const search = createBoundedSearchCollector();
  const chatSummary = getCopilotSidecarSummary(fileInfo);
  const toolsUsed: Record<string, number> = {};
  const seenToolCallIds = new Set<string>();
  const time = { first: fileInfo.createdAt || '', last: fileInfo.updatedAt || '' };

  let nativeId = fileInfo.nativeId || path.basename(filePath, '.jsonl');
  let version = fileInfo.version || '';
  let title = fileInfo.title || '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;

  const recordTool = (tool: SessionToolCallDisplay) => {
    if (seenToolCallIds.has(tool.id)) return;
    seenToolCallIds.add(tool.id);
    toolsUsed[tool.name] = (toolsUsed[tool.name] || 0) + 1;
    search.add(tool.name);
    search.add(tool.summary);
    for (const detail of tool.details) search.add(detail.value);
  };

  const transcriptPath = fileInfo.transcriptFilePath
    || (filePath.replace(/\\/g, '/').includes('/GitHub.copilot-chat/transcripts/') ? filePath : undefined);

  if (transcriptPath) forEachCopilotJsonlLineSync(transcriptPath, record => {
    const data = asRecord(record.data) || {};
    const timestamp = updateTime(record, data, time);

    if (record.type === 'session.start') {
      nativeId = getOptionalString(data, 'sessionId') || nativeId;
      version = getOptionalString(data, 'copilotVersion') || version;
      time.first = getOptionalString(data, 'startTime') || time.first || timestamp;
      return;
    }

    if (record.type === 'user.message') {
      const content = getOptionalString(data, 'content') || '';
      if (content) {
        userMessageCount++;
        title ||= firstLine(content);
        search.add(content);
      }
      return;
    }

    if (record.type === 'assistant.message') {
      const content = getOptionalString(data, 'content') || '';
      const reasoningText = getOptionalString(data, 'reasoningText') || '';
      assistantMessageCount++;
      search.add(content);
      search.add(reasoningText);
      for (const tool of getToolRequests(data)) recordTool(tool);
      return;
    }

    if (record.type === 'tool.execution_start') {
      const tool = buildToolStartCall(data);
      if (tool) recordTool(tool);
    }
  });

  userMessageCount ||= chatSummary.userMessageCount;
  assistantMessageCount ||= chatSummary.assistantMessageCount;
  title ||= chatSummary.title || '';
  version ||= chatSummary.version || '';
  search.add(chatSummary.searchTextPreview);

  const createdAt = time.first || fileInfo.createdAt || new Date(0).toISOString();
  const updatedAt = time.last || fileInfo.updatedAt || createdAt;
  const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(createdAt).getTime());
  const tokenUsage = toTokenUsage(chatSummary.usage);
  const modelUsage = buildCopilotModelUsage(chatSummary);

  return {
    nativeId,
    routeNativeId: `${fileInfo.workspaceHash}:${nativeId}`,
    title,
    workspaceHash: fileInfo.workspaceHash,
    nativeProjectId: fileInfo.nativeProjectId,
    projectName: fileInfo.projectName,
    cwd: fileInfo.cwd,
    version,
    createdAt,
    updatedAt,
    duration: Number.isNaN(duration) ? 0 : duration,
    userMessageCount,
    assistantMessageCount,
    messageCount: userMessageCount + assistantMessageCount,
    toolCallCount: seenToolCallIds.size,
    model: chatSummary.model,
    models: chatSummary.models,
    tokenUsage,
    reasoningOutputTokens: chatSummary.usage.reasoningOutputTokens,
    modelUsage,
    toolsUsed,
    searchTextPreview: search.value(),
  };
}

export function parseCopilotRecords(filePath: string, records: CopilotTranscriptRecord[], fileInfo: CopilotSessionFileInfo): CopilotParsedSession {
  const chatSummary = getCopilotSidecarSummary(fileInfo);
  const requestUsages = chatSummary.requests;
  const messages: SessionMessageDisplay[] = [];
  const searchableParts: string[] = [];
  const toolsUsed: Record<string, number> = {};
  const seenToolCallIds = new Set<string>();
  const startedTools = new Map<string, SessionToolCallDisplay>();
  const time = { first: fileInfo.createdAt || '', last: fileInfo.updatedAt || '' };

  let nativeId = fileInfo.nativeId || path.basename(filePath, '.jsonl');
  let version = fileInfo.version || '';
  let title = fileInfo.title || '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  const usageByAssistant = buildAssistantRequestUsageMap(records, requestUsages);

  if (records.length === 0 && chatSummary.messages.length > 0) {
    const createdAt = chatSummary.createdAt || fileInfo.createdAt || new Date(0).toISOString();
    const updatedAt = chatSummary.updatedAt || fileInfo.updatedAt || createdAt;
    const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(createdAt).getTime());
    const tokenUsage = toTokenUsage(chatSummary.usage);
    const modelUsage = buildCopilotModelUsage(chatSummary);
    const summary: CopilotParsedSessionSummary = {
      nativeId: chatSummary.nativeId || fileInfo.nativeId || path.basename(filePath, '.jsonl'),
      routeNativeId: `${fileInfo.workspaceHash}:${chatSummary.nativeId || fileInfo.nativeId || path.basename(filePath, '.jsonl')}`,
      title: chatSummary.title || fileInfo.title || '',
      workspaceHash: fileInfo.workspaceHash,
      nativeProjectId: fileInfo.nativeProjectId,
      projectName: fileInfo.projectName,
      cwd: fileInfo.cwd,
      version: chatSummary.version || fileInfo.version || '',
      createdAt,
      updatedAt,
      duration: Number.isNaN(duration) ? 0 : duration,
      userMessageCount: chatSummary.userMessageCount,
      assistantMessageCount: chatSummary.assistantMessageCount,
      messageCount: chatSummary.userMessageCount + chatSummary.assistantMessageCount,
      toolCallCount: 0,
      model: chatSummary.model,
      models: chatSummary.models,
      tokenUsage,
      reasoningOutputTokens: chatSummary.usage.reasoningOutputTokens,
      modelUsage,
      toolsUsed: {},
      searchTextPreview: chatSummary.searchTextPreview,
    };
    const info = buildBaseSessionInfo(filePath, summary);
    return {
      info,
      detail: { ...info, messages: chatSummary.messages },
      searchableText: chatSummary.searchTextPreview,
    };
  }

  const recordTool = (tool: SessionToolCallDisplay) => {
    if (seenToolCallIds.has(tool.id)) return;
    seenToolCallIds.add(tool.id);
    toolsUsed[tool.name] = (toolsUsed[tool.name] || 0) + 1;
    searchableParts.push(tool.name, tool.summary, ...tool.details.map(detail => detail.value));
  };

  for (const record of records) {
    const data = asRecord(record.data) || {};
    const timestamp = updateTime(record, data, time);

    if (record.type === 'session.start') {
      nativeId = getOptionalString(data, 'sessionId') || nativeId;
      version = getOptionalString(data, 'copilotVersion') || version;
      time.first = getOptionalString(data, 'startTime') || time.first || timestamp;
      continue;
    }

    if (record.type === 'user.message') {
      const content = getOptionalString(data, 'content') || '';
      if (!content) continue;
      userMessageCount++;
      title ||= firstLine(content);
      searchableParts.push(content);
      messages.push({ role: 'user', content, timestamp });
      continue;
    }

    if (record.type === 'assistant.message') {
      const content = getOptionalString(data, 'content') || '';
      const reasoningText = getOptionalString(data, 'reasoningText') || '';
      const toolCalls = getToolRequests(data);
      const blocks: SessionMessageBlockDisplay[] = [];
      const requestUsage = usageByAssistant.get(assistantMessageCount);
      const messageModel = requestUsage?.model || chatSummary.model;
      const usage = requestUsage ? toTokenUsage(requestUsage.usage) : { ...EMPTY_USAGE };
      const estimatedCosts = hasTokenUsage(usage) && messageModel !== 'unknown'
        ? calculateCostAllModes(
          messageModel,
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_creation_input_tokens,
          usage.cache_read_input_tokens,
        )
        : zeroCosts();
      if (reasoningText) {
        blocks.push({
          type: 'thinking',
          title: 'Reasoning',
          summary: reasoningText,
          content: reasoningText,
          details: [],
        });
      }

      assistantMessageCount++;
      searchableParts.push(content, reasoningText);
      for (const tool of toolCalls) recordTool(tool);

      messages.push({
        role: 'assistant',
        content,
        timestamp,
        model: messageModel,
        usage,
        estimatedCosts,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        blocks: blocks.length > 0 ? blocks : undefined,
      });
      continue;
    }

    if (record.type === 'tool.execution_start') {
      const tool = buildToolStartCall(data);
      if (!tool) continue;
      startedTools.set(tool.id, tool);
      if (seenToolCallIds.has(tool.id)) continue;
      recordTool(tool);
      messages.push({
        role: 'tool-use',
        content: '',
        timestamp,
        model: chatSummary.model,
        toolCalls: [tool],
      });
      continue;
    }

    if (record.type === 'tool.execution_complete') {
      const toolCallId = getOptionalString(data, 'toolCallId') || getOptionalString(data, 'id') || '';
      const block = buildToolResultBlock(data, startedTools.get(toolCallId));
      searchableParts.push(block.summary, block.content || '', ...block.details.map(detail => detail.value));
      messages.push({
        role: 'tool-result',
        content: block.summary,
        timestamp,
        blocks: [block],
      });
    }
  }

  const createdAt = time.first || fileInfo.createdAt || new Date(0).toISOString();
  const updatedAt = time.last || fileInfo.updatedAt || createdAt;
  const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(createdAt).getTime());
  const tokenUsage = toTokenUsage(chatSummary.usage);
  const modelUsage = buildCopilotModelUsage(chatSummary);
  const summary: CopilotParsedSessionSummary = {
    nativeId,
    routeNativeId: `${fileInfo.workspaceHash}:${nativeId}`,
    title,
    workspaceHash: fileInfo.workspaceHash,
    nativeProjectId: fileInfo.nativeProjectId,
    projectName: fileInfo.projectName,
    cwd: fileInfo.cwd,
    version,
    createdAt,
    updatedAt,
    duration: Number.isNaN(duration) ? 0 : duration,
    userMessageCount,
    assistantMessageCount,
    messageCount: userMessageCount + assistantMessageCount,
    toolCallCount: seenToolCallIds.size,
    model: chatSummary.model,
    models: chatSummary.models,
    tokenUsage,
    reasoningOutputTokens: chatSummary.usage.reasoningOutputTokens,
    modelUsage,
    toolsUsed,
    searchTextPreview: searchableParts.join('\n').toLowerCase().slice(0, SUMMARY_SEARCH_PREVIEW_LIMIT),
  };
  const info = buildBaseSessionInfo(filePath, summary);

  return {
    info,
    detail: { ...info, messages },
    searchableText: searchableParts.join('\n').toLowerCase(),
  };
}

export async function parseCopilotSessionFile(filePath: string, fileInfo: CopilotSessionFileInfo): Promise<CopilotParsedSession> {
  return parseCopilotRecords(filePath, readCopilotRecords(filePath), fileInfo);
}

export function getCopilotZeroUsage(): TokenUsage {
  return { ...EMPTY_USAGE };
}
