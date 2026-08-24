import fs from 'fs';
import type { SessionMessageBlockDisplay, SessionMessageDisplay, SessionMessageImageDisplay, TokenUsage } from '@/lib/claude-data/types';
import { calculateCostAllModes } from '@/config/pricing';
import { zeroCosts } from '@/lib/claude-data/cost-utils';
import { asRecord, getFileSignature, signatureToString } from './io';
import { dedupeImages, extractCopilotImages, summarizeImages } from '@/lib/session-images';

const JSONL_READ_CHUNK_SIZE = 1024 * 1024;

export interface CopilotUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
}

export interface CopilotModelUsage extends CopilotUsageTotals {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface CopilotRequestUsage {
  index: number;
  requestId?: string;
  model: string;
  usage: CopilotUsageTotals;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface CopilotSubagentInvocation {
  invocationId: string;
  requestIndex: number;
  parentInvocationId?: string;
  agentName?: string;
  model?: string;
}

export interface CopilotChatSessionSummary {
  nativeId?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: string;
  selectedModel?: string;
  model: string;
  models: string[];
  userMessageCount: number;
  assistantMessageCount: number;
  usage: CopilotUsageTotals;
  modelUsage: Record<string, CopilotModelUsage>;
  requests: CopilotRequestUsage[];
  subagents: CopilotSubagentInvocation[];
  messages: SessionMessageDisplay[];
  searchTextPreview: string;
}

interface VscodeChatSessionRecord {
  kind?: number;
  k?: Array<string | number>;
  v?: unknown;
}

interface ModelDetails {
  model: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface ChatSessionParseState {
  nativeId?: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  version?: string;
  selectedModel?: string;
  requestCount: number;
  requestIds: Map<number, string>;
  requestModels: Map<number, string>;
  requestMessages: Map<number, { content: string; timestamp?: string; images?: SessionMessageImageDisplay[] }>;
  responseMessages: Map<number, string>;
  toolResultMessages: Map<number, SessionMessageDisplay[]>;
  requestUsage: Map<number, CopilotUsageTotals>;
  completionTokenFallback: Map<number, number>;
  subagents: Map<string, CopilotSubagentInvocation>;
  modelDetails: Map<string, ModelDetails>;
  inputImages: SessionMessageImageDisplay[];
}

interface CachedChatSessionSummary {
  signature: string;
  value: CopilotChatSessionSummary;
}

const chatSessionCache = new Map<string, CachedChatSessionSummary>();

const EMPTY_USAGE: CopilotUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
};

const SEARCH_PREVIEW_LIMIT = 8 * 1024;

function getOptionalString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getOptionalNumber(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function dateFromMs(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function updateTimestamp(state: ChatSessionParseState, timestamp: string | undefined): void {
  if (!timestamp) return;
  if (!state.createdAt || timestamp < state.createdAt) state.createdAt = timestamp;
  if (!state.updatedAt || timestamp > state.updatedAt) state.updatedAt = timestamp;
}

function normalizeCopilotModelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase().startsWith('copilot/') ? trimmed.slice('copilot/'.length) : trimmed;
}

function normalizeSubagentModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^copilot\//i, '');
  return trimmed ? trimmed.toLowerCase().replace(/\s+/g, '-') : undefined;
}

function zeroUsage(): CopilotUsageTotals {
  return { ...EMPTY_USAGE };
}

function addUsage(target: CopilotUsageTotals, usage: CopilotUsageTotals): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadInputTokens += usage.cacheReadInputTokens;
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
}

function hasUsage(usage: CopilotUsageTotals): boolean {
  return usage.inputTokens > 0
    || usage.outputTokens > 0
    || usage.cacheReadInputTokens > 0
    || usage.cacheCreationInputTokens > 0
    || usage.reasoningOutputTokens > 0;
}

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

function getTextValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(getTextValue).filter(Boolean).join('\n').trim();
  }

  const record = asRecord(value);
  if (!record) return '';
  return getOptionalString(record, 'text')
    || getOptionalString(record, 'value')
    || getOptionalString(record, 'message')
    || '';
}

function collectResponseText(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const blocks = Array.isArray(value) ? value : [value];

  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) {
      const text = getTextValue(block);
      if (text && !seen.has(text)) {
        seen.add(text);
        parts.push(text);
      }
      continue;
    }

    const kind = getOptionalString(record, 'kind');
    if (kind === 'toolInvocationSerialized') {
      const invocation = getTextValue(record.invocationMessage);
      const result = getTextValue(record.pastTenseMessage);
      for (const text of [invocation, result]) {
        if (text && !seen.has(text)) {
          seen.add(text);
          parts.push(text);
        }
      }
      continue;
    }

    const text = getTextValue(record);
    if (text && !seen.has(text)) {
      seen.add(text);
      parts.push(text);
    }
  }

  return parts.join('\n\n').trim();
}

function optionalImages(images: SessionMessageImageDisplay[]): SessionMessageImageDisplay[] | undefined {
  return images.length > 0 ? images : undefined;
}

function getToolResultContent(value: unknown): string {
  const record = asRecord(value);
  if (!record) return collectResponseText(value);

  return collectResponseText(record.content)
    || getTextValue(record.message)
    || getTextValue(record.result)
    || '';
}

function buildImageToolResultMessage(
  toolUseId: string,
  value: unknown,
  timestamp: string | undefined,
): SessionMessageDisplay | null {
  const images = extractCopilotImages(value, 'Tool result image');
  if (images.length === 0) return null;

  const details = toolUseId
    ? [{ key: 'tool_use_id', label: 'tool_use_id', value: toolUseId }]
    : [];
  const block: SessionMessageBlockDisplay = {
    type: 'tool-result',
    title: 'Tool result',
    summary: summarizeImages(images),
    content: getToolResultContent(value),
    details,
    images,
  };

  return {
    role: 'tool-result',
    content: block.summary,
    timestamp: timestamp || new Date(0).toISOString(),
    blocks: [block],
  };
}

function buildToolResultImageMessages(value: unknown, timestamp?: string): SessionMessageDisplay[] {
  const record = asRecord(value);
  const metadata = asRecord(record?.metadata);
  const toolCallResults = asRecord(metadata?.toolCallResults);
  const messages: SessionMessageDisplay[] = [];

  if (toolCallResults) {
    for (const [toolUseId, result] of Object.entries(toolCallResults)) {
      const message = buildImageToolResultMessage(toolUseId, result, timestamp);
      if (message) messages.push(message);
    }
  }

  if (messages.length === 0) {
    const message = buildImageToolResultMessage('', value, timestamp);
    if (message) messages.push(message);
  }

  return messages;
}

function extractRequestImages(record: Record<string, unknown>): SessionMessageImageDisplay[] {
  return dedupeImages([
    ...extractCopilotImages(record.message),
    ...extractCopilotImages(record.variableData),
    ...extractCopilotImages(record.inputState),
    ...extractCopilotImages(record.attachments),
  ]);
}

function parseChatSessionLine(line: string): VscodeChatSessionRecord | null {
  if (!line.trim()) return null;
  try {
    const record = asRecord(JSON.parse(line));
    if (!record) return null;
    const path = Array.isArray(record.k)
      ? record.k.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
      : undefined;
    return {
      kind: typeof record.kind === 'number' ? record.kind : undefined,
      k: path,
      v: record.v,
    };
  } catch {
    // VS Code can leave a partial final JSONL line while the window is open.
    return null;
  }
}

function forEachChatSessionLineSync(filePath: string, callback: (record: VscodeChatSessionRecord) => void): void {
  if (!fs.existsSync(filePath)) return;

  const buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_SIZE);
  const fd = fs.openSync(filePath, 'r');
  let carry = '';

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      carry += buffer.subarray(0, bytesRead).toString('utf-8');
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseChatSessionLine(line);
        if (parsed) callback(parsed);
      }
    }

    const parsed = parseChatSessionLine(carry);
    if (parsed) callback(parsed);
  } finally {
    fs.closeSync(fd);
  }
}

function getModelDetailsFromSelection(value: unknown): ModelDetails | null {
  const record = asRecord(value);
  if (!record) return null;

  const metadata = asRecord(record.metadata);
  const model = normalizeCopilotModelId(
    getOptionalString(metadata, 'id')
    || getOptionalString(record, 'identifier')
    || getOptionalString(record, 'modelId'),
  );
  if (!model) return null;

  return {
    model,
    contextWindow: getOptionalNumber(metadata, 'maxInputTokens')
      || getOptionalNumber(metadata, 'maxPromptTokens')
      || getOptionalNumber(metadata, 'max_context_window_tokens')
      || getOptionalNumber(metadata, 'max_prompt_tokens'),
    maxOutputTokens: getOptionalNumber(metadata, 'maxOutputTokens')
      || getOptionalNumber(metadata, 'max_output_tokens'),
  };
}

export function isCopilotChatSessionFile(filePath: string): boolean {
  try {
    const reader = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(32 * 1024);
      const bytesRead = fs.readSync(reader, buffer, 0, buffer.length, 0);
      const prefix = buffer.subarray(0, bytesRead).toString('utf-8');
      return /GitHub Copilot|copilot\//i.test(prefix);
    } finally {
      fs.closeSync(reader);
    }
  } catch {
    return false;
  }
}

function getModelFromRequest(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return normalizeCopilotModelId(
    getOptionalString(record, 'modelId')
    || getOptionalString(record, 'model')
    || getOptionalString(asRecord(record.model), 'identifier'),
  );
}

function recordSelectedModel(state: ChatSessionParseState, value: unknown): void {
  const details = getModelDetailsFromSelection(value);
  if (!details) return;
  state.selectedModel = details.model;
  state.modelDetails.set(details.model, details);
}

function readUsageNumber(record: Record<string, unknown> | null | undefined, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = getOptionalNumber(record, key);
    if (value != null) return Math.max(0, value);
  }
  return undefined;
}

function parseUsageObject(value: unknown): CopilotUsageTotals | null {
  const record = asRecord(value);
  if (!record) return null;

  const hasInputOrTotalUsage = typeof record.prompt_tokens === 'number'
    || typeof record.promptTokens === 'number'
    || typeof record.input_tokens === 'number'
    || typeof record.inputTokens === 'number'
    || typeof record.total_tokens === 'number'
    || typeof record.totalTokens === 'number';
  if (!hasInputOrTotalUsage) return null;

  const promptDetails = asRecord(record.prompt_tokens_details) || asRecord(record.promptTokensDetails);
  const completionDetails = asRecord(record.completion_tokens_details) || asRecord(record.completionTokensDetails);
  const totalTokens = readUsageNumber(record, ['total_tokens', 'totalTokens']);
  const outputTokens = readUsageNumber(record, ['completion_tokens', 'outputTokens', 'output_tokens'])
    ?? (totalTokens != null && typeof record.prompt_tokens === 'number' ? Math.max(0, totalTokens - record.prompt_tokens) : undefined)
    ?? 0;
  const cacheReadInputTokens = readUsageNumber(promptDetails, ['cached_tokens', 'cachedTokens'])
    ?? readUsageNumber(record, ['cached_tokens', 'cachedTokens', 'cachedInputTokens', 'cacheReadInputTokens'])
    ?? 0;
  const explicitInputTokens = readUsageNumber(record, ['inputTokens']);
  const rawPromptTokens = readUsageNumber(record, ['prompt_tokens', 'promptTokens', 'input_tokens']);
  const inputTokens = explicitInputTokens
    ?? (rawPromptTokens != null
      ? Math.max(0, rawPromptTokens - Math.min(cacheReadInputTokens, rawPromptTokens))
      : totalTokens != null ? Math.max(0, totalTokens - outputTokens - cacheReadInputTokens) : 0);

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens: readUsageNumber(record, ['cacheCreationInputTokens', 'cache_creation_input_tokens']) ?? 0,
    reasoningOutputTokens: readUsageNumber(completionDetails, ['reasoning_tokens', 'reasoningTokens'])
      ?? readUsageNumber(record, ['reasoning_tokens', 'reasoningTokens', 'reasoningOutputTokens'])
      ?? 0,
  };
}

function getRecordedRequestUsage(state: ChatSessionParseState, index: number): CopilotUsageTotals | null {
  const usage = state.requestUsage.get(index);
  if (!usage) return null;

  return {
    ...usage,
    outputTokens: usage.outputTokens || state.completionTokenFallback.get(index) || 0,
  };
}

function collectUsageObjects(value: unknown, totals = zeroUsage()): CopilotUsageTotals {
  const usage = parseUsageObject(value);
  if (usage) {
    addUsage(totals, usage);
    return totals;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectUsageObjects(item, totals);
    return totals;
  }

  const record = asRecord(value);
  if (!record) return totals;
  for (const child of Object.values(record)) collectUsageObjects(child, totals);
  return totals;
}

function recordSubagentInvocations(state: ChatSessionParseState, requestIndex: number, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) recordSubagentInvocations(state, requestIndex, item);
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  if (getOptionalString(record, 'toolId') === 'runSubagent') {
    const invocationId = getOptionalString(record, 'toolCallId');
    if (invocationId) {
      const existing = state.subagents.get(invocationId);
      const toolSpecificData = asRecord(record.toolSpecificData);
      state.subagents.set(invocationId, {
        invocationId,
        requestIndex,
        parentInvocationId: getOptionalString(record, 'subAgentInvocationId') || existing?.parentInvocationId,
        agentName: getOptionalString(toolSpecificData, 'agentName') || existing?.agentName,
        model: normalizeSubagentModel(getOptionalString(toolSpecificData, 'modelName')) || existing?.model,
      });
    }
  }

  for (const child of Object.values(record)) recordSubagentInvocations(state, requestIndex, child);
}

function recordRequestObject(state: ChatSessionParseState, index: number, value: unknown): void {
  const record = asRecord(value);
  if (!record) return;

  const requestId = getOptionalString(record, 'requestId');
  if (requestId) state.requestIds.set(index, requestId);

  const timestamp = dateFromMs(record.timestamp);
  updateTimestamp(state, timestamp);

  const version = getOptionalString(asRecord(record.agent), 'extensionVersion');
  if (version) state.version = version;

  const message = getTextValue(record.message);
  const requestImagesFromRecord = extractRequestImages(record);
  const usedInputImages = requestImagesFromRecord.length === 0 && state.inputImages.length > 0;
  const requestImages = requestImagesFromRecord.length > 0
    ? requestImagesFromRecord
    : state.inputImages;
  if (state.inputImages.length > 0 && (usedInputImages || requestImagesFromRecord.length > 0 || message)) {
    state.inputImages = [];
  }

  if (message || requestImages.length > 0) {
    state.requestMessages.set(index, {
      content: message,
      timestamp,
      images: optionalImages(requestImages),
    });
    state.title ||= firstLine(message);
  }

  const response = collectResponseText(record.response);
  if (response) state.responseMessages.set(index, response);
  recordSubagentInvocations(state, index, record.response);

  const toolResultMessages = buildToolResultImageMessages(record.result, timestamp);
  if (toolResultMessages.length > 0) state.toolResultMessages.set(index, toolResultMessages);

  const model = getModelFromRequest(record) || state.selectedModel;
  if (model) state.requestModels.set(index, model);

  const completionTokens = getOptionalNumber(record, 'completionTokens');
  if (completionTokens != null) state.completionTokenFallback.set(index, Math.max(0, completionTokens));

  const usage = collectUsageObjects(record);
  if (hasUsage(usage)) state.requestUsage.set(index, usage);
}

function applyFullState(state: ChatSessionParseState, value: unknown): void {
  const record = asRecord(value);
  if (!record) return;

  state.nativeId = getOptionalString(record, 'sessionId') || state.nativeId;
  updateTimestamp(state, dateFromMs(record.creationDate));

  const inputState = asRecord(record.inputState);
  recordSelectedModel(state, inputState?.selectedModel);

  const requests = Array.isArray(record.requests) ? record.requests : [];
  state.requestCount = Math.max(state.requestCount, requests.length);
  requests.forEach((request, index) => recordRequestObject(state, index, request));
}

function applyPatch(state: ChatSessionParseState, record: VscodeChatSessionRecord): void {
  const keyPath = record.k || [];
  if (keyPath.length === 0) return;

  if (keyPath[0] === 'inputState' && keyPath[1] === 'selectedModel') {
    recordSelectedModel(state, record.v);
    return;
  }

  if (keyPath[0] === 'inputState' && keyPath[1] === 'attachments') {
    state.inputImages = extractCopilotImages(record.v);
    return;
  }

  if (keyPath[0] !== 'requests') return;

  if (record.kind === 2 && keyPath.length === 1 && Array.isArray(record.v)) {
    for (const request of record.v) {
      const index = state.requestCount;
      state.requestCount += 1;
      recordRequestObject(state, index, request);
    }
    return;
  }

  const requestIndex = typeof keyPath[1] === 'number' ? keyPath[1] : null;
  if (requestIndex == null) return;

  if (keyPath.length === 2) {
    recordRequestObject(state, requestIndex, record.v);
    return;
  }

  if (keyPath[2] === 'modelId' && typeof record.v === 'string') {
    const model = normalizeCopilotModelId(record.v);
    if (model) state.requestModels.set(requestIndex, model);
    return;
  }

  if (keyPath[2] === 'response') {
    const response = collectResponseText(record.v);
    if (response) state.responseMessages.set(requestIndex, response);
    recordSubagentInvocations(state, requestIndex, record.v);
    return;
  }

  if (keyPath[2] === 'completionTokens' && typeof record.v === 'number') {
    state.completionTokenFallback.set(requestIndex, Math.max(0, record.v));
    return;
  }

  if (keyPath[2] === 'result' || keyPath[2] === 'usage') {
    if (keyPath[2] === 'result') {
      const timestamp = state.requestMessages.get(requestIndex)?.timestamp || state.updatedAt || state.createdAt;
      const toolResultMessages = buildToolResultImageMessages(record.v, timestamp);
      if (toolResultMessages.length > 0) state.toolResultMessages.set(requestIndex, toolResultMessages);
    }

    const usage = collectUsageObjects(record.v);
    if (hasUsage(usage)) state.requestUsage.set(requestIndex, usage);
  }
}

function choosePrimaryModel(modelUsage: Record<string, CopilotModelUsage>, requests: CopilotRequestUsage[], selectedModel?: string): string {
  let bestModel = '';
  let bestTokens = -1;

  for (const [model, usage] of Object.entries(modelUsage)) {
    const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    if (tokens > bestTokens) {
      bestTokens = tokens;
      bestModel = model;
    }
  }

  return bestModel || requests.at(-1)?.model || selectedModel || 'unknown';
}

function buildSummary(state: ChatSessionParseState): CopilotChatSessionSummary {
  const requests: CopilotRequestUsage[] = [];
  const messages: SessionMessageDisplay[] = [];
  const usage = zeroUsage();
  const modelUsage: Record<string, CopilotModelUsage> = {};
  const requestIndexes = new Set<number>([
    ...state.requestModels.keys(),
    ...state.requestUsage.keys(),
  ]);

  for (const index of Array.from(requestIndexes).sort((left, right) => left - right)) {
    const requestUsage = getRecordedRequestUsage(state, index);
    if (!requestUsage) continue;
    if (!hasUsage(requestUsage)) continue;

    const model = state.requestModels.get(index) || state.selectedModel || 'unknown';
    const details = state.modelDetails.get(model);
    addUsage(usage, requestUsage);

    const existing = modelUsage[model] || {
      ...EMPTY_USAGE,
      contextWindow: details?.contextWindow,
      maxOutputTokens: details?.maxOutputTokens,
    };
    addUsage(existing, requestUsage);
    existing.contextWindow ||= details?.contextWindow;
    existing.maxOutputTokens ||= details?.maxOutputTokens;
    modelUsage[model] = existing;

    requests.push({
      index,
      requestId: state.requestIds.get(index),
      model,
      usage: requestUsage,
      contextWindow: details?.contextWindow,
      maxOutputTokens: details?.maxOutputTokens,
    });
  }

  const messageIndexes = new Set<number>([
    ...state.requestMessages.keys(),
    ...state.responseMessages.keys(),
    ...state.toolResultMessages.keys(),
    ...requestIndexes,
  ]);
  for (const index of Array.from(messageIndexes).sort((left, right) => left - right)) {
    const request = state.requestMessages.get(index);
    const model = state.requestModels.get(index) || state.selectedModel || 'unknown';
    const requestUsage = getRecordedRequestUsage(state, index) || EMPTY_USAGE;
    const usageForMessage = toTokenUsage(requestUsage);
    const estimatedCosts = hasTokenUsage(usageForMessage) && model !== 'unknown'
      ? calculateCostAllModes(
        model,
        usageForMessage.input_tokens,
        usageForMessage.output_tokens,
        usageForMessage.cache_creation_input_tokens,
        usageForMessage.cache_read_input_tokens,
      )
      : zeroCosts();

    if (request && (request.content || request.images?.length)) {
      messages.push({
        role: 'user',
        content: request.content,
        timestamp: request.timestamp || state.createdAt || new Date(0).toISOString(),
        images: request.images,
      });
    }

    const response = state.responseMessages.get(index);
    if (response || hasUsage(requestUsage)) {
      messages.push({
        role: 'assistant',
        content: response || '',
        timestamp: request?.timestamp || state.updatedAt || state.createdAt || new Date(0).toISOString(),
        model,
        usage: usageForMessage,
        estimatedCosts,
      });
    }

    const toolMessages = state.toolResultMessages.get(index) || [];
    messages.push(...toolMessages);
  }

  const models = Array.from(new Set([
    ...Object.keys(modelUsage),
    ...Array.from(state.requestModels.values()),
    state.selectedModel,
    ...Array.from(state.subagents.values()).map(subagent => subagent.model),
  ].filter((model): model is string => Boolean(model && model !== 'unknown'))));

  return {
    nativeId: state.nativeId,
    title: state.title,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    version: state.version,
    selectedModel: state.selectedModel,
    model: choosePrimaryModel(modelUsage, requests, state.selectedModel),
    models,
    userMessageCount: state.requestMessages.size || requests.length,
    assistantMessageCount: Math.max(state.responseMessages.size, requests.length),
    usage,
    modelUsage,
    requests,
    subagents: Array.from(state.subagents.values()),
    messages,
    searchTextPreview: Array.from(new Set([
      state.title,
      ...Array.from(state.requestMessages.values()).map(message => message.content),
      ...Array.from(state.responseMessages.values()),
      ...Array.from(state.toolResultMessages.values()).flat().map(message => message.content),
      ...Array.from(state.toolResultMessages.values()).flatMap(messages =>
        messages.flatMap(message => message.blocks?.map(block => block.summary) || []),
      ),
      ...models,
      ...Array.from(state.subagents.values()).map(subagent => subagent.agentName),
    ].filter((value): value is string => Boolean(value?.trim()))))
      .join('\n')
      .toLowerCase()
      .slice(0, SEARCH_PREVIEW_LIMIT),
  };
}

function parseCopilotChatSessionFile(filePath: string): CopilotChatSessionSummary {
  const state: ChatSessionParseState = {
    requestCount: 0,
    requestIds: new Map(),
    requestModels: new Map(),
    requestMessages: new Map(),
    responseMessages: new Map(),
    toolResultMessages: new Map(),
    requestUsage: new Map(),
    completionTokenFallback: new Map(),
    subagents: new Map(),
    modelDetails: new Map(),
    inputImages: [],
  };

  forEachChatSessionLineSync(filePath, record => {
    if (record.kind === 0) {
      applyFullState(state, record.v);
    } else {
      applyPatch(state, record);
    }
  });

  return buildSummary(state);
}

export function getCopilotChatSessionSummary(filePath: string | undefined): CopilotChatSessionSummary {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      model: 'unknown',
      models: [],
      userMessageCount: 0,
      assistantMessageCount: 0,
      usage: zeroUsage(),
      modelUsage: {},
      requests: [],
      subagents: [],
      messages: [],
      searchTextPreview: '',
    };
  }

  const signature = signatureToString(getFileSignature(filePath));
  const cached = chatSessionCache.get(filePath);
  if (cached?.signature === signature) return cached.value;

  const value = parseCopilotChatSessionFile(filePath);
  chatSessionCache.set(filePath, { signature, value });
  return value;
}

export function resetCopilotChatSessionCache(): void {
  chatSessionCache.clear();
}

export function resetCopilotChatSessionCacheForTests(): void {
  resetCopilotChatSessionCache();
}
