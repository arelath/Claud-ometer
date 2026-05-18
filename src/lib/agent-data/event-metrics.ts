import { calculateCostAllModes } from '@/config/pricing';
import { addCosts, zeroCosts } from '@/lib/claude-data/cost-utils';
import { makeChangeTotals, zeroChangeTotals } from '@/lib/claude-data/change-utils';
import type { ChangeTotals, CostEstimates, SessionMessageDisplay, TokenUsage } from '@/lib/claude-data/types';
import { getSessionDiffSummary } from '@/lib/session-diff';
import type { CachedModelUsage } from './session-summary';

export interface CachedUsageEvent {
  timestamp: string;
  role?: SessionMessageDisplay['role'];
  model?: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningOutputTokens?: number;
  estimatedCosts: CostEstimates;
}

export interface CachedChangeEvent extends ChangeTotals {
  timestamp: string;
}

export interface UsageEventSummaryInput {
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  tokenTotals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoningOutput?: number;
  };
  modelUsage: Record<string, CachedModelUsage>;
}

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningOutput: number;
}

const ZERO_TOKENS: TokenTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoningOutput: 0,
};

function hasTokens(tokens: TokenTotals): boolean {
  return tokens.input > 0
    || tokens.output > 0
    || tokens.cacheRead > 0
    || tokens.cacheWrite > 0
    || tokens.reasoningOutput > 0;
}

function tokenTotal(event: Pick<CachedUsageEvent, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
}

function usageToTokens(usage: TokenUsage | undefined): TokenTotals {
  if (!usage) return { ...ZERO_TOKENS };
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    reasoningOutput: 0,
  };
}

function modelUsageToTokens(usage: CachedModelUsage | undefined): TokenTotals {
  if (!usage) return { ...ZERO_TOKENS };
  return {
    input: usage.inputTokens || 0,
    output: usage.outputTokens || 0,
    cacheRead: usage.cacheReadInputTokens || 0,
    cacheWrite: usage.cacheCreationInputTokens || 0,
    reasoningOutput: usage.reasoningOutputTokens || 0,
  };
}

function eventCosts(model: string, tokens: TokenTotals): CostEstimates {
  if (!model || model === 'unknown') return zeroCosts();
  return calculateCostAllModes(model, tokens.input, tokens.output, tokens.cacheWrite, tokens.cacheRead);
}

function makeUsageEvent({
  timestamp,
  role,
  model,
  messageCount = 0,
  userMessageCount = 0,
  assistantMessageCount = 0,
  toolCallCount = 0,
  tokens = ZERO_TOKENS,
}: {
  timestamp: string;
  role?: SessionMessageDisplay['role'];
  model?: string;
  messageCount?: number;
  userMessageCount?: number;
  assistantMessageCount?: number;
  toolCallCount?: number;
  tokens?: TokenTotals;
}): CachedUsageEvent {
  const normalizedModel = model || 'unknown';
  return {
    timestamp,
    role,
    model: normalizedModel,
    messageCount,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    reasoningOutputTokens: tokens.reasoningOutput,
    estimatedCosts: eventCosts(normalizedModel, tokens),
  };
}

function eventModelKey(event: CachedUsageEvent): string {
  return event.model || 'unknown';
}

function subtractTokens(left: TokenTotals, right: TokenTotals): TokenTotals {
  return {
    input: Math.max(0, left.input - right.input),
    output: Math.max(0, left.output - right.output),
    cacheRead: Math.max(0, left.cacheRead - right.cacheRead),
    cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite),
    reasoningOutput: Math.max(0, left.reasoningOutput - right.reasoningOutput),
  };
}

export function buildUsageEvents(
  messages: SessionMessageDisplay[],
  summary: UsageEventSummaryInput,
): CachedUsageEvent[] {
  const events = messages.flatMap((message) => {
    const tokens = usageToTokens(message.usage);
    const isUserMessage = message.role === 'user' || message.role === 'command' || message.role === 'tool-result';
    const isAssistantMessage = message.role === 'assistant' || message.role === 'tool-use';
    const toolCallCount = message.toolCalls?.length || 0;
    const messageCount = isUserMessage || isAssistantMessage ? 1 : 0;
    const userMessageCount = isUserMessage ? 1 : 0;
    const assistantMessageCount = isAssistantMessage ? 1 : 0;

    if (messageCount === 0 && toolCallCount === 0 && !hasTokens(tokens)) return [];

    return makeUsageEvent({
      timestamp: message.timestamp || summary.updatedAt || summary.createdAt,
      role: message.role,
      model: message.model || summary.model,
      messageCount,
      userMessageCount,
      assistantMessageCount,
      toolCallCount,
      tokens,
    });
  });

  return reconcileUsageEvents(capUsageEventCounts(events, summary), summary);
}

export function buildLegacyUsageEvents(summary: UsageEventSummaryInput): CachedUsageEvent[] {
  const eventTimestamp = summary.updatedAt || summary.createdAt;
  const countEvent = makeUsageEvent({
    timestamp: eventTimestamp,
    model: summary.model,
    messageCount: summary.messageCount,
    userMessageCount: summary.userMessageCount,
    assistantMessageCount: summary.assistantMessageCount,
    toolCallCount: summary.toolCallCount,
  });
  const tokenEvents = Object.entries(summary.modelUsage)
    .map(([model, usage]) => makeUsageEvent({
      timestamp: eventTimestamp,
      model,
      tokens: modelUsageToTokens(usage),
    }))
    .filter(event => tokenTotal(event) > 0);

  if (tokenEvents.length === 0 && tokenTotal({
    inputTokens: summary.tokenTotals.input,
    outputTokens: summary.tokenTotals.output,
    cacheReadTokens: summary.tokenTotals.cacheRead,
    cacheWriteTokens: summary.tokenTotals.cacheWrite,
  }) > 0) {
    tokenEvents.push(makeUsageEvent({
      timestamp: eventTimestamp,
      model: summary.model,
      tokens: {
        input: summary.tokenTotals.input,
        output: summary.tokenTotals.output,
        cacheRead: summary.tokenTotals.cacheRead,
        cacheWrite: summary.tokenTotals.cacheWrite,
        reasoningOutput: summary.tokenTotals.reasoningOutput || 0,
      },
    }));
  }

  return [countEvent, ...tokenEvents]
    .filter(event => event.messageCount > 0 || event.toolCallCount > 0 || tokenTotal(event) > 0);
}

export function buildChangeEvents(messages: SessionMessageDisplay[]): CachedChangeEvent[] {
  return getSessionDiffSummary(messages).files.flatMap(file => file.editHunks.map(hunk => ({
    timestamp: hunk.timestamp,
    ...makeChangeTotals({
      addedLines: hunk.addedLines,
      removedLines: hunk.removedLines,
      fileCount: 1,
      editCount: 1,
    }),
  }))).filter(event => event.changedLines > 0);
}

export function buildLegacyChangeEvents(summary: Pick<UsageEventSummaryInput, 'createdAt' | 'updatedAt'> & {
  changeTotals?: ChangeTotals;
}): CachedChangeEvent[] {
  const totals = summary.changeTotals || zeroChangeTotals();
  if (totals.changedLines <= 0) return [];
  return [{
    timestamp: summary.updatedAt || summary.createdAt,
    ...totals,
  }];
}

function reconcileUsageEvents(
  events: CachedUsageEvent[],
  summary: UsageEventSummaryInput,
): CachedUsageEvent[] {
  const reconciled = [...events];
  const eventTimestamp = summary.updatedAt || summary.createdAt;
  const counts = events.reduce((sum, event) => ({
    messageCount: sum.messageCount + event.messageCount,
    userMessageCount: sum.userMessageCount + event.userMessageCount,
    assistantMessageCount: sum.assistantMessageCount + event.assistantMessageCount,
    toolCallCount: sum.toolCallCount + event.toolCallCount,
  }), { messageCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0 });

  const countDelta = {
    messageCount: Math.max(0, summary.messageCount - counts.messageCount),
    userMessageCount: Math.max(0, summary.userMessageCount - counts.userMessageCount),
    assistantMessageCount: Math.max(0, summary.assistantMessageCount - counts.assistantMessageCount),
    toolCallCount: Math.max(0, summary.toolCallCount - counts.toolCallCount),
  };
  if (countDelta.messageCount > 0 || countDelta.toolCallCount > 0) {
    reconciled.push(makeUsageEvent({
      timestamp: eventTimestamp,
      model: summary.model,
      ...countDelta,
    }));
  }

  const eventTokensByModel = new Map<string, TokenTotals>();
  for (const event of events) {
    const key = eventModelKey(event);
    const existing = eventTokensByModel.get(key) || { ...ZERO_TOKENS };
    existing.input += event.inputTokens;
    existing.output += event.outputTokens;
    existing.cacheRead += event.cacheReadTokens;
    existing.cacheWrite += event.cacheWriteTokens;
    existing.reasoningOutput += event.reasoningOutputTokens || 0;
    eventTokensByModel.set(key, existing);
  }

  for (const [model, usage] of Object.entries(summary.modelUsage)) {
    const remaining = subtractTokens(modelUsageToTokens(usage), eventTokensByModel.get(model) || ZERO_TOKENS);
    if (!hasTokens(remaining)) continue;
    reconciled.push(makeUsageEvent({
      timestamp: eventTimestamp,
      model,
      tokens: remaining,
    }));
  }

  if (Object.keys(summary.modelUsage).length === 0) {
    const totalEventTokens = Array.from(eventTokensByModel.values()).reduce((sum, tokens) => ({
      input: sum.input + tokens.input,
      output: sum.output + tokens.output,
      cacheRead: sum.cacheRead + tokens.cacheRead,
      cacheWrite: sum.cacheWrite + tokens.cacheWrite,
      reasoningOutput: sum.reasoningOutput + tokens.reasoningOutput,
    }), { ...ZERO_TOKENS });
    const remaining = subtractTokens({
      input: summary.tokenTotals.input,
      output: summary.tokenTotals.output,
      cacheRead: summary.tokenTotals.cacheRead,
      cacheWrite: summary.tokenTotals.cacheWrite,
      reasoningOutput: summary.tokenTotals.reasoningOutput || 0,
    }, totalEventTokens);
    if (hasTokens(remaining)) {
      reconciled.push(makeUsageEvent({
        timestamp: eventTimestamp,
        model: summary.model,
        tokens: remaining,
      }));
    }
  }

  return reconciled;
}

function capUsageEventCounts(events: CachedUsageEvent[], summary: UsageEventSummaryInput): CachedUsageEvent[] {
  let remainingMessages = summary.messageCount;
  let remainingUserMessages = summary.userMessageCount;
  let remainingAssistantMessages = summary.assistantMessageCount;
  let remainingToolCalls = summary.toolCallCount;

  return events.map((event) => {
    const userMessageCount = Math.min(event.userMessageCount, remainingUserMessages);
    remainingUserMessages -= userMessageCount;

    const assistantMessageCount = Math.min(event.assistantMessageCount, remainingAssistantMessages);
    remainingAssistantMessages -= assistantMessageCount;

    const roleMessageCount = userMessageCount + assistantMessageCount;
    const messageCount = Math.min(event.messageCount, remainingMessages, roleMessageCount || event.messageCount);
    remainingMessages -= messageCount;

    const toolCallCount = Math.min(event.toolCallCount, remainingToolCalls);
    remainingToolCalls -= toolCallCount;

    return {
      ...event,
      messageCount,
      userMessageCount,
      assistantMessageCount,
      toolCallCount,
    };
  });
}

export function sumUsageEventCosts(events: CachedUsageEvent[]): CostEstimates {
  return events.reduce((sum, event) => addCosts(sum, event.estimatedCosts), zeroCosts());
}
