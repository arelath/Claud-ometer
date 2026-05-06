'use client';

import { type ReactNode } from 'react';
import { ThemeProvider } from 'next-themes';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CostModeProvider } from '@/lib/cost-mode-context';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      storageKey="claud-ometer-theme"
      disableTransitionOnChange
    >
      <CostModeProvider>
        <TooltipProvider>
          {children}
        </TooltipProvider>
      </CostModeProvider>
    </ThemeProvider>
  );
}
