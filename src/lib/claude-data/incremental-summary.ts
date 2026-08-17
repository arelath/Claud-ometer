import fs from 'fs';
import path from 'path';
import { calculateCostAllModes, getModelDisplayName } from '@/config/pricing';
import {
  jsonlBoundaryHash,
  scanBoundedJsonlRecords,
} from '@/lib/agent-data/bounded-jsonl-scanner';
import type {
  IncrementalIndexMutations,
  IncrementalSessionSummaryResult,
} from '@/lib/agent-data/provider';
import { sourceSummaryCacheKey } from '@/lib/agent-data/session-summary-cache';
import type { CachedModelUsage, CachedSessionSummary, SessionSummarySource } from '@/lib/agent-data/session-summary';
import type { SourceParseCheckpoint } from '@/lib/agent-data/session-parse-checkpoint';
import { SessionSummaryDeferredError } from '@/lib/agent-data/session-summary-deferred';
import { getSessionAggregateFilePaths, sessionMessageSchema } from './io';
import { isRecord } from './record-utils';
import type { SessionMessage, TokenUsage } from './types';

export const CLAUDE_INCREMENTAL_CHECKPOINT_VERSION = 1;
const CONTINUATION_VERSION = 1;
const MAX_RETAINED_TURNS = 128;
const MAX_DELTA_BYTES = 4 * 1024 * 1024;
const MAX_DELTA_RECORDS = 4000;
const MAX_CHECKPOINT_JSON_BYTES = 256 * 1024;
const MAX_COMPONENTS = 512;

interface ClaudeComponentCursor {
  componentKey: string;
  filePath: string;
  size: number;
  mtimeMs: number;
  completeOffset: number;
  boundaryHash: string;
}

interface ClaudeComponentState {
  version: 1;
  components: ClaudeComponentCursor[];
}

interface ClaudeTurnState {
  key: string;
  model: string;
  timestamp: string;
  topLevel: boolean;
  usage?: TokenUsage;
  toolCalls: Record<string, string>;
}

interface ClaudeReducerContinuation {
  version: 1;
  lastTimestamp: string;
  turns: ClaudeTurnState[];
}

function componentKey(rootPath: string, filePath: string): string {
  if (path.resolve(rootPath) === path.resolve(filePath)) return 'root';
  return path.relative(path.dirname(rootPath), filePath).replaceAll('\\', '/');
}

function componentSnapshots(rootPath: string): ClaudeComponentCursor[] {
  return getSessionAggregateFilePaths(rootPath)
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      return {
        componentKey: componentKey(rootPath, filePath),
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        completeOffset: 0,
        boundaryHash: jsonlBoundaryHash(filePath, 0),
      };
    })
    .sort((left, right) => {
      if (left.componentKey === 'root') return -1;
      if (right.componentKey === 'root') return 1;
      return left.componentKey.localeCompare(right.componentKey);
    });
}

function parseMessage(line: string): SessionMessage {
  const parsed = sessionMessageSchema.safeParse(JSON.parse(line));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data as SessionMessage;
}

function messageId(message: SessionMessage, recordStartOffset: number): string {
  const nativeMessage = message.message;
  if (typeof nativeMessage?.id === 'string' && nativeMessage.id) return nativeMessage.id;
  return message.uuid || message.timestamp || `offset-${recordStartOffset}`;
}

function toolCalls(message: SessionMessage): Record<string, string> {
  if (!Array.isArray(message.message?.content)) return {};
  return Object.fromEntries(message.message.content.flatMap((block, index) => {
    if (!isRecord(block) || block.type !== 'tool_use') return [];
    const name = typeof block.name === 'string' && block.name ? block.name : 'unknown';
    const id = typeof block.id === 'string' && block.id ? block.id : `${name}-${index}`;
    return [[id, name]];
  }));
}

function containsHistoryDependentChange(message: SessionMessage): boolean {
  const changeTools = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);
  return Object.values(toolCalls(message)).some(name => changeTools.has(name));
}

function contentText(message: SessionMessage): string {
  const content = message.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => {
    if (!isRecord(block)) return [];
    if (typeof block.text === 'string') return [block.text];
    if (typeof block.content === 'string') return [block.content];
    return [];
  }).join('\n');
}

function parseComponentState(checkpoint: SourceParseCheckpoint): ClaudeComponentState | null {
  if (Buffer.byteLength(checkpoint.componentStateJson, 'utf8') > MAX_CHECKPOINT_JSON_BYTES) return null;
  try {
    const state = JSON.parse(checkpoint.componentStateJson) as ClaudeComponentState;
    if (
      !state
      || state.version !== 1
      || !Array.isArray(state.components)
      || state.components.length === 0
      || state.components.length > MAX_COMPONENTS
    ) return null;
    const keys = new Set<string>();
    for (const component of state.components) {
      if (
        !component
        || typeof component.componentKey !== 'string'
        || !component.componentKey
        || typeof component.filePath !== 'string'
        || !component.filePath
        || !Number.isSafeInteger(component.size)
        || component.size < 0
        || !Number.isFinite(component.mtimeMs)
        || !Number.isSafeInteger(component.completeOffset)
        || component.completeOffset < 0
        || component.completeOffset > component.size
        || typeof component.boundaryHash !== 'string'
        || keys.has(component.componentKey)
      ) return null;
      keys.add(component.componentKey);
    }
    return state;
  } catch {
    return null;
  }
}

function parseContinuation(checkpoint: SourceParseCheckpoint): ClaudeReducerContinuation | null {
  if (Buffer.byteLength(checkpoint.accumulatorJson, 'utf8') > MAX_CHECKPOINT_JSON_BYTES) return null;
  try {
    const state = JSON.parse(checkpoint.accumulatorJson) as ClaudeReducerContinuation;
    if (
      !state
      || state.version !== CONTINUATION_VERSION
      || typeof state.lastTimestamp !== 'string'
      || !Array.isArray(state.turns)
      || state.turns.length > MAX_RETAINED_TURNS
    ) return null;
    const keys = new Set<string>();
    for (const turn of state.turns) {
      if (
        !turn
        || typeof turn.key !== 'string'
        || !turn.key
        || typeof turn.model !== 'string'
        || typeof turn.timestamp !== 'string'
        || typeof turn.topLevel !== 'boolean'
        || (turn.usage !== undefined && (
          !isRecord(turn.usage)
          || ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
            .some(key => turn.usage?.[key as keyof TokenUsage] !== undefined
              && typeof turn.usage?.[key as keyof TokenUsage] !== 'number')
        ))
        || !isRecord(turn.toolCalls)
        || Object.values(turn.toolCalls).some(value => typeof value !== 'string')
        || keys.has(turn.key)
      ) return null;
      keys.add(turn.key);
    }
    return state;
  } catch {
    return null;
  }
}

function pruneTurns(turns: Map<string, ClaudeTurnState>): void {
  if (turns.size <= MAX_RETAINED_TURNS) return;
  const oldest = Array.from(turns.values())
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(0, turns.size - MAX_RETAINED_TURNS);
  for (const turn of oldest) turns.delete(turn.key);
}

function updateContinuation(
  continuation: ClaudeReducerContinuation,
  turns: Map<string, ClaudeTurnState>,
  component: ClaudeComponentCursor,
  message: SessionMessage,
  recordStartOffset: number,
): { previous?: ClaudeTurnState; current?: ClaudeTurnState } {
  if (message.timestamp && message.timestamp > continuation.lastTimestamp) continuation.lastTimestamp = message.timestamp;
  if (message.type !== 'assistant') return {};
  const key = `${component.componentKey}:${messageId(message, recordStartOffset)}`;
  const previous = turns.get(key);
  const current: ClaudeTurnState = {
    key,
    model: typeof message.message?.model === 'string' && message.message.model
      ? message.message.model
      : previous?.model || 'unknown',
    timestamp: message.timestamp || previous?.timestamp || '',
    topLevel: component.componentKey === 'root' || Boolean(previous?.topLevel),
    usage: message.message?.usage as TokenUsage | undefined || previous?.usage,
    toolCalls: { ...(previous?.toolCalls || {}), ...toolCalls(message) },
  };
  turns.set(key, current);
  pruneTurns(turns);
  return { previous, current };
}

function checkpointFor(
  source: SessionSummarySource,
  components: ClaudeComponentCursor[],
  continuation: ClaudeReducerContinuation,
  recordCount: number,
): SourceParseCheckpoint {
  const root = components.find(component => component.componentKey === 'root');
  return {
    sourceKey: sourceSummaryCacheKey(source),
    provider: 'claude',
    parserVersion: source.parserVersion,
    checkpointVersion: CLAUDE_INCREMENTAL_CHECKPOINT_VERSION,
    sourceFilePath: source.sourceFilePath,
    sourceSize: source.sourceSignature.size,
    sourceMtimeMs: source.sourceSignature.mtimeMs,
    lastCompleteOffset: root?.completeOffset || 0,
    recordCount,
    componentStateJson: JSON.stringify({ version: 1, components } satisfies ClaudeComponentState),
    accumulatorJson: JSON.stringify(continuation),
    updatedAt: new Date().toISOString(),
  };
}

export function buildClaudeSummaryCheckpoint(
  source: SessionSummarySource,
): SourceParseCheckpoint {
  const components = componentSnapshots(source.sourceFilePath);
  const observedSize = components.reduce((total, component) => total + component.size, 0);
  const observedMtimeMs = components.reduce((latest, component) => Math.max(latest, component.mtimeMs), 0);
  if (observedSize !== source.sourceSignature.size || observedMtimeMs !== source.sourceSignature.mtimeMs) {
    throw new Error('Claude source changed after its indexing snapshot was captured');
  }
  const continuation: ClaudeReducerContinuation = { version: 1, lastTimestamp: '', turns: [] };
  const turns = new Map<string, ClaudeTurnState>();
  let recordCount = 0;

  for (const component of components) {
    while (component.completeOffset < component.size) {
      const scan = scanBoundedJsonlRecords(component.filePath, {
        startOffset: component.completeOffset,
        endOffset: component.size,
        maxBytes: 1024 * 1024,
        maxRecords: 1000,
        expectedBoundaryHash: component.boundaryHash,
        parseRecord: parseMessage,
      });
      if (scan.error) throw new Error(scan.error);
      if (scan.partialTrailingRecord) {
        throw new SessionSummaryDeferredError(
          `Claude component ${component.componentKey} has an unterminated JSONL record`,
        );
      }
      for (const record of scan.records) {
        updateContinuation(continuation, turns, component, record.value, record.recordStartOffset);
        recordCount += 1;
      }
      component.completeOffset = scan.nextOffset;
      component.boundaryHash = scan.boundaryHash;
      if (scan.nextOffset === component.size || scan.partialTrailingRecord || scan.records.length === 0) break;
    }
  }
  continuation.turns = Array.from(turns.values());
  return checkpointFor(source, components, continuation, recordCount);
}

function usageNumbers(usage: TokenUsage | undefined) {
  return {
    input: usage?.input_tokens || 0,
    output: usage?.output_tokens || 0,
    cacheRead: usage?.cache_read_input_tokens || 0,
    cacheWrite: usage?.cache_creation_input_tokens || 0,
  };
}

function adjustModelUsage(
  summary: CachedSessionSummary,
  model: string,
  usage: TokenUsage | undefined,
  direction: 1 | -1,
): void {
  if (!usage) return;
  const numbers = usageNumbers(usage);
  const current: CachedModelUsage = summary.modelUsage[model] || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  current.inputTokens = Math.max(0, current.inputTokens + direction * numbers.input);
  current.outputTokens = Math.max(0, current.outputTokens + direction * numbers.output);
  current.cacheReadInputTokens = Math.max(0, current.cacheReadInputTokens + direction * numbers.cacheRead);
  current.cacheCreationInputTokens = Math.max(0, current.cacheCreationInputTokens + direction * numbers.cacheWrite);
  summary.modelUsage[model] = current;
  summary.tokenTotals.input = Math.max(0, summary.tokenTotals.input + direction * numbers.input);
  summary.tokenTotals.output = Math.max(0, summary.tokenTotals.output + direction * numbers.output);
  summary.tokenTotals.cacheRead = Math.max(0, summary.tokenTotals.cacheRead + direction * numbers.cacheRead);
  summary.tokenTotals.cacheWrite = Math.max(0, summary.tokenTotals.cacheWrite + direction * numbers.cacheWrite);
}

function applyRecord(
  summary: CachedSessionSummary,
  continuation: ClaudeReducerContinuation,
  turns: Map<string, ClaudeTurnState>,
  component: ClaudeComponentCursor,
  message: SessionMessage,
  recordStartOffset: number,
  mutations: IncrementalIndexMutations,
): boolean {
  const timestamp = message.timestamp || summary.updatedAt;
  if (timestamp > summary.updatedAt) summary.updatedAt = timestamp;
  if (component.componentKey === 'root') {
    if (!summary.cwd && message.cwd) summary.cwd = message.cwd;
    if (!summary.gitBranch && message.gitBranch) summary.gitBranch = message.gitBranch;
    if (!summary.version && message.version) summary.version = message.version;
    if (message.compactMetadata) {
      summary.compaction.compactions += 1;
      summary.compaction.compactionTimestamps.push(timestamp);
    }
    if (message.microcompactMetadata) {
      summary.compaction.microcompactions += 1;
      summary.compaction.totalTokensSaved += Number(message.microcompactMetadata.tokensSaved) || 0;
      summary.compaction.compactionTimestamps.push(timestamp);
    }
    if (message.type === 'user' && message.message?.role === 'user') {
      summary.userMessageCount += 1;
      summary.messageCount += 1;
      mutations.usageEvents.push({
        componentKey: component.componentKey,
        recordIdentity: String(recordStartOffset),
        eventOrdinal: 0,
        event: {
          timestamp,
          role: 'user',
          model: summary.model || 'unknown',
          messageCount: 1,
          userMessageCount: 1,
          assistantMessageCount: 0,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningOutputTokens: 0,
          estimatedCosts: { api: 0, conservative: 0, subscription: 0 },
        },
      });
    }
    const text = contentText(message);
    const existingPreview = summary.searchTextPreview || '';
    if (text && existingPreview.length < 8 * 1024) {
      summary.searchTextPreview = `${existingPreview}\n${text}`.slice(0, 8 * 1024).toLowerCase();
    }
  }

  if (containsHistoryDependentChange(message)) return false;
  const { previous, current } = updateContinuation(continuation, turns, component, message, recordStartOffset);
  if (!current) return true;
  if (!previous && continuation.lastTimestamp && current.timestamp < continuation.lastTimestamp) return false;

  if (!previous && current.topLevel) {
    summary.assistantMessageCount += 1;
    summary.messageCount += 1;
  }
  if (previous && previous.model !== current.model) return false;
  if (previous?.usage) adjustModelUsage(summary, previous.model || 'unknown', previous.usage, -1);
  adjustModelUsage(summary, current.model || 'unknown', current.usage, 1);
  let newToolCount = 0;
  for (const [toolId, name] of Object.entries(current.toolCalls)) {
    if (previous?.toolCalls[toolId]) continue;
    if (current.topLevel) {
      summary.toolCallCount += 1;
      summary.toolsUsed[name] = (summary.toolsUsed[name] || 0) + 1;
      newToolCount += 1;
    }
  }
  if (current.model && current.model !== 'unknown') {
    summary.model = summary.model === 'unknown' ? current.model : summary.model;
    const display = getModelDisplayName(current.model);
    if (!summary.models.includes(display)) summary.models.push(display);
  }
  const numbers = usageNumbers(current.usage);
  const previousNumbers = usageNumbers(previous?.usage);
  const tokenDelta = {
    input: numbers.input - previousNumbers.input,
    output: numbers.output - previousNumbers.output,
    cacheRead: numbers.cacheRead - previousNumbers.cacheRead,
    cacheWrite: numbers.cacheWrite - previousNumbers.cacheWrite,
  };
  const assistantCount = !previous && current.topLevel ? 1 : 0;
  if (assistantCount || newToolCount || Object.values(tokenDelta).some(value => value !== 0)) {
    const currentCosts = current.model && current.model !== 'unknown'
      ? calculateCostAllModes(current.model, numbers.input, numbers.output, numbers.cacheWrite, numbers.cacheRead)
      : { api: 0, conservative: 0, subscription: 0 };
    const previousCosts = current.model && current.model !== 'unknown'
      ? calculateCostAllModes(
          current.model,
          previousNumbers.input,
          previousNumbers.output,
          previousNumbers.cacheWrite,
          previousNumbers.cacheRead,
        )
      : { api: 0, conservative: 0, subscription: 0 };
    mutations.usageEvents.push({
      componentKey: component.componentKey,
      recordIdentity: String(recordStartOffset),
      eventOrdinal: 0,
      event: {
        timestamp: current.timestamp || timestamp,
        role: 'assistant',
        model: current.model || 'unknown',
        messageCount: assistantCount,
        userMessageCount: 0,
        assistantMessageCount: assistantCount,
        toolCallCount: newToolCount,
        inputTokens: tokenDelta.input,
        outputTokens: tokenDelta.output,
        cacheReadTokens: tokenDelta.cacheRead,
        cacheWriteTokens: tokenDelta.cacheWrite,
        reasoningOutputTokens: 0,
        estimatedCosts: {
          api: currentCosts.api - previousCosts.api,
          conservative: currentCosts.conservative - previousCosts.conservative,
          subscription: currentCosts.subscription - previousCosts.subscription,
        },
      },
    });
  }
  return true;
}

export function tryBuildIncrementalClaudeSummary(
  source: SessionSummarySource,
  previousSummary: CachedSessionSummary,
  checkpoint: SourceParseCheckpoint,
): IncrementalSessionSummaryResult | null {
  if (
    checkpoint.provider !== 'claude'
    || checkpoint.parserVersion !== source.parserVersion
    || checkpoint.checkpointVersion !== CLAUDE_INCREMENTAL_CHECKPOINT_VERSION
  ) return null;
  const priorState = parseComponentState(checkpoint);
  const continuation = parseContinuation(checkpoint);
  if (!priorState || !continuation) return null;
  const rootComponents = priorState.components.filter(component => component.componentKey === 'root');
  if (
    rootComponents.length !== 1
    || path.resolve(rootComponents[0].filePath) !== path.resolve(source.sourceFilePath)
    || rootComponents[0].completeOffset !== checkpoint.lastCompleteOffset
    || priorState.components.reduce((total, component) => total + component.size, 0) !== checkpoint.sourceSize
    || priorState.components.reduce((latest, component) => Math.max(latest, component.mtimeMs), 0) !== checkpoint.sourceMtimeMs
  ) return null;

  const previousComponents = new Map(priorState.components.map(component => [component.componentKey, component]));
  const components = componentSnapshots(source.sourceFilePath);
  if (
    components.reduce((total, component) => total + component.size, 0) !== source.sourceSignature.size
    || components.reduce((latest, component) => Math.max(latest, component.mtimeMs), 0) !== source.sourceSignature.mtimeMs
  ) return null;
  if (Array.from(previousComponents.keys()).some(key => !components.some(component => component.componentKey === key))) return null;
  const turns = new Map(continuation.turns.map(turn => [turn.key, turn]));
  const summary = JSON.parse(JSON.stringify(previousSummary)) as CachedSessionSummary;
  summary.parserVersion = source.parserVersion;
  summary.sourceSignature = source.sourceSignature;
  summary.usageEvents = [];
  summary.changeEvents = [];
  const mutations: IncrementalIndexMutations = { usageEvents: [], changeEvents: [] };
  let recordCount = checkpoint.recordCount;
  let totalBytes = 0;
  let totalRecords = 0;

  for (const component of components) {
    const previous = previousComponents.get(component.componentKey);
    if (previous) {
      if (previous.filePath !== component.filePath || component.size < previous.completeOffset) return null;
      if (component.size === previous.size && component.mtimeMs !== previous.mtimeMs) return null;
      if (jsonlBoundaryHash(component.filePath, previous.completeOffset) !== previous.boundaryHash) return null;
      component.completeOffset = previous.completeOffset;
      component.boundaryHash = previous.boundaryHash;
    }
    while (component.completeOffset < component.size) {
      const scan = scanBoundedJsonlRecords(component.filePath, {
        startOffset: component.completeOffset,
        endOffset: component.size,
        maxBytes: Math.min(1024 * 1024, MAX_DELTA_BYTES - totalBytes),
        maxRecords: Math.min(1000, MAX_DELTA_RECORDS - totalRecords),
        expectedBoundaryHash: component.boundaryHash,
        parseRecord: parseMessage,
      });
      if (scan.error) return null;
      for (const record of scan.records) {
        if (!applyRecord(summary, continuation, turns, component, record.value, record.recordStartOffset, mutations)) return null;
        recordCount += 1;
        totalRecords += 1;
      }
      totalBytes += scan.bytesConsumed;
      component.completeOffset = scan.nextOffset;
      component.boundaryHash = scan.boundaryHash;
      if (totalBytes >= MAX_DELTA_BYTES || totalRecords >= MAX_DELTA_RECORDS) return null;
      if (scan.nextOffset === component.size || scan.partialTrailingRecord || scan.records.length === 0) break;
    }
  }

  continuation.turns = Array.from(turns.values());
  return {
    summary,
    checkpoint: checkpointFor(source, components, continuation, recordCount),
    mutations,
  };
}
