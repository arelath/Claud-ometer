import litellmPricing from './litellm-pricing.generated.json';

export interface ModelPricing {
  provider?: 'anthropic' | 'openai';
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

interface PricingSnapshot {
  source: string;
  updatedAt: string;
  models: Record<string, ModelPricing>;
}

const pricingSnapshot = litellmPricing as PricingSnapshot;

export const LITELLM_PRICING_SOURCE = {
  source: pricingSnapshot.source,
  updatedAt: pricingSnapshot.updatedAt,
};

export const MODEL_PRICING: Record<string, ModelPricing> = pricingSnapshot.models;
const MODEL_PRICING_ENTRIES = Object.entries(MODEL_PRICING);
const PROVIDER_ORDER: Record<string, number> = {
  anthropic: 0,
  openai: 1,
};

/**
 * Cost estimation modes:
 *
 * "api"          — Raw API-equivalent cost. All 4 token types at published API rates.
 *                  Useful for comparing what this usage would cost on the API.
 *                  Typically 5-8x higher than what a Claude Code subscriber actually pays.
 *
 * "conservative" — Discounted estimate. Output tokens at full price, input at full price,
 *                  cache writes at 50% discount, cache reads at 90% discount.
 *                  Reflects that Anthropic likely doesn't charge subscription users
 *                  full API rate for cached context. Lands ~2-3x above real spend.
 *
 * "subscription" — Subscription-friendly estimate. Designed to approximate real Claude Code
 *                  plan billing. Output at full price, input at full price, cache tokens
 *                  heavily discounted (cache writes 80% off, cache reads 95% off).
 *                  For a $100/mo + overage plan, this tracks much closer to reality.
 */
export type CostMode = 'api' | 'conservative' | 'subscription';

export const COST_MODE_LABELS: Record<CostMode, { name: string; description: string }> = {
  api: {
    name: 'API Equivalent',
    description: 'What this usage would cost at published API rates',
  },
  conservative: {
    name: 'Conservative',
    description: 'Discounted cache tokens — upper bound for subscription users',
  },
  subscription: {
    name: 'Subscription',
    description: 'Approximates real Claude Code plan billing',
  },
};

// Multipliers applied to cache token costs relative to their API price
const COST_MODE_MULTIPLIERS: Record<CostMode, { cacheWrite: number; cacheRead: number }> = {
  api:          { cacheWrite: 1.0,  cacheRead: 1.0  },
  conservative: { cacheWrite: 0.15, cacheRead: 0.05 },
  subscription: { cacheWrite: 0.08, cacheRead: 0.01 },
};

export const DEFAULT_COST_MODE: CostMode = 'subscription';

export function getModelDisplayName(modelId: string): string {
  const normalized = modelId.toLowerCase();
  if (normalized.includes('synthetic')) return 'Synthetic';
  if (normalized.includes('opus')) return 'Opus';
  if (normalized.includes('sonnet')) return 'Sonnet';
  if (normalized.includes('haiku')) return 'Haiku';
  return modelId;
}

export function getModelColor(modelId: string): string {
  const normalized = modelId.toLowerCase();
  if (normalized.includes('synthetic')) return '#7A7A7A';
  if (normalized.includes('opus')) return '#D4764E';
  if (normalized.includes('sonnet')) return '#6B8AE6';
  if (normalized.includes('haiku')) return '#5CB87A';
  return '#888888';
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  mode: CostMode = DEFAULT_COST_MODE
): number {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;
  const multipliers = COST_MODE_MULTIPLIERS[mode];
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion * multipliers.cacheWrite +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion * multipliers.cacheRead
  );
}

/** Calculate cost in all three modes at once (avoids triple-parsing in hot paths) */
export function calculateCostAllModes(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number
): Record<CostMode, number> {
  const pricing = getModelPricing(model);
  if (!pricing) return { api: 0, conservative: 0, subscription: 0 };

  const baseCost =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;

  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;

  return {
    api: baseCost + cacheWriteCost + cacheReadCost,
    conservative: baseCost + cacheWriteCost * 0.15 + cacheReadCost * 0.05,
    subscription: baseCost + cacheWriteCost * 0.08 + cacheReadCost * 0.01,
  };
}

export function getModelPricing(model: string): ModelPricing | null {
  return getModelPricingEntry(model)?.pricing ?? null;
}

export function getModelPricingEntry(model: string): { model: string; pricing: ModelPricing } | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;

  const direct = MODEL_PRICING[normalized];
  if (direct) return { model: normalized, pricing: direct };

  const prefixMatch = pickBestPricingEntry(
    MODEL_PRICING_ENTRIES.filter(([key]) => normalized.startsWith(`${key}-`) || key.startsWith(`${normalized}-`))
  );
  if (prefixMatch) return { model: prefixMatch[0], pricing: prefixMatch[1] };

  const family = getClaudeFamily(normalized);
  if (!family) return null;

  const familyMatch = pickBestPricingEntry(
    MODEL_PRICING_ENTRIES.filter(([key]) => getClaudeFamily(key) === family)
  );
  return familyMatch ? { model: familyMatch[0], pricing: familyMatch[1] } : null;
}

export function getPricingReferenceEntries(modelIds?: string[]): Array<{ model: string; pricing: ModelPricing }> {
  const seen = new Set<string>();
  const entries: Array<{ model: string; pricing: ModelPricing }> = [];

  const sourceModels = modelIds?.length ? modelIds : MODEL_PRICING_ENTRIES.map(([model]) => model);
  for (const model of sourceModels) {
    const entry = modelIds?.length
      ? getModelPricingEntry(model)
      : MODEL_PRICING[model]
        ? { model, pricing: MODEL_PRICING[model] }
        : null;
    if (!entry || seen.has(entry.model)) continue;
    seen.add(entry.model);
    entries.push(entry);
  }

  return entries.sort(comparePricingReferenceEntries);
}

function normalizeModelId(model: string): string {
  const normalized = model.trim().toLowerCase();
  const claudeIndex = normalized.lastIndexOf('claude-');
  const claudeModel = claudeIndex >= 0 ? normalized.slice(claudeIndex) : normalized;
  return claudeModel.replace(/\./g, '-');
}

function getClaudeFamily(model: string): 'opus' | 'sonnet' | 'haiku' | null {
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return null;
}

function pickBestPricingEntry(entries: Array<[string, ModelPricing]>): [string, ModelPricing] | null {
  if (entries.length === 0) return null;
  return [...entries].sort(([a], [b]) => comparePricingKeys(a, b))[0];
}

function comparePricingKeys(a: string, b: string): number {
  const aScore = getPricingKeyScore(a);
  const bScore = getPricingKeyScore(b);
  return (
    bScore.major - aScore.major ||
    bScore.minor - aScore.minor ||
    bScore.date - aScore.date ||
    b.length - a.length ||
    a.localeCompare(b)
  );
}

function comparePricingReferenceEntries(
  a: { model: string; pricing: ModelPricing },
  b: { model: string; pricing: ModelPricing }
): number {
  const providerA = a.pricing.provider ?? '';
  const providerB = b.pricing.provider ?? '';
  return (
    (PROVIDER_ORDER[providerA] ?? 99) - (PROVIDER_ORDER[providerB] ?? 99) ||
    comparePricingKeys(a.model, b.model)
  );
}

function getPricingKeyScore(model: string): { major: number; minor: number; date: number } {
  const parts = normalizeModelId(model).split('-');
  const family = getClaudeFamily(model);
  const familyIndex = family ? parts.indexOf(family) : -1;
  let major = 0;
  let minor = 0;

  if (familyIndex === 1) {
    major = parseVersionPart(parts[2]);
    minor = parseVersionPart(parts[3]);
  } else if (familyIndex > 1) {
    major = parseVersionPart(parts[1]);
    minor = familyIndex === 3 ? parseVersionPart(parts[2]) : 0;
  }

  const date = Math.max(
    0,
    ...parts
      .filter((part) => /^\d{8}$/.test(part))
      .map((part) => Number(part))
  );

  return { major, minor, date };
}

function parseVersionPart(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || /^\d{8}$/.test(value)) return 0;
  return Number(value);
}
