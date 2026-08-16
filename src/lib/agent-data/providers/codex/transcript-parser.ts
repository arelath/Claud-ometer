import path from 'path';
import { calculateCostAllModes, DEFAULT_COST_MODE, getModelDisplayName } from '@/config/pricing';
import { zeroCosts } from '@/lib/claude-data/cost-utils';
import type {
  SessionDetail,
  SessionInfo,
  SessionMessageImageDisplay,
  SessionMessageBlockDisplay,
  SessionMessageDisplay,
  SessionPromptTokenBreakdown,
  SessionSubagentDisplay,
  TokenUsage,
} from '@/lib/claude-data/types';
import type { CachedModelUsage } from '@/lib/agent-data/session-summary';
import { makeRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import { asRecord, getCodexPayloadKind, type CodexEnvelope } from './schema';
import {
  collectCodexToolResults,
  buildCodexPatchResultToolCalls,
  buildCodexToolCalls,
  buildCodexToolResultBlock,
  isCodexEnrichedToolResult,
} from './tool-parser';
import { forEachCodexJsonlLineSync } from './io';
import type { CodexSessionFileInfo } from './session-index';

export interface CodexParsedSession {
  info: SessionInfo;
  detail: SessionDetail;
  searchableText: string;
  reasoningOutputTokens: number;
  modelUsage: Record<string, CachedModelUsage>;
}

export interface CodexParsedSessionSummary {
  nativeId: string;
  title?: string;
  cwd: string;
  gitBranch: string;
  version: string;
  model: string;
  models: string[];
  createdAt: string;
  updatedAt: string;
  duration: number;
  userMessageCount: number;
  assistantMessageCount: number;
  messageCount: number;
  toolCallCount: number;
  tokenUsage: TokenUsage;
  reasoningOutputTokens: number;
  toolsUsed: Record<string, number>;
  compaction: {
    compactions: number;
    microcompactions: number;
    totalTokensSaved: number;
    compactionTimestamps: string[];
  };
  searchTextPreview: string;
}

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

type CodexCompactionSource = 'context_compacted' | 'compacted';

const CODEX_COMPACTION_DUPLICATE_WINDOW_MS = 1000;
const SUMMARY_SEARCH_PREVIEW_LIMIT = 8 * 1024;
const SUMMARY_SEARCH_PART_LIMIT = 256;
const CHARS_PER_TOKEN = 4;

function getOptionalString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getTimestamp(record: CodexEnvelope, payload: Record<string, unknown> | null = asRecord(record.payload)): string {
  return getOptionalString(record as unknown as Record<string, unknown>, 'timestamp')
    || getOptionalString(payload, 'timestamp')
    || new Date(0).toISOString();
}

function parseTimestampMs(timestamp: string): number | null {
  const ms = new Date(timestamp).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function getContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    const type = getOptionalString(record, 'type');
    if ((type === 'input_text' || type === 'output_text' || type === 'text' || type === 'summary_text') && typeof record.text === 'string') {
      parts.push(record.text);
    } else if (type === 'input_image') {
      const mediaType = getOptionalString(record, 'media_type') || getOptionalString(record, 'mime_type') || 'image';
      parts.push(`[${mediaType} input omitted]`);
    }
  }
  return parts.join('\n').trim();
}

function getDataImageMediaType(url: string): string | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(url.trim());
  return match?.[1].toLowerCase() || null;
}

function getImageUrl(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  const url = record?.url;
  return typeof url === 'string' ? url : null;
}

function getContentImages(content: unknown): SessionMessageImageDisplay[] {
  if (!Array.isArray(content)) return [];

  const images: SessionMessageImageDisplay[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record || getOptionalString(record, 'type') !== 'input_image') continue;

    const url = getImageUrl(record.image_url ?? record.image);
    if (!url) continue;

    const mediaType = getOptionalString(record, 'media_type')
      || getOptionalString(record, 'mime_type')
      || getDataImageMediaType(url);
    if (!mediaType?.startsWith('image/')) continue;

    images.push({
      url,
      mediaType,
      label: `Image ${images.length + 1}`,
    });
  }
  return images;
}

function getImagePlaceholder(payload: Record<string, unknown>): string {
  const images = Array.isArray(payload.images) ? payload.images : [];
  const localImages = Array.isArray(payload.local_images) ? payload.local_images : [];
  const count = images.length + localImages.length;
  if (count === 0) return '';
  return count === 1 ? '[image input omitted]' : `[${count} image inputs omitted]`;
}

function getUserMessageText(payload: Record<string, unknown>): string {
  const parts = [
    getContentText(payload.content ?? payload.message),
    getContentText(payload.text_elements),
    getImagePlaceholder(payload),
  ].filter(Boolean);
  return Array.from(new Set(parts)).join('\n').trim();
}

function getUserMessageImages(payload: Record<string, unknown>): SessionMessageImageDisplay[] {
  return [
    ...getContentImages(payload.content ?? payload.message),
    ...getContentImages(payload.text_elements),
  ];
}

function getReasoningText(payload: Record<string, unknown>): string {
  return getContentText(payload.summary)
    || getContentText(payload.content)
    || getOptionalString(payload, 'text')
    || '';
}

function parseTokenUsage(value: unknown): CodexTokenUsage {
  const record = asRecord(value);
  if (!record) return {};
  return {
    input_tokens: typeof record.input_tokens === 'number' ? record.input_tokens : 0,
    cached_input_tokens: typeof record.cached_input_tokens === 'number' ? record.cached_input_tokens : 0,
    output_tokens: typeof record.output_tokens === 'number' ? record.output_tokens : 0,
    reasoning_output_tokens: typeof record.reasoning_output_tokens === 'number' ? record.reasoning_output_tokens : 0,
  };
}

function addTokenUsage(target: CodexTokenUsage, usage: CodexTokenUsage): void {
  target.input_tokens = (target.input_tokens || 0) + (usage.input_tokens || 0);
  target.cached_input_tokens = (target.cached_input_tokens || 0) + (usage.cached_input_tokens || 0);
  target.output_tokens = (target.output_tokens || 0) + (usage.output_tokens || 0);
  target.reasoning_output_tokens = (target.reasoning_output_tokens || 0) + (usage.reasoning_output_tokens || 0);
}

function hasTokenUsage(usage: CodexTokenUsage | null | undefined): boolean {
  return Boolean((usage?.input_tokens || 0) > 0
    || (usage?.cached_input_tokens || 0) > 0
    || (usage?.output_tokens || 0) > 0
    || (usage?.reasoning_output_tokens || 0) > 0);
}

function tokenUsageDelta(current: CodexTokenUsage, previous: CodexTokenUsage | null): CodexTokenUsage {
  if (!previous) return { ...current };
  return {
    input_tokens: Math.max((current.input_tokens || 0) - (previous.input_tokens || 0), 0),
    cached_input_tokens: Math.max((current.cached_input_tokens || 0) - (previous.cached_input_tokens || 0), 0),
    output_tokens: Math.max((current.output_tokens || 0) - (previous.output_tokens || 0), 0),
    reasoning_output_tokens: Math.max((current.reasoning_output_tokens || 0) - (previous.reasoning_output_tokens || 0), 0),
  };
}

function estimateTokens(text: string): number {
  return text.length > 0 ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

function getTokenUsageFromCountPayload(payload: Record<string, unknown>): CodexTokenUsage {
  const info = asRecord(payload.info);
  return parseTokenUsage(info?.total_token_usage ?? payload.total_token_usage);
}

function hasTotalTokenUsagePayload(payload: Record<string, unknown>): boolean {
  const info = asRecord(payload.info);
  return Boolean(info?.total_token_usage || payload.total_token_usage);
}

function getLastTokenUsageFromCountPayload(payload: Record<string, unknown>): CodexTokenUsage | null {
  const info = asRecord(payload.info);
  const source = info?.last_token_usage ?? payload.last_token_usage;
  if (!source) return null;
  return parseTokenUsage(source);
}

function toClaudeUsage(usage: CodexTokenUsage): TokenUsage {
  const rawInputTokens = Math.max(usage.input_tokens || 0, 0);
  const rawCacheReadTokens = Math.max(usage.cached_input_tokens || 0, 0);
  const reasoningOutputTokens = Math.max(usage.reasoning_output_tokens || 0, 0);
  const outputTokens = Math.max(usage.output_tokens || 0, reasoningOutputTokens);
  // Codex total input includes cached input, and reasoning output is a detail of output.
  const freshInputTokens = rawCacheReadTokens <= rawInputTokens
    ? rawInputTokens - rawCacheReadTokens
    : rawInputTokens;

  return {
    input_tokens: freshInputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: rawCacheReadTokens,
  };
}

function buildCodexPromptBreakdown(usage: CodexTokenUsage): SessionPromptTokenBreakdown | null {
  const rawInputTokens = Math.max(usage.input_tokens || 0, 0);
  if (rawInputTokens === 0) return null;

  const cacheReadTokens = Math.min(Math.max(usage.cached_input_tokens || 0, 0), rawInputTokens);
  return {
    totalTokens: rawInputTokens,
    systemTokens: 0,
    conversationTokens: rawInputTokens - cacheReadTokens,
    filesTokens: 0,
    cacheReadTokens,
    thinkingTokens: 0,
    toolTokens: 0,
    otherTokens: 0,
  };
}

function attachCodexTurnUsage(message: SessionMessageDisplay, usage: CodexTokenUsage, model: string): void {
  const normalizedUsage = toClaudeUsage(usage);
  const hasTokens = normalizedUsage.input_tokens > 0
    || normalizedUsage.output_tokens > 0
    || normalizedUsage.cache_read_input_tokens > 0
    || normalizedUsage.cache_creation_input_tokens > 0;
  if (!hasTokens) return;

  message.usage = normalizedUsage;
  message.estimatedCosts = model === 'unknown'
    ? zeroCosts()
    : calculateCostAllModes(
      model,
      normalizedUsage.input_tokens,
      normalizedUsage.output_tokens,
      normalizedUsage.cache_creation_input_tokens,
      normalizedUsage.cache_read_input_tokens,
    );
}

function getProjectNativeId(cwd: string, fallbackFilePath: string): string {
  const source = cwd || path.dirname(fallbackFilePath);
  return source.replace(/^[A-Za-z]:/, match => match[0]).replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '') || 'codex';
}

function makeEventBlock(title: string, summary: string, details: Array<{ key: string; value: string }>): SessionMessageBlockDisplay {
  return {
    type: 'event',
    title,
    summary,
    details: details.map(item => ({ key: item.key, label: item.key, value: item.value })),
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

function shouldSkipDuplicateAssistant(seen: Set<string>, text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (seen.has(normalized)) return true;
  seen.add(normalized);
  return false;
}

export function readCodexRecordsSync(filePath: string): CodexEnvelope[] {
  const records: CodexEnvelope[] = [];
  forEachCodexJsonlLineSync(filePath, record => {
    records.push(record);
  });
  return records;
}

export async function readCodexRecords(filePath: string): Promise<CodexEnvelope[]> {
  return readCodexRecordsSync(filePath);
}

function getSummaryToolName(payload: Record<string, unknown>): string {
  return getOptionalString(payload, 'name') || getOptionalString(payload, 'type') || 'tool_call';
}

export function parseCodexSessionSummaryFile(filePath: string, fileInfo?: CodexSessionFileInfo): CodexParsedSessionSummary {
  const search = createBoundedSearchCollector();
  const seenAssistantText = new Set<string>();
  const toolsUsed: Record<string, number> = {};
  const modelsSet = new Set<string>();

  let nativeId = fileInfo?.nativeId || path.basename(filePath, '.jsonl');
  let cwd = fileInfo?.cwd || '';
  let gitBranch = fileInfo?.gitBranch || '';
  let version = fileInfo?.version || '';
  let model = fileInfo?.model || 'unknown';
  let firstTimestamp = fileInfo?.createdAt || '';
  let lastTimestamp = fileInfo?.updatedAt || '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let toolCallCount = 0;
  let finalTokenUsage: CodexTokenUsage = {};
  let hasCumulativeTokenUsage = false;
  const accountedTokenUsage: CodexTokenUsage = {};
  const estimatedTokenUsage: CodexTokenUsage = {};
  let compactions = 0;
  const compactionTimestamps: string[] = [];
  const compactionEvents: Array<{ time: number; source: CodexCompactionSource }> = [];
  let hasSessionMetadata = false;

  const recordCompaction = (timestamp: string, source: CodexCompactionSource) => {
    const time = parseTimestampMs(timestamp);
    const duplicate = time == null
      ? undefined
      : compactionEvents.find(event => (
          event.source !== source
          && Math.abs(event.time - time) <= CODEX_COMPACTION_DUPLICATE_WINDOW_MS
        ));
    if (duplicate) return;

    compactions++;
    compactionTimestamps.push(timestamp);
    if (time != null) compactionEvents.push({ time, source });
  };

  forEachCodexJsonlLineSync(filePath, record => {
    const payload = asRecord(record.payload) || {};
    const timestamp = getTimestamp(record, payload);
    if (timestamp) {
      if (!firstTimestamp) firstTimestamp = timestamp;
      lastTimestamp = timestamp;
    }

    if (record.type === 'session_meta') {
      if (!hasSessionMetadata) {
        const git = asRecord(payload.git);
        nativeId = getOptionalString(payload, 'id') || nativeId;
        cwd = getOptionalString(payload, 'cwd') || cwd;
        version = getOptionalString(payload, 'cli_version') || getOptionalString(payload, 'version') || version;
        gitBranch = getOptionalString(git, 'branch')
          || getOptionalString(payload, 'git_branch')
          || getOptionalString(payload, 'gitBranch')
          || gitBranch;
        hasSessionMetadata = true;
      }
      return;
    }

    if (record.type === 'turn_context') {
      model = getOptionalString(payload, 'model') || model;
      cwd = getOptionalString(payload, 'cwd') || cwd;
      if (model !== 'unknown') modelsSet.add(model);
      return;
    }

    if (record.type === 'response_item') {
      const kind = getCodexPayloadKind(record);
      if (kind === 'message') {
        const role = getOptionalString(payload, 'role');
        const text = getContentText(payload.content);
        search.add(text);

        if (role === 'user') {
          userMessageCount++;
          addTokenUsage(estimatedTokenUsage, { input_tokens: estimateTokens(text) });
        } else if (role === 'assistant' && text && !shouldSkipDuplicateAssistant(seenAssistantText, text)) {
          assistantMessageCount++;
          addTokenUsage(estimatedTokenUsage, { output_tokens: estimateTokens(text) });
        } else if (role === 'developer' || role === 'system') {
          search.add(text);
          addTokenUsage(estimatedTokenUsage, { input_tokens: estimateTokens(text) });
        }
        return;
      }

      if (kind === 'reasoning') {
        const text = getReasoningText(payload);
        search.add(text);
        const tokens = estimateTokens(text);
        addTokenUsage(estimatedTokenUsage, { output_tokens: tokens, reasoning_output_tokens: tokens });
        return;
      }

      if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'web_search_call') {
        const toolName = getSummaryToolName(payload);
        toolCallCount++;
        toolsUsed[toolName] = (toolsUsed[toolName] || 0) + 1;
        search.add(toolName);
        search.add(typeof payload.arguments === 'string' ? payload.arguments : undefined);
        search.add(typeof payload.input === 'string' ? payload.input : undefined);
        return;
      }

      return;
    }

    if (record.type === 'event_msg') {
      const kind = getCodexPayloadKind(record);
      if (kind === 'user_message') {
        const text = getUserMessageText(payload);
        if (text) {
          userMessageCount++;
          search.add(text);
          addTokenUsage(estimatedTokenUsage, { input_tokens: estimateTokens(text) });
        }
        return;
      }

      if (kind === 'agent_reasoning') {
        const text = getReasoningText(payload);
        search.add(text);
        const tokens = estimateTokens(text);
        addTokenUsage(estimatedTokenUsage, { output_tokens: tokens, reasoning_output_tokens: tokens });
        return;
      }

      if (kind === 'agent_message') {
        const text = getContentText(payload.content ?? payload.message);
        if (text && !shouldSkipDuplicateAssistant(seenAssistantText, text)) {
          assistantMessageCount++;
          search.add(text);
          addTokenUsage(estimatedTokenUsage, { output_tokens: estimateTokens(text) });
        }
        return;
      }

      if (kind === 'token_count') {
        const cumulativeTokenUsage = getTokenUsageFromCountPayload(payload);
        const lastTokenUsage = getLastTokenUsageFromCountPayload(payload);
        if (lastTokenUsage) addTokenUsage(accountedTokenUsage, lastTokenUsage);
        if (hasTotalTokenUsagePayload(payload)) {
          finalTokenUsage = cumulativeTokenUsage;
          hasCumulativeTokenUsage = true;
        }
        return;
      }

      if (kind === 'exec_command_end' || kind === 'patch_apply_end' || kind === 'web_search_end') {
        search.add(getOptionalString(payload, 'stdout'));
        search.add(getOptionalString(payload, 'stderr'));
        search.add(getOptionalString(payload, 'output'));
        return;
      }

      if (kind === 'context_compacted') {
        recordCompaction(timestamp, 'context_compacted');
        return;
      }

      if (kind === 'error' || kind === 'turn_aborted') {
        search.add(getOptionalString(payload, 'reason') || getOptionalString(payload, 'message') || kind);
      }
    }

    if (record.type === 'compacted') {
      recordCompaction(timestamp, 'compacted');
    }
  });

  const tokenUsageSource = hasCumulativeTokenUsage
    ? finalTokenUsage
    : hasTokenUsage(accountedTokenUsage)
      ? accountedTokenUsage
      : estimatedTokenUsage;
  const usage = toClaudeUsage(tokenUsageSource);
  const timestamp = firstTimestamp || fileInfo?.createdAt || new Date(0).toISOString();
  const updatedAt = lastTimestamp || fileInfo?.updatedAt || timestamp;
  const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(timestamp).getTime());
  const models = model === 'unknown' ? [] : Array.from(modelsSet.size > 0 ? modelsSet : new Set([model]));

  return {
    nativeId,
    title: fileInfo?.title,
    cwd,
    gitBranch,
    version,
    model,
    models: models.map(getModelDisplayName),
    createdAt: timestamp,
    updatedAt,
    duration: Number.isNaN(duration) ? 0 : duration,
    userMessageCount,
    assistantMessageCount,
    messageCount: userMessageCount + assistantMessageCount,
    toolCallCount,
    tokenUsage: usage,
    reasoningOutputTokens: tokenUsageSource.reasoning_output_tokens || 0,
    toolsUsed,
    compaction: {
      compactions,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps,
    },
    searchTextPreview: search.value(),
  };
}

export function parseCodexRecords(
  filePath: string,
  records: CodexEnvelope[],
  fileInfo?: CodexSessionFileInfo,
  options: { subagent?: SessionSubagentDisplay } = {},
): CodexParsedSession {
  const results = collectCodexToolResults(records);
  const explicitPatchCallIds = new Set(records.flatMap(record => {
    const kind = getCodexPayloadKind(record);
    if (record.type !== 'response_item' || (kind !== 'custom_tool_call' && kind !== 'function_call')) return [];
    const payload = asRecord(record.payload);
    if (getOptionalString(payload, 'name') !== 'apply_patch') return [];
    const callId = getOptionalString(payload, 'call_id');
    return callId ? [callId] : [];
  }));
  const messages: SessionMessageDisplay[] = [];
  const searchableParts: string[] = [];
  const seenAssistantText = new Set<string>();
  const toolsUsed: Record<string, number> = {};
  const modelsSet = new Set<string>();

  let nativeId = fileInfo?.nativeId || path.basename(filePath, '.jsonl');
  const title = fileInfo?.title;
  let cwd = fileInfo?.cwd || '';
  let gitBranch = '';
  let version = '';
  let model = 'unknown';
  let firstTimestamp = fileInfo?.createdAt || '';
  let lastTimestamp = fileInfo?.updatedAt || '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let toolCallCount = 0;
  let finalTokenUsage: CodexTokenUsage = {};
  let hasCumulativeTokenUsage = false;
  let previousCumulativeTokenUsage: CodexTokenUsage | null = null;
  const accountedTokenUsage: CodexTokenUsage = {};
  const estimatedTokenUsage: CodexTokenUsage = {};
  let compactions = 0;
  const compactionTimestamps: string[] = [];
  const compactionEvents: Array<{ time: number; source: CodexCompactionSource; messageIndex: number }> = [];
  let lastAssistantMessageIndex: number | null = null;
  let hasSessionMetadata = false;

  const pushAssistantMessage = (message: SessionMessageDisplay) => {
    messages.push(message);
    lastAssistantMessageIndex = messages.length - 1;
  };

  const recordCompaction = (
    timestamp: string,
    source: CodexCompactionSource,
    details: Array<{ key: string; value: string }> = [],
  ) => {
    const time = parseTimestampMs(timestamp);
    const duplicate = time == null
      ? undefined
      : compactionEvents.find(event => (
          event.source !== source
          && Math.abs(event.time - time) <= CODEX_COMPACTION_DUPLICATE_WINDOW_MS
        ));

    if (duplicate) {
      if (details.length > 0) {
        const existingMessage = messages[duplicate.messageIndex];
        existingMessage.blocks = [makeEventBlock('Context compacted', 'Context compacted', details)];
      }
      return;
    }

    compactions++;
    compactionTimestamps.push(timestamp);
    messages.push({
      role: 'system',
      content: 'Context compacted',
      timestamp,
      blocks: [makeEventBlock('Context compacted', 'Context compacted', details)],
      isMeta: true,
    });
    if (time != null) {
      compactionEvents.push({ time, source, messageIndex: messages.length - 1 });
    }
  };

  for (const record of records) {
    const payload = asRecord(record.payload) || {};
    const timestamp = getTimestamp(record, payload);
    if (timestamp) {
      if (!firstTimestamp) firstTimestamp = timestamp;
      lastTimestamp = timestamp;
    }

    if (record.type === 'session_meta') {
      if (!hasSessionMetadata) {
        const git = asRecord(payload.git);
        nativeId = getOptionalString(payload, 'id') || nativeId;
        cwd = getOptionalString(payload, 'cwd') || cwd;
        version = getOptionalString(payload, 'cli_version') || getOptionalString(payload, 'version') || version;
        gitBranch = getOptionalString(git, 'branch')
          || getOptionalString(payload, 'git_branch')
          || getOptionalString(payload, 'gitBranch')
          || gitBranch;
        hasSessionMetadata = true;
      }
      continue;
    }

    if (record.type === 'turn_context') {
      model = getOptionalString(payload, 'model') || model;
      cwd = getOptionalString(payload, 'cwd') || cwd;
      if (model !== 'unknown') modelsSet.add(model);
      continue;
    }

    if (record.type === 'response_item') {
      const kind = getCodexPayloadKind(record);
      if (kind === 'message') {
        const role = getOptionalString(payload, 'role');
        const text = getContentText(payload.content);
        if (text) searchableParts.push(text);

        if (role === 'user') {
          const images = getContentImages(payload.content);
          userMessageCount++;
          addTokenUsage(estimatedTokenUsage, { input_tokens: estimateTokens(text) });
          messages.push({ role: 'user', content: text, timestamp, images });
        } else if (role === 'assistant') {
          if (!shouldSkipDuplicateAssistant(seenAssistantText, text)) {
            assistantMessageCount++;
            addTokenUsage(estimatedTokenUsage, { output_tokens: estimateTokens(text) });
            pushAssistantMessage({ role: 'assistant', content: text, timestamp, model });
          }
        } else if (role === 'developer' || role === 'system') {
          addTokenUsage(estimatedTokenUsage, { input_tokens: estimateTokens(text) });
          messages.push({
            role: 'system',
            content: text,
            timestamp,
            blocks: [makeEventBlock('Developer message', text, [])],
            isMeta: true,
          });
        }
        continue;
      }

      if (kind === 'reasoning') {
        const summary = getReasoningText(payload);
        const tokens = estimateTokens(summary);
        addTokenUsage(estimatedTokenUsage, { output_tokens: tokens, reasoning_output_tokens: tokens });
        pushAssistantMessage({
          role: 'assistant',
          content: '',
          timestamp,
          model,
          blocks: [{
            type: 'thinking',
            title: 'Reasoning',
            summary: summary || 'Reasoning summary',
            content: summary,
            details: [],
          }],
        });
        if (summary) searchableParts.push(summary);
        continue;
      }

      if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'web_search_call') {
        const toolCalls = buildCodexToolCalls(payload, results);
        toolCallCount += toolCalls.length;
        for (const tool of toolCalls) {
          toolsUsed[tool.name] = (toolsUsed[tool.name] || 0) + 1;
          searchableParts.push(tool.summary, ...tool.details.map(item => item.value));
        }
        messages.push({
          role: 'tool-use',
          content: '',
          timestamp,
          model,
          toolCalls,
        });
        continue;
      }

      if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
        const result = results.get(getOptionalString(payload, 'call_id') || '');
        if (result && !isCodexEnrichedToolResult(result)) {
          const block = buildCodexToolResultBlock(result);
          searchableParts.push(block.summary, block.content || '', ...block.details.map(item => item.value));
          messages.push({
            role: 'tool-result',
            content: block.summary,
            timestamp,
            blocks: [block],
          });
        }
        continue;
      }
    }

    if (record.type === 'event_msg') {
      const kind = getCodexPayloadKind(record);
      if (kind === 'user_message') {
        const text = getUserMessageText(payload);
        const images = getUserMessageImages(payload);
        if (text || images.length > 0) {
          userMessageCount++;
          addTokenUsage(estimatedTokenUsage, { input_tokens: estimateTokens(text) });
          searchableParts.push(text);
          messages.push({ role: 'user', content: text, timestamp, images });
        }
        continue;
      }

      if (kind === 'agent_reasoning') {
        const summary = getReasoningText(payload);
        const tokens = estimateTokens(summary);
        addTokenUsage(estimatedTokenUsage, { output_tokens: tokens, reasoning_output_tokens: tokens });
        pushAssistantMessage({
          role: 'assistant',
          content: '',
          timestamp,
          model,
          blocks: [{
            type: 'thinking',
            title: 'Reasoning',
            summary: summary || 'Reasoning summary',
            content: summary,
            details: [],
          }],
        });
        if (summary) searchableParts.push(summary);
        continue;
      }

      if (kind === 'agent_message') {
        const text = getContentText(payload.content ?? payload.message);
        if (text && !shouldSkipDuplicateAssistant(seenAssistantText, text)) {
          assistantMessageCount++;
          addTokenUsage(estimatedTokenUsage, { output_tokens: estimateTokens(text) });
          searchableParts.push(text);
          pushAssistantMessage({ role: 'assistant', content: text, timestamp, model });
        }
        continue;
      }

      if (kind === 'token_count') {
        const cumulativeTokenUsage = getTokenUsageFromCountPayload(payload);
        const lastTokenUsage = getLastTokenUsageFromCountPayload(payload);
        const turnUsage = lastTokenUsage || (
          hasTotalTokenUsagePayload(payload)
            ? tokenUsageDelta(cumulativeTokenUsage, previousCumulativeTokenUsage)
            : null
        );
        if (turnUsage && lastAssistantMessageIndex != null) {
          const targetMessage = messages[lastAssistantMessageIndex];
          attachCodexTurnUsage(targetMessage, turnUsage, targetMessage.model || model);
          const promptBreakdown = buildCodexPromptBreakdown(turnUsage);
          if (promptBreakdown) {
            targetMessage.promptBreakdown = promptBreakdown;
          }
        }
        if (turnUsage && hasTokenUsage(turnUsage)) {
          addTokenUsage(accountedTokenUsage, turnUsage);
        }
        if (hasTotalTokenUsagePayload(payload)) {
          finalTokenUsage = cumulativeTokenUsage;
          hasCumulativeTokenUsage = true;
          previousCumulativeTokenUsage = cumulativeTokenUsage;
        }
        continue;
      }

      if (kind === 'exec_command_end' || kind === 'patch_apply_end' || kind === 'web_search_end') {
        const result = results.get(getOptionalString(payload, 'call_id') || '');
        if (result) {
          if (kind === 'patch_apply_end' && !explicitPatchCallIds.has(result.callId)) {
            const toolCalls = buildCodexPatchResultToolCalls(result);
            toolCallCount += toolCalls.length;
            for (const tool of toolCalls) {
              toolsUsed[tool.name] = (toolsUsed[tool.name] || 0) + 1;
              searchableParts.push(tool.summary, ...tool.details.map(item => item.value));
            }
            messages.push({
              role: 'tool-use',
              content: '',
              timestamp,
              model,
              toolCalls,
            });
          }
          const block = buildCodexToolResultBlock(result);
          searchableParts.push(block.summary, block.content || '', ...block.details.map(item => item.value));
          messages.push({
            role: 'tool-result',
            content: block.summary,
            timestamp,
            blocks: [block],
          });
        }
        continue;
      }

      if (kind === 'context_compacted') {
        recordCompaction(
          timestamp,
          'context_compacted',
          [
            { key: 'trigger', value: getOptionalString(payload, 'trigger') || 'unknown' },
            { key: 'pre_tokens', value: String(payload.pre_tokens || '') },
          ],
        );
        continue;
      }

      if (kind === 'error' || kind === 'turn_aborted') {
        const reason = getOptionalString(payload, 'reason') || getOptionalString(payload, 'message') || kind;
        messages.push({
          role: 'system',
          content: reason,
          timestamp,
          blocks: [makeEventBlock(kind, reason, [])],
          isMeta: true,
        });
        continue;
      }
    }

    if (record.type === 'compacted') {
      recordCompaction(timestamp, 'compacted');
    }
  }

  const projectNativeId = getProjectNativeId(cwd, filePath);
  const routeId = makeRouteId('codex', nativeId);
  const projectRouteId = qualifyProjectId('codex', projectNativeId);
  const tokenUsageSource = hasCumulativeTokenUsage
    ? finalTokenUsage
    : hasTokenUsage(accountedTokenUsage)
      ? accountedTokenUsage
      : estimatedTokenUsage;
  const usage = toClaudeUsage(tokenUsageSource);
  const models = model === 'unknown' ? [] : Array.from(modelsSet);
  const costs = model === 'unknown'
    ? zeroCosts()
    : calculateCostAllModes(model, usage.input_tokens, usage.output_tokens, 0, usage.cache_read_input_tokens);
  const timestamp = firstTimestamp || new Date(0).toISOString();
  const duration = firstTimestamp && lastTimestamp
    ? Math.max(0, new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime())
    : 0;

  const info: SessionInfo = {
    id: routeId,
    agentKind: 'codex',
    nativeId,
    routeId,
    projectId: projectRouteId,
    nativeProjectId: projectNativeId,
    projectRouteId,
    projectName: cwd ? path.basename(cwd) : projectNativeId,
    title,
    sourceFilePath: filePath,
    sourceFilePaths: [filePath],
    timestamp,
    duration,
    messageCount: userMessageCount + assistantMessageCount,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    totalInputTokens: usage.input_tokens,
    totalOutputTokens: usage.output_tokens,
    totalCacheReadTokens: usage.cache_read_input_tokens,
    totalCacheWriteTokens: 0,
    estimatedCost: costs[DEFAULT_COST_MODE],
    estimatedCosts: costs,
    model,
    models: models.map(getModelDisplayName),
    gitBranch,
    cwd,
    version,
    toolsUsed,
    compaction: {
      compactions,
      microcompactions: 0,
      totalTokensSaved: 0,
      compactionTimestamps,
    },
  };

  const displayMessages = options.subagent
    ? messages.map(message => ({ ...message, subagent: options.subagent }))
    : messages;

  return {
    info,
    detail: { ...info, messages: displayMessages },
    searchableText: searchableParts.join('\n').toLowerCase(),
    reasoningOutputTokens: tokenUsageSource.reasoning_output_tokens || 0,
    modelUsage: {
      [model || 'unknown']: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
        reasoningOutputTokens: tokenUsageSource.reasoning_output_tokens || 0,
      },
    },
  };
}

export async function parseCodexSessionFile(
  filePath: string,
  fileInfo?: CodexSessionFileInfo,
  options: { records?: CodexEnvelope[]; subagent?: SessionSubagentDisplay } = {},
): Promise<CodexParsedSession> {
  return parseCodexRecords(filePath, options.records || await readCodexRecords(filePath), fileInfo, options);
}
