import { describe, expect, it } from 'vitest';
import {
  calculateCacheSavings,
  calculateCost,
  calculateCostAllModes,
  DEFAULT_COST_MODE,
  getModelColor,
  getModelCostDisplayName,
  getModelCostGroupKey,
  getModelDisplayName,
  getModelPricing,
  getPricingReferenceEntries,
  LITELLM_PRICING_SOURCE,
  OPENAI_PRICING_SOURCE,
} from '@/config/pricing';

describe('pricing helpers', () => {
  it.each([
    ['gpt-6-astra', 10, 50, 12.5, 1, 2.425, 2.05875, 2.0305],
    ['gpt-6-sol', 2, 10, 2.5, 0.2, 0.485, 0.41175, 0.4061],
    ['gpt-6-luna', 0.1, 0.5, 0.125, 0.01, 0.02425, 0.0205875, 0.020305],
    ['gpt-6.1-sol', 2, 10, 2.5, 0.1, 0.48, 0.4115, 0.40605],
    ['gpt-6.1-terra', 1, 5, 1.25, 0.05, 0.24, 0.20575, 0.203025],
    ['gpt-6.2-astra', 8, 40, 10, 0.4, 1.92, 1.646, 1.6242],
    ['gpt-6.2-sol', 2, 10, 2.5, 0.1, 0.48, 0.4115, 0.40605],
  ] as const)('prices %s using verified OpenAI Standard rates', (model, input, output, write, read, api, conservative, subscription) => {
    expect(getModelPricing(model)).toEqual({
      provider: 'openai',
      inputPerMillion: input,
      outputPerMillion: output,
      cacheWritePerMillion: write,
      cacheReadPerMillion: read,
    });
    const costs = calculateCostAllModes(model, 100_000, 20_000, 30_000, 50_000);
    expect(costs.api).toBeCloseTo(api, 10);
    expect(costs.conservative).toBeCloseTo(conservative, 10);
    expect(costs.subscription).toBeCloseTo(subscription, 10);
    for (const mode of ['api', 'conservative', 'subscription'] as const) {
      expect(calculateCost(model, 100_000, 20_000, 30_000, 50_000, mode)).toBeCloseTo(costs[mode], 10);
    }
    expect(getModelPricing(` ${model.toUpperCase()} `)).toEqual(getModelPricing(model));
    expect(getModelPricing(`${model}-2026-10-01`)).toEqual(getModelPricing(model));
    expect(getModelDisplayName(model)).toBe(model);
    expect(getModelCostGroupKey(model)).toBe(model);
  });

  it('keeps both Sol versions in the pricing reference with separate cache rates', () => {
    expect(OPENAI_PRICING_SOURCE).toEqual({
      source: 'https://developers.openai.com/api/docs/pricing',
      verifiedAt: '2026-11-18',
    });
    const models = getPricingReferenceEntries().map(row => row.model);
    expect(models).toEqual(expect.arrayContaining(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol']));
    expect(models.indexOf('gpt-6.1-sol')).toBeLessThan(models.indexOf('gpt-6-sol'));
    expect(models.indexOf('gpt-6-sol')).toBeLessThan(models.indexOf('gpt-5.5'));
    expect(calculateCacheSavings('gpt-6-sol', 1_000_000, 'api')).toBe(1.8);
    expect(calculateCacheSavings('gpt-6.1-sol', 1_000_000, 'api')).toBe(1.9);
    expect(models.indexOf('gpt-6.2-sol')).toBeLessThan(models.indexOf('gpt-6.1-sol'));
  });

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

  it('keeps cache savings on the selected cost-mode basis', () => {
    expect(calculateCacheSavings('gpt-5.5', 1_000_000, 'api')).toBe(4.5);
    expect(calculateCacheSavings('gpt-5.5', 1_000_000, 'conservative')).toBe(0.225);
    expect(calculateCacheSavings('gpt-5.5', 1_000_000, 'subscription')).toBe(0.045);
    expect(calculateCacheSavings('mystery-model', 1_000_000, 'api')).toBe(0);
  });

  it('falls back to matching model families for dated or variant model names', () => {
    expect(calculateCost('claude-sonnet-4-6-20260504', 1_000_000, 1_000_000, 0, 0, 'api')).toBe(18);
    expect(calculateCost('internal-haiku-experiment', 1_000_000, 1_000_000, 0, 0, 'api')).toBeCloseTo(0.6);
  });

  it('loads rates from the LiteLLM pricing snapshot', () => {
    expect(LITELLM_PRICING_SOURCE.source).toContain('BerriAI/litellm');
    expect(getModelPricing('anthropic.claude-opus-4-7')?.outputPerMillion).toBe(25);
    expect(getModelPricing('claude-opus-4-1')?.outputPerMillion).toBe(75);
    expect(getModelPricing('claude-opus-5.5')?.outputPerMillion).toBe(20);
    expect(getModelPricing('claude-fable-5.2')?.cacheReadPerMillion).toBe(0.2);
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
    expect(getModelDisplayName('gpt-5.5')).toBe('gpt-5.5');
    expect(getModelDisplayName('cursor-auto')).toBe('Cursor (auto)');
    expect(getModelDisplayName('composer-1')).toBe('Composer 1');
    expect(getModelDisplayName('copilot-openai-auto')).toBe('Copilot (OpenAI auto)');
    expect(getModelDisplayName('copilot-anthropic-auto')).toBe('Copilot (Anthropic auto)');

    expect(getModelColor('claude-opus-4-7')).toBe('#D4764E');
    expect(getModelColor('claude-sonnet-4-6')).toBe('#6B8AE6');
    expect(getModelColor('claude-haiku-4-5')).toBe('#5CB87A');
    expect(getModelColor('synthetic-fixture')).toBe('#7A7A7A');
    expect(getModelColor('custom-model')).toBe('#888888');
    expect(getModelColor('gpt-5.5')).toBe('#10A37F');
    expect(getModelColor('cursor-auto')).toBe('#00B4D8');
    expect(getModelColor('composer-1')).toBe('#00A884');
    expect(getModelColor('copilot-openai-auto')).toBe('#10A37F');
    expect(getModelColor('copilot-anthropic-auto')).toBe('#6B8AE6');
  });

  it('groups and labels concrete model versions for cost analytics', () => {
    expect(getModelCostGroupKey('copilot/claude-opus-4.6')).toBe('claude-opus-4-6');
    expect(getModelCostGroupKey('anthropic.claude-opus-4-6-20260205')).toBe('claude-opus-4-6');
    expect(getModelCostGroupKey('claude-3-7-sonnet-20250219')).toBe('claude-3-7-sonnet');

    expect(getModelCostDisplayName('copilot/claude-opus-4.6')).toBe('Opus 4.6');
    expect(getModelCostDisplayName('claude-opus-4-7')).toBe('Opus 4.7');
    expect(getModelCostDisplayName('claude-3-7-sonnet-20250219')).toBe('Sonnet 3.7');
    expect(getModelCostDisplayName('gpt-5.5')).toBe('gpt-5.5');
  });

  it('maps Cursor aliases to concrete pricing models', () => {
    expect(getModelPricing('cursor-auto')).toEqual(getModelPricing('claude-sonnet-4-5'));
    expect(getModelPricing('cursor-agent-auto')).toEqual(getModelPricing('claude-sonnet-4-5'));
    expect(getModelPricing('composer-2')).toEqual(getModelPricing('claude-sonnet-4-6'));
    expect(calculateCost('cursor-auto', 1_000_000, 1_000_000, 0, 0, 'api')).toBeGreaterThan(0);
  });

  it('assigns distinct colors to common OpenAI model families', () => {
    const models = [
      'gpt-6.2-astra',
      'gpt-6.2-sol',
      'gpt-6.1-terra',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.2',
      'gpt-5.1-codex-max',
      'gpt-4o',
      'gpt-4.1-mini',
      'o3',
      'o1-pro',
    ];
    const colors = models.map(getModelColor);

    expect(new Set(colors).size).toBe(models.length);
    expect(getModelColor('gpt-5.5-2026-04-23')).toBe(getModelColor('gpt-5.5'));
    expect(colors).not.toContain('#888888');
    expect(getModelColor('gpt-6.1-sol-2026-10-01')).toBe(getModelColor('gpt-6.1-sol'));
    expect(getModelColor('gpt-5.4-mini-2026-03-17')).toBe(getModelColor('gpt-5.4-mini'));
  });

  it('resolves OpenAI model ids with dots and hyphens without Claude family matching', () => {
    expect(getModelPricing('gpt-5.5')?.provider).toBe('openai');
    expect(calculateCost('gpt-5.5', 1_000_000, 1_000_000, 0, 0, 'api')).toBeGreaterThan(0);
  });
});
