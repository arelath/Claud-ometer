'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const pillVariants = cva(
  'inline-flex rounded-full border px-1.5 py-0 text-[10px] leading-4',
  {
    variants: {
      tone: {
        neutral: 'border-border/60 bg-muted/40 text-muted-foreground',
        good: 'border-green-200/70 bg-green-50/70 text-green-700 dark:border-green-800/50 dark:bg-green-950/30 dark:text-green-400',
        warn: 'border-amber-200/70 bg-amber-50/70 text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-400',
        danger: 'border-red-200/70 bg-red-50/70 text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-400',
      },
      mono: {
        true: 'font-mono',
        false: '',
      },
    },
    defaultVariants: {
      tone: 'neutral',
      mono: false,
    },
  },
);

export interface SessionPillProps extends VariantProps<typeof pillVariants> {
  value: string;
}

export function SessionPill({ value, tone, mono }: SessionPillProps) {
  return (
    <span className={cn(pillVariants({ tone, mono }))}>
      {value}
    </span>
  );
}
