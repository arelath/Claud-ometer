'use client';

import { useState } from 'react';
import type { MouseEvent } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function ResumeSessionButton({
  sessionId,
  className,
  showLabel = false,
}: {
  sessionId: string;
  className?: string;
  showLabel?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'launching' | 'launched' | 'error'>('idle');

  const handleResume = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (state === 'launching') return;
    setState('launching');

    try {
      const response = await fetch(`/api/sessions/${sessionId}/resume`, { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Failed to resume session');
      }
      setState('launched');
      window.setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('error');
      window.setTimeout(() => setState('idle'), 2500);
    }
  };

  const tooltip = state === 'launched'
    ? 'Claude resume started'
    : state === 'error'
      ? 'Could not start Claude resume'
      : 'Resume session in Claude';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleResume}
          disabled={state === 'launching'}
          aria-label="Resume session in Claude"
          className={cn(
            'inline-flex items-center justify-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-wait disabled:opacity-70',
            state === 'launched' && 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300',
            state === 'error' && 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
            className,
          )}
        >
          {state === 'launching' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          {showLabel && <span>{state === 'launched' ? 'Launched' : 'Resume'}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
