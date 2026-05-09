import { calculateCostAllModes } from '@/config/pricing';
import type { CostEstimates, SessionMessageDisplay, TokenUsage } from '@/lib/claude-data/types';

type AssistantMetricMessage = Pick<
  SessionMessageDisplay,
  'blocks' | 'content' | 'messageId' | 'model' | 'stopReason' | 'toolCalls' | 'usage'
>;

function zeroCosts(): CostEstimates {
  return { api: 0, conservative: 0, subscription: 0 };
}

function addCosts(left: CostEstimates, right: CostEstimates): CostEstimates {
  return {
    api: left.api + right.api,
    conservative: left.conservative + right.conservative,
    subscription: left.subscription + right.subscription,
  };
}

function addCacheWriteTokens(usage: TokenUsage, extraCacheWriteTokens: number): TokenUsage {
  if (extraCacheWriteTokens === 0) return usage;
  return {
    ...usage,
    cache_creation_input_tokens: (usage.cache_creation_input_tokens || 0) + extraCacheWriteTokens,
  };
}

function isThinkingOnlyAssistantSnapshot(message: AssistantMetricMessage): boolean {
  if (message.content?.trim()) return false;
  if ((message.toolCalls || []).length > 0) return false;

  const blocks = message.blocks || [];
  return blocks.length > 0 && blocks.every(block => block.type === 'thinking');
}

function hasVisibleAssistantSnapshotContent(message: AssistantMetricMessage): boolean {
  if (message.content?.trim()) return true;
  if ((message.toolCalls || []).length > 0) return true;
  return (message.blocks || []).some(block => block.type !== 'thinking' && Boolean(block.summary || block.content || block.details.length > 0));
}

function getUniqueAssistantMetricMessages(messages: AssistantMetricMessage[]): AssistantMetricMessage[] {
  const states = new Map<string, {
    latest: AssistantMetricMessage;
    extraCacheWriteTokens: number;
    pendingThinkingOnlyCacheWriteTokens: number;
    sawNonThinkingSnapshot: boolean;
  }>();

  messages.forEach((message, index) => {
    if (!message.usage) return;

    const key = message.messageId || `assistant-turn-${index}`;
    const state = states.get(key) || {
      latest: message,
      extraCacheWriteTokens: 0,
      pendingThinkingOnlyCacheWriteTokens: 0,
      sawNonThinkingSnapshot: false,
    };

    const isThinkingOnlySnapshot = isThinkingOnlyAssistantSnapshot(message);
    const hasVisibleContent = hasVisibleAssistantSnapshotContent(message);

    if (isThinkingOnlySnapshot && !state.sawNonThinkingSnapshot) {
      state.pendingThinkingOnlyCacheWriteTokens = message.usage.cache_creation_input_tokens || 0;
    } else {
      if (
        hasVisibleContent
        && message.stopReason === 'end_turn'
        && !state.sawNonThinkingSnapshot
        && state.pendingThinkingOnlyCacheWriteTokens > 0
      ) {
        state.extraCacheWriteTokens += state.pendingThinkingOnlyCacheWriteTokens;
      }

      if (!isThinkingOnlySnapshot) {
        state.sawNonThinkingSnapshot = true;
      }

      state.pendingThinkingOnlyCacheWriteTokens = 0;
    }

    state.latest = message;
    states.set(key, state);
  });

  return [...states.values()].map(state => ({
    ...state.latest,
    usage: state.latest.usage ? addCacheWriteTokens(state.latest.usage, state.extraCacheWriteTokens) : undefined,
  }));
}

function mergeTokenUsage(messages: AssistantMetricMessage[]): TokenUsage | undefined {
  const usages = messages.map(message => message.usage).filter((usage): usage is TokenUsage => Boolean(usage));
  if (usages.length === 0) return undefined;

  return {
    input_tokens: usages.reduce((sum, usage) => sum + (usage.input_tokens || 0), 0),
    output_tokens: usages.reduce((sum, usage) => sum + (usage.output_tokens || 0), 0),
    cache_creation_input_tokens: usages.reduce((sum, usage) => sum + (usage.cache_creation_input_tokens || 0), 0),
    cache_read_input_tokens: usages.reduce((sum, usage) => sum + (usage.cache_read_input_tokens || 0), 0),
    cache_creation: {
      ephemeral_5m_input_tokens: usages.reduce((sum, usage) => sum + (usage.cache_creation?.ephemeral_5m_input_tokens || 0), 0),
      ephemeral_1h_input_tokens: usages.reduce((sum, usage) => sum + (usage.cache_creation?.ephemeral_1h_input_tokens || 0), 0),
    },
    service_tier: usages[usages.length - 1]?.service_tier,
  };
}

export function buildAssistantTurnMetrics(messages: AssistantMetricMessage[]): {
  usage?: TokenUsage;
  estimatedCosts?: CostEstimates;
} {
  const uniqueMessages = getUniqueAssistantMetricMessages(messages);
  const mergedUsage = mergeTokenUsage(uniqueMessages);

  if (!mergedUsage) return {};

  const estimatedCosts = uniqueMessages.reduce((totals, message) => {
    if (!message.model || !message.usage) return totals;
    return addCosts(
      totals,
      calculateCostAllModes(
        message.model,
        message.usage.input_tokens || 0,
        message.usage.output_tokens || 0,
        message.usage.cache_creation_input_tokens || 0,
        message.usage.cache_read_input_tokens || 0,
      ),
    );
  }, zeroCosts());

  return {
    usage: mergedUsage,
    estimatedCosts,
  };
}
