'use client';

import { type ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CostModeProvider } from '@/lib/cost-mode-context';
import { ThemeProvider } from '@/lib/theme-context';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <CostModeProvider>
        <TooltipProvider>
          {children}
        </TooltipProvider>
      </CostModeProvider>
    </ThemeProvider>
  );
}
