import path from 'path';
import { parsePatch } from 'diff';
import { calculateCostAllModes, DEFAULT_COST_MODE } from '@/config/pricing';
import { addCosts, recordedCostEstimates, zeroCosts } from '@/lib/claude-data/cost-utils';
import type {
  CostEstimates,
  RecordedUsageCost,
  SessionArtifactDisplay,
  SessionDetail,
  SessionInfo,
  SessionMessageBlockDisplay,
  SessionMessageDisplay,
  SessionSubagentDisplay,
  SessionToolCallDetail,
  SessionToolCallDisplay,
  TokenUsage,
} from '@/lib/claude-data/types';
import type { CachedModelUsage } from '@/lib/agent-data/session-summary';
import { makeRouteId, qualifyProjectId } from '@/lib/agent-data/route-id';
import { asRecord, forEachCopilotJsonlLineSync, type CopilotTranscriptRecord } from './io';
import type { CopilotSessionFileInfo } from './session-index';
import { dedupeImages, extractCopilotImages, summarizeImages } from '@/lib/session-images';
import {
  getCopilotChatSessionSummary,
  type CopilotChatSessionSummary,
  type CopilotRequestUsage,
  type CopilotSubagentInvocation,
  type CopilotUsageTotals,
} from './chat-session';

export interface CopilotParsedSession {
  info: SessionInfo;
  detail: SessionDetail;
  searchableText: string;
}

export interface CopilotParsedSessionSummary {
  recordedUsageCost?: RecordedUsageCost;
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

const CHARS_PER_TOKEN = 4;
const COPILOT_AUTO_MODEL = 'copilot-auto';
const COPILOT_OPENAI_AUTO_MODEL = 'copilot-openai-auto';
const COPILOT_ANTHROPIC_AUTO_MODEL = 'copilot-anthropic-auto';

const TRANSCRIPT_TOOL_CALL_MODEL_HINTS: Array<{ prefix: string; model: string }> = [
  { prefix: 'toolu_bdrk_', model: COPILOT_ANTHROPIC_AUTO_MODEL },
  { prefix: 'toolu_vrtx_', model: COPILOT_ANTHROPIC_AUTO_MODEL },
  { prefix: 'tooluse_', model: COPILOT_ANTHROPIC_AUTO_MODEL },
  { prefix: 'toolu_', model: COPILOT_ANTHROPIC_AUTO_MODEL },
  { prefix: 'call_', model: COPILOT_OPENAI_AUTO_MODEL },
];

function zeroCopilotUsage(): CopilotUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addCopilotUsage(target: CopilotUsageTotals, usage: CopilotUsageTotals): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadInputTokens += usage.cacheReadInputTokens;
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
}

function hasCopilotUsage(usage: CopilotUsageTotals): boolean {
  return usage.inputTokens > 0
    || usage.outputTokens > 0
    || usage.cacheReadInputTokens > 0
    || usage.cacheCreationInputTokens > 0
    || usage.reasoningOutputTokens > 0;
}

function normalizeCopilotModelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase().startsWith('copilot/') ? trimmed.slice('copilot/'.length) : trimmed;
}

function estimateTokensFromText(value: string): number {
  return value ? Math.ceil(value.length / CHARS_PER_TOKEN) : 0;
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
  bash: 'Bash',
  create_file: 'Write',
  delete_file: 'Delete',
  edit_file: 'Edit',
  fetch_webpage: 'WebFetch',
  file_search: 'Search',
  find_files: 'Glob',
  grep_search: 'Grep',
  github_repo: 'GitHub',
  kill_terminal: 'Bash',
  list_dir: 'LS',
  list_directory: 'LS',
  memory: 'Memory',
  multi_replace_string_in_file: 'MultiEdit',
  read_file: 'Read',
  replace_string_in_file: 'Edit',
  run_in_terminal: 'Bash',
  search_files: 'Grep',
  semantic_search: 'Search',
  web_search: 'WebSearch',
  write_file: 'Edit',
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

interface ParsedApplyPatchEdit {
  path: string;
  oldText: string;
  newText: string;
  location?: string;
}

function getApplyPatchInput(args: Record<string, unknown>): string | undefined {
  return getFirstString(args, ['input', 'patch', 'arguments']);
}

function isApplyPatchFileHeader(line: string): boolean {
  return /^\*\*\* (?:Update|Add|Delete) File: /.test(line);
}

function parseApplyPatchInput(input: string): ParsedApplyPatchEdit[] {
  const edits: ParsedApplyPatchEdit[] = [];
  let filePath = '';
  let operation = '';
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let location: string | undefined;

  const flushHunk = () => {
    if (!filePath) return;
    if (oldLines.length === 0 && newLines.length === 0) return;
    edits.push({
      path: filePath,
      oldText: oldLines.join('\n'),
      newText: newLines.join('\n'),
      location: location && location !== '@@' ? location : undefined,
    });
    oldLines = [];
    newLines = [];
  };

  const startFile = (nextOperation: 'update' | 'add' | 'delete', nextPath: string) => {
    flushHunk();
    filePath = nextPath.trim();
    operation = nextOperation;
    oldLines = [];
    newLines = [];
    location = operation === 'add' || operation === 'delete' ? 'line 1' : undefined;
  };

  for (const line of input.replace(/\r\n?/g, '\n').split('\n')) {
    const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
    if (updateMatch) {
      startFile('update', updateMatch[1]);
      continue;
    }

    const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
    if (addMatch) {
      startFile('add', addMatch[1]);
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
    if (deleteMatch) {
      startFile('delete', deleteMatch[1]);
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (moveMatch) {
      filePath = moveMatch[1].trim();
      continue;
    }

    if (line.startsWith('@@')) {
      flushHunk();
      location = line.trim();
      continue;
    }

    if (!filePath || line === '*** Begin Patch' || line === '*** End Patch' || line === '*** End of File') continue;
    if (line.startsWith('*** ') && !isApplyPatchFileHeader(line)) continue;
    if (line.startsWith('\\')) continue;

    if (line.startsWith('+')) {
      if (operation !== 'delete') newLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      if (operation !== 'add') oldLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
    } else if (operation === 'update') {
      oldLines.push(line);
      newLines.push(line);
    }
  }

  flushHunk();
  return edits;
}

function buildApplyPatchArtifact(args: Record<string, unknown>): SessionArtifactDisplay | undefined {
  const input = getApplyPatchInput(args);
  if (!input) return undefined;

  const edits = parseApplyPatchInput(input);
  if (edits.length === 0) return undefined;

  return {
    kind: 'diff',
    title: edits.length === 1 ? `${edits[0].path} diff` : `${edits.length} patch edits`,
    oldText: edits.map(edit => edit.oldText).join('\n'),
    newText: edits.map(edit => edit.newText).join('\n'),
    location: edits.length === 1 ? edits[0].location : `${edits.length} edits`,
    includeWhenEmpty: true,
    edits: edits.map(edit => ({
      path: edit.path,
      oldText: edit.oldText,
      newText: edit.newText,
      location: edit.location,
      includeWhenEmpty: true,
    })),
  };
}

function getApplyPatchPaths(args: Record<string, unknown>): string[] {
  const input = getApplyPatchInput(args);
  if (!input) return [];
  return Array.from(new Set(parseApplyPatchInput(input).map(edit => edit.path).filter(Boolean)));
}

function applyCompletedPatchArtifact(tool: SessionToolCallDisplay | undefined, data: Record<string, unknown>, content: string): void {
  if (tool?.name !== 'apply_patch' || data.success !== true || !content.includes('@@ ')) return;
  try {
    const edits = parsePatch(content).flatMap(patch => {
      const filePath = patch.newFileName === '/dev/null' ? patch.oldFileName : patch.newFileName;
      if (!filePath) return [];
      return patch.hunks.map(hunk => ({
        path: filePath.replace(/^[ab]\//, ''),
        oldText: hunk.lines.filter(line => line.startsWith(' ') || line.startsWith('-')).map(line => line.slice(1)).join('\n'),
        newText: hunk.lines.filter(line => line.startsWith(' ') || line.startsWith('+')).map(line => line.slice(1)).join('\n'),
        // Artifacts are applied sequentially, so later hunks use the position
        // after earlier hunks in this same patch have shifted the file.
        location: `line ${Math.max(1, hunk.newStart)}`,
        includeWhenEmpty: true,
      }));
    });
    if (!edits.length) return;
    tool.artifact = {
      kind: 'diff', title: `${edits.length} patch edits`, edits,
      oldText: edits.map(edit => edit.oldText).join('\n'),
      newText: edits.map(edit => edit.newText).join('\n'),
      includeWhenEmpty: true,
    };
  } catch {
    // Partial completion output must not erase the original patch request.
  }
}

function buildDiffArtifact(rawName: string, args: Record<string, unknown>, filePath: string | undefined): SessionArtifactDisplay | undefined {
  if (rawName === 'apply_patch') return buildApplyPatchArtifact(args);

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
  const applyPatchPaths = rawName === 'apply_patch' ? getApplyPatchPaths(args) : [];
  const filePath = getFirstString(args, ['filePath', 'file_path', 'path', 'targetPath'])
    || (applyPatchPaths.length > 0 ? applyPatchPaths.join('\n') : undefined);
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

  const primary = applyPatchPaths.length > 1 ? `${applyPatchPaths.length} files` : filePath || command || query || stringifyValue(args);
  return {
    name,
    id: toolCallId,
    summary: primary ? `${name}: ${primary}` : name,
    details,
    artifact: buildDiffArtifact(rawName, args, filePath),
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

function addModelHint(modelCounts: Map<string, number>, model: string | undefined, weight = 1): void {
  const normalized = normalizeCopilotModelId(model);
  if (!normalized) return;
  modelCounts.set(normalized, (modelCounts.get(normalized) || 0) + weight);
}

function addToolCallModelHints(modelCounts: Map<string, number>, tools: SessionToolCallDisplay[]): void {
  for (const tool of tools) {
    for (const hint of TRANSCRIPT_TOOL_CALL_MODEL_HINTS) {
      if (!tool.id.startsWith(hint.prefix)) continue;
      addModelHint(modelCounts, hint.model);
      break;
    }
  }
}

function chooseInferredTranscriptModel(modelCounts: Map<string, number>): string | undefined {
  if (modelCounts.size === 0) return undefined;
  return [...modelCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function chooseCopilotModel(chatSummary: CopilotChatSessionSummary, inferredModel: string | undefined): string {
  return chatSummary.model !== 'unknown'
    ? chatSummary.model
    : inferredModel || COPILOT_AUTO_MODEL;
}

function chooseCopilotModels(chatSummary: CopilotChatSessionSummary, primaryModel: string): string[] {
  return Array.from(new Set([
    ...chatSummary.models,
    primaryModel,
  ].filter(model => model && model !== 'unknown')));
}

function resolveCopilotSubagentDepth(
  invocation: CopilotSubagentInvocation,
  invocations: Map<string, CopilotSubagentInvocation>,
): number {
  let depth = 1;
  let parentInvocationId = invocation.parentInvocationId;
  const seen = new Set([invocation.invocationId]);
  while (parentInvocationId && !seen.has(parentInvocationId)) {
    const parent = invocations.get(parentInvocationId);
    if (!parent) break;
    seen.add(parentInvocationId);
    depth++;
    parentInvocationId = parent.parentInvocationId;
  }
  return depth;
}

function estimateTranscriptUsage(content: string, reasoningText: string, userContent: string, explicitOutputTokens?: number): CopilotUsageTotals {
  const outputTokens = explicitOutputTokens && explicitOutputTokens > 0
    ? Math.max(0, explicitOutputTokens)
    : estimateTokensFromText(content);

  return {
    inputTokens: estimateTokensFromText(userContent),
    outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: explicitOutputTokens && explicitOutputTokens > 0 ? 0 : estimateTokensFromText(reasoningText),
  };
}

function addModelUsage(
  modelUsage: Record<string, CachedModelUsage>,
  model: string,
  usage: CopilotUsageTotals,
  contextWindow?: number,
  maxOutputTokens?: number,
): void {
  const existing = modelUsage[model] || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    contextWindow,
    maxOutputTokens,
  };
  existing.inputTokens += usage.inputTokens;
  existing.outputTokens += usage.outputTokens;
  existing.cacheReadInputTokens += usage.cacheReadInputTokens;
  existing.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  existing.reasoningOutputTokens = (existing.reasoningOutputTokens || 0) + usage.reasoningOutputTokens;
  existing.contextWindow ||= contextWindow;
  existing.maxOutputTokens ||= maxOutputTokens;
  modelUsage[model] = existing;
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
  const images = extractCopilotImages(data, 'Tool result image');

  addDetail(details, 'tool_use_id', toolCallId, 'tool_use_id');
  addDetail(details, 'status', status);
  if (startTool) {
    for (const detail of startTool.details) {
      if (details.some(existing => existing.key === detail.key && existing.value === detail.value)) continue;
      details.push(detail);
    }
  }
  const error = asRecord(data.error);
  const errorMessage = getOptionalString(data, 'error')
    || (error && getOptionalString(error, 'message'))
    || getOptionalString(data, 'message');
  addDetail(details, 'error', errorMessage);

  const result = asRecord(data.result);
  const rawContent = getOptionalString(data, 'output')
    || getOptionalString(data, 'result')
    || (result && (getOptionalString(result, 'detailedContent') || getOptionalString(result, 'content')))
    || getOptionalString(data, 'content')
    || errorMessage
    || '';
  const content = images.length > 0 && rawContent.replace(/\s+/g, '').startsWith(images[0]?.url.split(',')[1] || '\0')
    ? ''
    : rawContent;

  return {
    type: 'tool-result',
    title: startTool ? `${startTool.name} result` : 'Tool result',
    summary: images.length > 0 ? summarizeImages(images) : status,
    content,
    details,
    images: images.length > 0 ? images : undefined,
  };
}

function messageHasImages(message: SessionMessageDisplay): boolean {
  return (message.images || []).length > 0
    || (message.blocks || []).some(block => (block.images || []).length > 0);
}

function getToolUseIdFromDetails(details: SessionToolCallDetail[]): string | undefined {
  return details.find(detail => detail.key === 'tool_use_id' || detail.key === 'toolUseId')?.value;
}

function getToolUseIdFromMessage(message: SessionMessageDisplay): string | undefined {
  for (const block of message.blocks || []) {
    const toolUseId = getToolUseIdFromDetails(block.details);
    if (toolUseId) return toolUseId;
  }
  return message.toolCalls?.find(tool => tool.id)?.id;
}

function getImagesFromMessage(message: SessionMessageDisplay) {
  return [
    ...(message.images || []),
    ...(message.blocks || []).flatMap(block => block.images || []),
  ];
}

function mergeToolResultImages(
  message: SessionMessageDisplay,
  sidecar: SessionMessageDisplay,
): SessionMessageDisplay {
  const images = getImagesFromMessage(sidecar);
  if (images.length === 0) return message;

  const blocks = message.blocks && message.blocks.length > 0
    ? message.blocks.map((block, index) => index === 0
      ? { ...block, images: dedupeImages([...(block.images || []), ...images]) }
      : block)
    : sidecar.blocks;

  return {
    ...message,
    content: message.content || sidecar.content,
    blocks,
    images: message.blocks && message.blocks.length > 0
      ? message.images
      : dedupeImages([...(message.images || []), ...images]),
  };
}

function mergeSidecarImageMessages(
  messages: SessionMessageDisplay[],
  sidecarMessages: SessionMessageDisplay[],
): SessionMessageDisplay[] {
  const sidecarImageMessages = sidecarMessages.filter(messageHasImages);
  if (sidecarImageMessages.length === 0) return messages;

  const userSidecars = sidecarImageMessages.filter(message => message.role === 'user' && (message.images || []).length > 0);
  const toolSidecarsById = new Map<string, SessionMessageDisplay[]>();
  const usedSidecars = new Set<SessionMessageDisplay>();

  for (const sidecar of sidecarImageMessages) {
    if (sidecar.role !== 'tool-result') continue;
    const toolUseId = getToolUseIdFromMessage(sidecar);
    if (!toolUseId) continue;
    const existing = toolSidecarsById.get(toolUseId) || [];
    existing.push(sidecar);
    toolSidecarsById.set(toolUseId, existing);
  }

  let userIndex = 0;
  const merged = messages.map(message => {
    if (message.role === 'user') {
      const sidecar = userSidecars[userIndex++];
      if (!sidecar?.images?.length) return message;
      usedSidecars.add(sidecar);
      return {
        ...message,
        images: dedupeImages([...(message.images || []), ...sidecar.images]),
      };
    }

    if (message.role === 'tool-result') {
      const toolUseId = getToolUseIdFromMessage(message);
      const sidecars = toolUseId ? toolSidecarsById.get(toolUseId) || [] : [];
      let nextMessage = message;
      for (const sidecar of sidecars) {
        nextMessage = mergeToolResultImages(nextMessage, sidecar);
        usedSidecars.add(sidecar);
      }
      return nextMessage;
    }

    return message;
  });

  const unmatchedSidecars = sidecarImageMessages.filter(message => !usedSidecars.has(message));
  return [...merged, ...unmatchedSidecars];
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
  const estimatedCosts = summary.recordedUsageCost
    ? recordedCostEstimates(summary.recordedUsageCost.usd)
    : calculateCopilotCosts(summary.modelUsage);
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
    recordedUsageCost: summary.recordedUsageCost,
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

interface LegacyCopilotParseResult {
  summary: CopilotParsedSessionSummary;
  messages: SessionMessageDisplay[];
  searchableText: string;
}

interface LegacyShutdownUsageSnapshot {
  currentModel?: string;
  usage: CopilotUsageTotals;
  modelUsage: Record<string, CachedModelUsage>;
}

function readLegacyTokenDetail(
  tokenDetails: Record<string, unknown>,
  key: string,
  required: boolean,
): number | null {
  const detail = asRecord(tokenDetails[key]);
  if (!detail) return required ? null : 0;
  const value = detail.tokenCount;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readLegacyReasoningTokens(usage: Record<string, unknown> | null): number | null {
  if (!usage || usage.reasoningTokens == null) return 0;
  const value = usage.reasoningTokens;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseLegacyTokenDetails(value: unknown): CopilotUsageTotals | null {
  const tokenDetails = asRecord(value);
  if (!tokenDetails) return null;

  const inputTokens = readLegacyTokenDetail(tokenDetails, 'input', true);
  const outputTokens = readLegacyTokenDetail(tokenDetails, 'output', true);
  const cacheReadInputTokens = readLegacyTokenDetail(tokenDetails, 'cache_read', false);
  const cacheCreationInputTokens = readLegacyTokenDetail(tokenDetails, 'cache_write', false);
  if (
    inputTokens == null
    || outputTokens == null
    || cacheReadInputTokens == null
    || cacheCreationInputTokens == null
  ) return null;

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens: 0,
  };
}

function parseLegacyShutdownUsage(data: Record<string, unknown>): LegacyShutdownUsageSnapshot | null {
  const usage = parseLegacyTokenDetails(data.tokenDetails);
  const metrics = asRecord(data.modelMetrics);
  if (!usage || !metrics || Object.keys(metrics).length === 0) return null;

  const modelUsage = Object.create(null) as Record<string, CachedModelUsage>;
  for (const [rawModel, rawMetrics] of Object.entries(metrics)) {
    const model = normalizeCopilotModelId(rawModel);
    const metric = asRecord(rawMetrics);
    const metricUsage = metric ? parseLegacyTokenDetails(metric.tokenDetails) : null;
    const reasoningOutputTokens = readLegacyReasoningTokens(metric ? asRecord(metric.usage) : null);
    if (
      !model
      || model === 'prototype'
      || Object.hasOwn(Object.prototype, model)
      || !metricUsage
      || reasoningOutputTokens == null
    ) return null;

    metricUsage.reasoningOutputTokens = reasoningOutputTokens;
    addModelUsage(modelUsage, model, metricUsage);
  }

  const summedUsage = Object.values(modelUsage).reduce((total, item) => {
    addCopilotUsage(total, {
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheReadInputTokens: item.cacheReadInputTokens,
      cacheCreationInputTokens: item.cacheCreationInputTokens,
      reasoningOutputTokens: item.reasoningOutputTokens || 0,
    });
    return total;
  }, zeroCopilotUsage());
  if (
    summedUsage.inputTokens !== usage.inputTokens
    || summedUsage.outputTokens !== usage.outputTokens
    || summedUsage.cacheReadInputTokens !== usage.cacheReadInputTokens
    || summedUsage.cacheCreationInputTokens !== usage.cacheCreationInputTokens
  ) return null;

  usage.reasoningOutputTokens = summedUsage.reasoningOutputTokens;
  return {
    currentModel: normalizeCopilotModelId(getOptionalString(data, 'currentModel')),
    usage,
    modelUsage,
  };
}

function canUseLegacyShutdownUsage(
  snapshot: LegacyShutdownUsageSnapshot,
  parsedModelUsage: Record<string, CachedModelUsage>,
): boolean {
  return Object.entries(parsedModelUsage).every(([model, usage]) => {
    if (!Object.hasOwn(snapshot.modelUsage, model)) return false;
    const recorded = snapshot.modelUsage[model];
    return usage.outputTokens <= recorded.outputTokens;
  });
}

function allocateLegacyShutdownUsageToMessages(
  messages: SessionMessageDisplay[],
  snapshot: LegacyShutdownUsageSnapshot,
): void {
  const finalAssistantByModel = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.model) {
      finalAssistantByModel.set(message.model, index);
    }
  });

  for (const [model, usage] of Object.entries(snapshot.modelUsage)) {
    const messageIndex = finalAssistantByModel.get(model);
    if (messageIndex == null) continue;
    const message = messages[messageIndex];
    const messageUsage = message.usage || EMPTY_USAGE;
    message.usage = {
      ...messageUsage,
      input_tokens: usage.inputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
    };
    message.estimatedCosts = calculateCostAllModes(
      model,
      message.usage.input_tokens,
      message.usage.output_tokens,
      message.usage.cache_creation_input_tokens,
      message.usage.cache_read_input_tokens,
    );
  }
}

function isLegacyCopilotSession(filePath: string, fileInfo: CopilotSessionFileInfo): boolean {
  return fileInfo.sourceKind === 'legacy'
    || filePath.replace(/\\/g, '/').includes('/session-state/')
    || path.basename(filePath).toLowerCase() === 'events.jsonl';
}

function parseLegacyCopilotRecords(filePath: string, records: CopilotTranscriptRecord[], fileInfo: CopilotSessionFileInfo): LegacyCopilotParseResult {
  const messages: SessionMessageDisplay[] = [];
  const searchableParts: string[] = [];
  const toolsUsed: Record<string, number> = {};
  const seenToolCallIds = new Set<string>();
  const seenMessageIds = new Set<string>();
  const startedTools = new Map<string, SessionToolCallDisplay>();
  const agentModels = new Map<string, string>();
  const tokenUsage = zeroCopilotUsage();
  const modelUsage: Record<string, CachedModelUsage> = {};
  const models = new Set<string>();
  const time = { first: fileInfo.createdAt || '', last: fileInfo.updatedAt || '' };

  const nativeId = fileInfo.nativeId || path.basename(path.dirname(filePath));
  // CLI transcripts interleave child events with the root conversation. Use
  // explicit agent and invocation IDs, never the model, to attribute them.
  const subagents = new Map<string, SessionSubagentDisplay>();
  const toolOwners = new Map<string, string>();
  for (const record of records) {
    const data = asRecord(record.data) || {};
    if (record.type === 'tool.execution_start') {
      const toolCallId = getOptionalString(data, 'toolCallId');
      if (toolCallId) toolOwners.set(toolCallId, record.agentId || nativeId);
    }
  }
  for (const record of records) {
    if (!record.agentId) continue;
    const data = asRecord(record.data) || {};
    const existing = subagents.get(record.agentId);
    const invocationId = record.type === 'subagent.started'
      ? getOptionalString(data, 'toolCallId')
      : getOptionalString(data, 'parentToolCallId');
    subagents.set(record.agentId, {
      id: record.agentId,
      parentId: (invocationId && toolOwners.get(invocationId)) || existing?.parentId || nativeId,
      nickname: getOptionalString(data, 'agentDisplayName') || existing?.nickname,
      role: getOptionalString(data, 'agentName') || existing?.role,
      depth: 1,
    });
  }
  for (const subagent of subagents.values()) {
    const seen = new Set([subagent.id]);
    let parent = subagents.get(subagent.parentId);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      subagent.depth++;
      parent = subagents.get(parent.parentId);
    }
  }
  let title = fileInfo.title || '';
  let currentModel = '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let shutdownUsage: LegacyShutdownUsageSnapshot | null = null;
  let recordedUsageCost: RecordedUsageCost | undefined;

  const recordTool = (tool: SessionToolCallDisplay) => {
    if (seenToolCallIds.has(tool.id)) return;
    seenToolCallIds.add(tool.id);
    toolsUsed[tool.name] = (toolsUsed[tool.name] || 0) + 1;
    searchableParts.push(tool.name, tool.summary, ...tool.details.map(detail => detail.value));
  };

  for (const record of records) {
    const data = asRecord(record.data) || {};
    const timestamp = updateTime(record, data, time);
    if (!record.agentId && (record.type === 'session.usage_checkpoint' || record.type === 'session.shutdown')) {
      const nanoAiu = getOptionalNumber(data, 'totalNanoAiu');
      if (nanoAiu != null && Number.isSafeInteger(nanoAiu) && nanoAiu >= 0) {
        // Copilot's cumulative checkpoints are replacements, not increments.
        // 1e9 nano-AIU = 1 AI credit; GitHub values one credit at $0.01.
        recordedUsageCost = { usd: nanoAiu / 1e11, credits: nanoAiu / 1e9, timestamp };
      }
    }
    const explicitModel = normalizeCopilotModelId(getOptionalString(data, 'model'));
    const subagent = record.agentId ? subagents.get(record.agentId) : undefined;
    if (record.agentId) {
      if (explicitModel) agentModels.set(record.agentId, explicitModel);
    } else {
      currentModel = explicitModel || currentModel;
    }
    const messageModel = (record.agentId ? agentModels.get(record.agentId) : currentModel) || 'unknown';

    if (record.type === 'session.shutdown' && !record.agentId) {
      shutdownUsage = parseLegacyShutdownUsage(data) || shutdownUsage;
      continue;
    }

    if (
      shutdownUsage
      && (record.type === 'session.start'
        || record.type === 'session.resume'
        || record.type === 'session.model_change'
        || record.type === 'user.message'
        || record.type === 'assistant.message')
    ) {
      shutdownUsage = null;
    }

    if (record.type === 'session.start' || record.type === 'session.model_change') {
      const model = normalizeCopilotModelId(getOptionalString(data, record.type === 'session.start' ? 'selectedModel' : 'newModel'));
      if (model) {
        if (record.agentId) agentModels.set(record.agentId, model);
        else currentModel = model;
        models.add(model);
      }
      continue;
    }

    if (record.type === 'user.message') {
      const content = getOptionalString(data, 'content') || '';
      const images = extractCopilotImages(data);
      if (!content && images.length === 0) continue;
      userMessageCount++;
      title ||= firstLine(content);
      searchableParts.push(content);
      messages.push({ role: 'user', content, timestamp, subagent, images: images.length > 0 ? images : undefined });
      continue;
    }

    if (record.type === 'tool.execution_start') {
      const tool = buildToolStartCall(data);
      if (!tool) continue;
      if (!startedTools.has(tool.id)) startedTools.set(tool.id, tool);
      if (seenToolCallIds.has(tool.id)) continue;
      recordTool(tool);
      messages.push({ role: 'tool-use', content: '', timestamp, model: messageModel, subagent, toolCalls: [tool] });
      continue;
    }

    if (record.type === 'tool.execution_complete') {
      const toolCallId = getOptionalString(data, 'toolCallId') || getOptionalString(data, 'id') || '';
      const block = buildToolResultBlock(data, startedTools.get(toolCallId));
      applyCompletedPatchArtifact(startedTools.get(toolCallId), data, block.content || '');
      searchableParts.push(block.summary, block.content || '', ...block.details.map(detail => detail.value));
      messages.push({ role: 'tool-result', content: block.summary, timestamp, model: messageModel, subagent, blocks: [block] });
      continue;
    }

    if (record.type !== 'assistant.message') continue;

    const outputTokens = getOptionalNumber(data, 'outputTokens') ?? getOptionalNumber(data, 'output_tokens') ?? 0;

    const messageId = getOptionalString(data, 'messageId') || getOptionalString(data, 'id') || record.id || `${assistantMessageCount}`;
    const messageKey = JSON.stringify([record.agentId, messageId]);
    if (seenMessageIds.has(messageKey)) continue;
    seenMessageIds.add(messageKey);

    const content = getOptionalString(data, 'content') || '';
    const reasoningText = getOptionalString(data, 'reasoningText') || '';
    const toolCalls = getToolRequests(data);
    const usage = {
      inputTokens: 0,
      outputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    };
    const tokenUsageForMessage = toTokenUsage(usage);
    const estimatedCosts = calculateCostAllModes(messageModel, 0, outputTokens, 0, 0);

    assistantMessageCount++;
    if (messageModel !== 'unknown') models.add(messageModel);
    addCopilotUsage(tokenUsage, usage);
    if (hasCopilotUsage(usage)) addModelUsage(modelUsage, messageModel, usage);
    searchableParts.push(content, reasoningText);
    for (const tool of toolCalls) {
      startedTools.set(tool.id, tool);
      recordTool(tool);
    }

    messages.push({
      role: 'assistant',
      content,
      timestamp,
      messageId,
      model: messageModel,
      subagent,
      usage: hasCopilotUsage(usage) ? tokenUsageForMessage : undefined,
      estimatedCosts: hasCopilotUsage(usage) ? estimatedCosts : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      blocks: reasoningText ? [{ type: 'thinking', title: 'Reasoning', summary: reasoningText, content: reasoningText, details: [] }] : undefined,
    });
  }

  const createdAt = time.first || fileInfo.createdAt || new Date(0).toISOString();
  const updatedAt = time.last || fileInfo.updatedAt || createdAt;
  const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(createdAt).getTime());
  const acceptedShutdownUsage = shutdownUsage && canUseLegacyShutdownUsage(shutdownUsage, modelUsage)
    ? shutdownUsage
    : null;
  if (acceptedShutdownUsage) {
    for (const model of Object.keys(acceptedShutdownUsage.modelUsage)) models.add(model);
    allocateLegacyShutdownUsageToMessages(messages, acceptedShutdownUsage);
  }
  const modelList = Array.from(models);
  const summaryUsage = acceptedShutdownUsage?.usage || tokenUsage;
  const summaryModelUsage = acceptedShutdownUsage?.modelUsage || modelUsage;
  const summary: CopilotParsedSessionSummary = {
    // Retain established token-based estimates when usage is available. A
    // credit checkpoint supplies a price even when token events were ephemeral.
    recordedUsageCost: !hasCopilotUsage(summaryUsage) ? recordedUsageCost : undefined,
    nativeId,
    routeNativeId: fileInfo.routeNativeId || `${fileInfo.workspaceHash}:${nativeId}`,
    title,
    workspaceHash: fileInfo.workspaceHash,
    nativeProjectId: fileInfo.nativeProjectId,
    projectName: fileInfo.projectName,
    cwd: fileInfo.cwd,
    version: fileInfo.version || '',
    createdAt,
    updatedAt,
    duration: Number.isNaN(duration) ? 0 : duration,
    userMessageCount,
    assistantMessageCount,
    messageCount: userMessageCount + assistantMessageCount,
    toolCallCount: seenToolCallIds.size,
    model: currentModel || acceptedShutdownUsage?.currentModel || modelList.at(-1) || 'unknown',
    models: modelList,
    tokenUsage: toTokenUsage(summaryUsage),
    reasoningOutputTokens: summaryUsage.reasoningOutputTokens,
    modelUsage: summaryModelUsage,
    toolsUsed,
    searchTextPreview: searchableParts.join('\n').toLowerCase().slice(0, SUMMARY_SEARCH_PREVIEW_LIMIT),
  };

  return {
    summary,
    messages,
    searchableText: searchableParts.join('\n').toLowerCase(),
  };
}

export function parseCopilotSessionSummaryFile(filePath: string, fileInfo: CopilotSessionFileInfo): CopilotParsedSessionSummary {
  if (isLegacyCopilotSession(filePath, fileInfo)) {
    return parseLegacyCopilotRecords(filePath, readCopilotRecords(filePath), fileInfo).summary;
  }

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
  let pendingUserContent = '';
  const modelCounts = new Map<string, number>();
  const fallbackUsage = zeroCopilotUsage();
  const fallbackModelUsage: Record<string, CachedModelUsage> = {};
  const shouldUseTranscriptTokenFallback = !hasCopilotUsage(chatSummary.usage);

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
  const transcriptRecords = transcriptPath ? readCopilotRecords(transcriptPath) : [];

  for (const record of transcriptRecords) {
    const data = asRecord(record.data) || {};
    addModelHint(modelCounts, getOptionalString(data, 'model'), 100);
    if (record.type === 'assistant.message') {
      addToolCallModelHints(modelCounts, getToolRequests(data));
    } else if (record.type === 'tool.execution_start') {
      const tool = buildToolStartCall(data);
      if (tool) addToolCallModelHints(modelCounts, [tool]);
    }
  }
  const inferredModelForFallback = chooseInferredTranscriptModel(modelCounts);

  for (const record of transcriptRecords) {
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
      const images = extractCopilotImages(data);
      if (content || images.length > 0) {
        userMessageCount++;
        if (content) title ||= firstLine(content);
        search.add(content);
        pendingUserContent = content;
      }
      continue;
    }

    if (record.type === 'assistant.message') {
      const content = getOptionalString(data, 'content') || '';
      const reasoningText = getOptionalString(data, 'reasoningText') || '';
      const toolCalls = getToolRequests(data);
      assistantMessageCount++;
      search.add(content);
      search.add(reasoningText);
      for (const tool of toolCalls) recordTool(tool);
      if (shouldUseTranscriptTokenFallback) {
        const model = normalizeCopilotModelId(getOptionalString(data, 'model'))
          || inferredModelForFallback
          || COPILOT_AUTO_MODEL;
        const usage = estimateTranscriptUsage(content, reasoningText, pendingUserContent, getOptionalNumber(data, 'outputTokens'));
        if (hasCopilotUsage(usage)) {
          addCopilotUsage(fallbackUsage, usage);
          addModelUsage(fallbackModelUsage, model, usage);
        }
      }
      pendingUserContent = '';
      continue;
    }

    if (record.type === 'tool.execution_start') {
      const tool = buildToolStartCall(data);
      if (tool) {
        recordTool(tool);
      }
    }
  }

  userMessageCount ||= chatSummary.userMessageCount;
  assistantMessageCount ||= chatSummary.assistantMessageCount;
  title ||= chatSummary.title || '';
  version ||= chatSummary.version || '';
  search.add(chatSummary.searchTextPreview);

  const createdAt = time.first || fileInfo.createdAt || new Date(0).toISOString();
  const updatedAt = time.last || fileInfo.updatedAt || createdAt;
  const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(createdAt).getTime());
  const inferredModel = inferredModelForFallback;
  const primaryModel = chooseCopilotModel(chatSummary, inferredModel);
  const tokenTotals = shouldUseTranscriptTokenFallback ? fallbackUsage : chatSummary.usage;
  const tokenUsage = toTokenUsage(tokenTotals);
  const modelUsage = shouldUseTranscriptTokenFallback ? fallbackModelUsage : buildCopilotModelUsage(chatSummary);
  const models = chooseCopilotModels(chatSummary, primaryModel);

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
    model: primaryModel,
    models,
    tokenUsage,
    reasoningOutputTokens: tokenTotals.reasoningOutputTokens,
    modelUsage,
    toolsUsed,
    searchTextPreview: search.value(),
  };
}

export function parseCopilotRecords(filePath: string, records: CopilotTranscriptRecord[], fileInfo: CopilotSessionFileInfo): CopilotParsedSession {
  if (isLegacyCopilotSession(filePath, fileInfo)) {
    const parsed = parseLegacyCopilotRecords(filePath, records, fileInfo);
    const info = buildBaseSessionInfo(filePath, parsed.summary);
    return {
      info,
      detail: { ...info, messages: parsed.messages },
      searchableText: parsed.searchableText,
    };
  }

  const chatSummary = getCopilotSidecarSummary(fileInfo);
  const requestUsages = chatSummary.requests;
  const subagentsByInvocationId = new Map(
    chatSummary.subagents.map(subagent => [subagent.invocationId, subagent]),
  );
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
  const modelCounts = new Map<string, number>();
  for (const record of records) {
    const data = asRecord(record.data) || {};
    addModelHint(modelCounts, getOptionalString(data, 'model'), 100);
    if (record.type === 'assistant.message') {
      addToolCallModelHints(modelCounts, getToolRequests(data));
    } else if (record.type === 'tool.execution_start') {
      const tool = buildToolStartCall(data);
      if (tool) addToolCallModelHints(modelCounts, [tool]);
    }
  }
  const inferredModel = chooseInferredTranscriptModel(modelCounts);
  const primaryModel = chooseCopilotModel(chatSummary, inferredModel);
  const shouldUseTranscriptTokenFallback = requestUsages.length === 0 && !hasCopilotUsage(chatSummary.usage);
  const parsedUsage = zeroCopilotUsage();
  const parsedModelUsage: Record<string, CachedModelUsage> = {};
  let pendingUserContent = '';

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
      model: primaryModel,
      models: chooseCopilotModels(chatSummary, primaryModel),
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
      const images = extractCopilotImages(data);
      if (!content && images.length === 0) continue;
      userMessageCount++;
      title ||= firstLine(content);
      searchableParts.push(content);
      pendingUserContent = content;
      messages.push({ role: 'user', content, timestamp, images: images.length > 0 ? images : undefined });
      continue;
    }

    if (record.type === 'assistant.message') {
      const content = getOptionalString(data, 'content') || '';
      const reasoningText = getOptionalString(data, 'reasoningText') || '';
      const toolCalls = getToolRequests(data);
      const blocks: SessionMessageBlockDisplay[] = [];
      const requestUsage = usageByAssistant.get(assistantMessageCount);
      const fallbackUsage = shouldUseTranscriptTokenFallback
        ? estimateTranscriptUsage(content, reasoningText, pendingUserContent, getOptionalNumber(data, 'outputTokens'))
        : null;
      const usageTotals = requestUsage?.usage || fallbackUsage;
      const messageModel = requestUsage?.model || normalizeCopilotModelId(getOptionalString(data, 'model')) || primaryModel;
      const usage = usageTotals ? toTokenUsage(usageTotals) : { ...EMPTY_USAGE };
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
      if (usageTotals && hasCopilotUsage(usageTotals)) {
        addCopilotUsage(parsedUsage, usageTotals);
        addModelUsage(parsedModelUsage, messageModel, usageTotals, requestUsage?.contextWindow, requestUsage?.maxOutputTokens);
      }
      pendingUserContent = '';

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
        model: primaryModel,
        toolCalls: [tool],
      });
      continue;
    }

    if (record.type === 'tool.execution_complete') {
      const toolCallId = getOptionalString(data, 'toolCallId') || getOptionalString(data, 'id') || '';
      const block = buildToolResultBlock(data, startedTools.get(toolCallId));
      const subagent = subagentsByInvocationId.get(toolCallId);
      searchableParts.push(block.summary, block.content || '', ...block.details.map(detail => detail.value));
      messages.push({
        role: 'tool-result',
        content: block.summary,
        timestamp,
        model: subagent?.model,
        blocks: [block],
        subagent: subagent ? {
          id: subagent.invocationId,
          parentId: subagent.parentInvocationId || nativeId,
          nickname: subagent.agentName,
          depth: resolveCopilotSubagentDepth(subagent, subagentsByInvocationId),
        } : undefined,
      });
    }
  }

  const createdAt = time.first || fileInfo.createdAt || new Date(0).toISOString();
  const updatedAt = time.last || fileInfo.updatedAt || createdAt;
  const duration = Math.max(0, new Date(updatedAt).getTime() - new Date(createdAt).getTime());
  const tokenTotals = hasCopilotUsage(parsedUsage) ? parsedUsage : chatSummary.usage;
  const tokenUsage = toTokenUsage(tokenTotals);
  const modelUsage = hasCopilotUsage(parsedUsage) ? parsedModelUsage : buildCopilotModelUsage(chatSummary);
  const models = chooseCopilotModels(chatSummary, primaryModel);
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
    model: primaryModel,
    models,
    tokenUsage,
    reasoningOutputTokens: tokenTotals.reasoningOutputTokens,
    modelUsage,
    toolsUsed,
    searchTextPreview: searchableParts.join('\n').toLowerCase().slice(0, SUMMARY_SEARCH_PREVIEW_LIMIT),
  };
  const info = buildBaseSessionInfo(filePath, summary);
  const detailMessages = mergeSidecarImageMessages(messages, chatSummary.messages);

  return {
    info,
    detail: { ...info, messages: detailMessages },
    searchableText: searchableParts.join('\n').toLowerCase(),
  };
}

export async function parseCopilotSessionFile(filePath: string, fileInfo: CopilotSessionFileInfo): Promise<CopilotParsedSession> {
  return parseCopilotRecords(filePath, readCopilotRecords(filePath), fileInfo);
}

export function getCopilotZeroUsage(): TokenUsage {
  return { ...EMPTY_USAGE };
}
