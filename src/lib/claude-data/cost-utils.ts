import type { CostEstimates } from './types';

export function zeroCosts(): CostEstimates {
  return { api: 0, conservative: 0, subscription: 0 };
}

export function addCosts(a: CostEstimates, b: CostEstimates): CostEstimates {
  return {
    api: a.api + b.api,
    conservative: a.conservative + b.conservative,
    subscription: a.subscription + b.subscription,
  };
}
