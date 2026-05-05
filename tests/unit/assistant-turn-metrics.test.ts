import { describe, expect, it } from 'vitest';
import { buildAssistantTurnMetrics } from '@/lib/assistant-turn-metrics';
import type { SessionMessageDisplay, TokenUsage } from '@/lib/claude-data/types';

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...partial,
  };
}

function assistant(partial: Partial<SessionMessageDisplay>): Pick<SessionMessageDisplay, 'messageId' | 'model' | 'usage'> {
  return partial;
}

describe('assistant turn metrics', () => {
  it('deduplicates repeated assistant snapshots by message id using the latest usage', () => {
    const metrics = buildAssistantTurnMetrics([
      assistant({
        messageId: 'turn-1',
        model: 'claude-opus-4',
        usage: usage({
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          service_tier: 'standard',
        }),
      }),
      assistant({
        messageId: 'turn-1',
        model: 'claude-opus-4',
        usage: usage({
          input_tokens: 100,
          output_tokens: 25,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          service_tier: 'standard',
        }),
      }),
      assistant({
        messageId: 'turn-2',
        model: 'claude-haiku-4-5-20251001',
        usage: usage({
          input_tokens: 7,
          output_tokens: 3,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 11,
          service_tier: 'batch',
        }),
      }),
    ]);

    expect(metrics.usage).toEqual({
      input_tokens: 107,
      output_tokens: 28,
      cache_creation_input_tokens: 22,
      cache_read_input_tokens: 41,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
      service_tier: 'batch',
    });
    expect(metrics.estimatedCosts?.subscription).toBeGreaterThan(0);
  });

  it('keeps cache creation subtype totals when merging usage', () => {
    const metrics = buildAssistantTurnMetrics([
      assistant({
        messageId: 'turn-1',
        usage: usage({
          cache_creation: {
            ephemeral_5m_input_tokens: 12,
            ephemeral_1h_input_tokens: 4,
          },
        }),
      }),
      assistant({
        messageId: 'turn-2',
        usage: usage({
          cache_creation: {
            ephemeral_5m_input_tokens: 3,
            ephemeral_1h_input_tokens: 9,
          },
        }),
      }),
    ]);

    expect(metrics.usage?.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 15,
      ephemeral_1h_input_tokens: 13,
    });
    expect(metrics.estimatedCosts).toEqual({
      api: 0,
      conservative: 0,
      subscription: 0,
    });
  });

  it('returns empty metrics when no assistant snapshot has usage', () => {
    expect(buildAssistantTurnMetrics([
      assistant({ messageId: 'turn-1', model: 'claude-opus-4' }),
      assistant({ messageId: 'turn-2' }),
    ])).toEqual({});
  });
});
