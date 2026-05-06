import { describe, expect, it } from 'vitest';
import {
  calculateCost,
  calculateCostAllModes,
  DEFAULT_COST_MODE,
  getModelColor,
  getModelDisplayName,
  getModelPricing,
  getPricingReferenceEntries,
  LITELLM_PRICING_SOURCE,
} from '@/config/pricing';

describe('pricing helpers', () => {
  it('calculates API-equivalent token costs from all token buckets', () => {
    expect(calculateCost('claude-opus-4-7', 1_000_000, 1_000_000, 1_000_000, 1_000_000, 'api')).toBe(36.75);
  });

  it('applies cache discounts for conservative and subscription estimates', () => {
    const costs = calculateCostAllModes('claude-opus-4-7', 1_000_000, 1_000_000, 1_000_000, 1_000_000);

    expect(costs.api).toBe(36.75);
    expect(costs.conservative).toBe(30.9625);
    expect(costs.subscription).toBe(30.505);
    expect(calculateCost('claude-opus-4-7', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBe(costs[DEFAULT_COST_MODE]);
  });

  it('falls back to matching model families for dated or variant model names', () => {
    expect(calculateCost('claude-sonnet-4-6-20260504', 1_000_000, 1_000_000, 0, 0, 'api')).toBe(18);
    expect(calculateCost('internal-haiku-experiment', 1_000_000, 1_000_000, 0, 0, 'api')).toBe(6);
  });

  it('loads rates from the LiteLLM pricing snapshot', () => {
    expect(LITELLM_PRICING_SOURCE.source).toContain('BerriAI/litellm');
    expect(getModelPricing('anthropic.claude-opus-4-7')?.outputPerMillion).toBe(25);
    expect(getModelPricing('claude-opus-4-1')?.outputPerMillion).toBe(75);
  });

  it('keeps separate pricing reference rows for model versions and OpenAI models', () => {
    const rows = getPricingReferenceEntries();
    const models = rows.map(row => row.model);

    expect(models).toContain('claude-opus-4-1');
    expect(models).toContain('claude-opus-4-7');
    expect(models).toContain('gpt-5.5');
    expect(rows.find(row => row.model === 'gpt-5.5')?.pricing.provider).toBe('openai');
  });

  it('returns zero estimates for unknown model families', () => {
    expect(calculateCost('mystery-model', 1_000_000, 1_000_000, 1_000_000, 1_000_000, 'api')).toBe(0);
    expect(calculateCostAllModes('mystery-model', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toEqual({
      api: 0,
      conservative: 0,
      subscription: 0,
    });
  });

  it('normalizes display names and colors by model family', () => {
    expect(getModelDisplayName('claude-opus-4-7')).toBe('Opus');
    expect(getModelDisplayName('synthetic-fixture')).toBe('Synthetic');
    expect(getModelDisplayName('custom-model')).toBe('custom-model');

    expect(getModelColor('claude-opus-4-7')).toBe('#D4764E');
    expect(getModelColor('claude-sonnet-4-6')).toBe('#6B8AE6');
    expect(getModelColor('claude-haiku-4-5')).toBe('#5CB87A');
    expect(getModelColor('synthetic-fixture')).toBe('#7A7A7A');
    expect(getModelColor('custom-model')).toBe('#888888');
  });
});
