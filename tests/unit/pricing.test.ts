import { describe, expect, it } from 'vitest';
import {
  calculateCost,
  calculateCostAllModes,
  DEFAULT_COST_MODE,
  getModelColor,
  getModelDisplayName,
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
