'use client';

import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const WORKING_MESSAGES = [
  'Thinking through the next step',
  'Checking context',
  'Running the turn',
  'Reviewing tool output',
  'Putting the pieces together',
];

function formatElapsed(startMs: number | undefined, nowMs: number): string {
  if (!startMs || !Number.isFinite(startMs)) return '0s';
  const totalSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

function getWorkingMessage(activeToolName: string | undefined, busySinceAtMs: number | undefined, nowMs: number): string {
  if (activeToolName) return `Running ${activeToolName}`;

  const elapsedMs = busySinceAtMs ? Math.max(0, nowMs - busySinceAtMs) : 0;
  const messageIndex = Math.floor(elapsedMs / 4000) % WORKING_MESSAGES.length;
  return WORKING_MESSAGES[messageIndex];
}

export function LiveWorkingIndicator({
  activeToolName,
  busySinceAtMs,
  className,
  compact = false,
}: {
  activeToolName?: string;
  busySinceAtMs?: number;
  className?: string;
  compact?: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const updateNow = () => setNowMs(Date.now());
    updateNow();
    const interval = window.setInterval(updateNow, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const elapsed = useMemo(() => formatElapsed(busySinceAtMs, nowMs), [busySinceAtMs, nowMs]);
  const message = useMemo(() => getWorkingMessage(activeToolName, busySinceAtMs, nowMs), [activeToolName, busySinceAtMs, nowMs]);

  return (
    <span
      title={`Claude has been working for ${elapsed}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-xs font-medium text-blue-700 dark:text-blue-300',
        compact && 'px-1.5 py-0.5 text-[10px]',
        className,
      )}
    >
      <LoaderCircle className={cn('h-3.5 w-3.5 animate-spin', compact && 'h-3 w-3')} aria-hidden="true" />
      {!compact && <span>{message}</span>}
      <span className="font-mono tabular-nums">{elapsed}</span>
    </span>
  );
}
