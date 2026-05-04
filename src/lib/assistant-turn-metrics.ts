import { calculateCostAllModes } from '@/config/pricing';
import type { CostEstimates, SessionMessageDisplay, TokenUsage } from '@/lib/claude-data/types';

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

function mergeTokenUsage(usages: TokenUsage[]): TokenUsage | undefined {
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

export function buildAssistantTurnMetrics(messages: Pick<SessionMessageDisplay, 'messageId' | 'model' | 'usage'>[]): {
  usage?: TokenUsage;
  estimatedCosts?: CostEstimates;
} {
  const dedupedMessages = new Map<string, Pick<SessionMessageDisplay, 'messageId' | 'model' | 'usage'>>();

  messages.forEach((message, index) => {
    if (!message.usage) return;
    dedupedMessages.set(message.messageId || `assistant-turn-${index}`, message);
  });

  const uniqueMessages = [...dedupedMessages.values()];
  const mergedUsage = mergeTokenUsage(uniqueMessages.map(message => message.usage).filter((usage): usage is TokenUsage => Boolean(usage)));

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