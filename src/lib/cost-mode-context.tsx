'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { DEFAULT_COST_MODE, COST_MODE_LABELS } from '@/config/pricing';
import type { CostMode } from '@/config/pricing';
import type { CostEstimates } from '@/lib/claude-data/types';

interface CostModeContextValue {
  costMode: CostMode;
  setCostMode: (mode: CostMode) => void;
  /** Pick the right cost from a CostEstimates object, with fallback to legacy estimatedCost */
  pickCost: (estimates: CostEstimates | undefined, legacyFallback?: number) => number;
  label: { name: string; description: string };
}

const CostModeContext = createContext<CostModeContextValue | null>(null);

const STORAGE_KEY = 'agentscope-cost-mode';
const fallbackCostModeContext: CostModeContextValue = {
  costMode: DEFAULT_COST_MODE,
  setCostMode: () => undefined,
  pickCost: (estimates, legacyFallback = 0) => estimates?.[DEFAULT_COST_MODE] ?? legacyFallback,
  label: COST_MODE_LABELS[DEFAULT_COST_MODE],
};

function getInitialMode(): CostMode {
  if (typeof window === 'undefined') return DEFAULT_COST_MODE;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in COST_MODE_LABELS) return stored as CostMode;
  return DEFAULT_COST_MODE;
}

export function CostModeProvider({ children }: { children: ReactNode }) {
  const [costMode, setCostModeState] = useState<CostMode>(getInitialMode);

  const setCostMode = useCallback((mode: CostMode) => {
    setCostModeState(mode);
    localStorage.setItem(STORAGE_KEY, mode);
  }, []);

  const pickCost = useCallback((estimates: CostEstimates | undefined, legacyFallback = 0) => {
    if (!estimates) return legacyFallback;
    return estimates[costMode] ?? legacyFallback;
  }, [costMode]);

  const label = COST_MODE_LABELS[costMode];

  return (
    <CostModeContext.Provider value={{ costMode, setCostMode, pickCost, label }}>
      {children}
    </CostModeContext.Provider>
  );
}

export function useCostMode() {
  const ctx = useContext(CostModeContext);
  return ctx || fallbackCostModeContext;
}
