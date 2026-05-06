'use client';

import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Loader2, SendHorizontal } from 'lucide-react';
import { useSWRConfig } from 'swr';
import type { LiveSessionStatus } from '@/lib/claude-data/types';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type SendState = 'idle' | 'sending' | 'sent' | 'error';

function getBlockedReason(status?: LiveSessionStatus): string | null {
  if (status === 'busy') return 'Claude is busy';
  return null;
}

export function LiveSessionSendBox({
  sessionId,
  liveStatus,
}: {
  sessionId: string;
  liveStatus?: LiveSessionStatus;
}) {
  const [text, setText] = useState('');
  const [state, setState] = useState<SendState>('idle');
  const [error, setError] = useState('');
  const { mutate } = useSWRConfig();
  const trimmedText = text.trim();
  const blockedReason = getBlockedReason(liveStatus);
  const disabled = state === 'sending' || Boolean(blockedReason) || !trimmedText;

  const send = async () => {
    if (disabled) return;

    setState('sending');
    setError('');
    try {
      const response = await fetch(`/api/live-sessions/${encodeURIComponent(sessionId)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: trimmedText }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Could not send message');
      }

      setText('');
      setState('sent');
      void mutate(`/api/sessions/${sessionId}`);
      void mutate('/api/live-sessions');
      window.setTimeout(() => setState('idle'), 1500);
    } catch (sendError) {
      setState('error');
      setError(sendError instanceof Error ? sendError.message : 'Could not send message');
      window.setTimeout(() => setState('idle'), 2500);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const tooltip = blockedReason
    || (state === 'sent' ? 'Sent to Claude' : state === 'error' ? error || 'Could not send message' : 'Send to Claude');

  return (
    <form
      onSubmit={handleSubmit}
      className="sticky bottom-0 z-30 rounded-t-lg border border-border/60 bg-background/95 p-2 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur"
    >
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={Boolean(blockedReason)}
          placeholder={blockedReason || 'Message this live session'}
          className="max-h-36 min-h-10 flex-1 resize-y rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-70"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="submit"
              disabled={disabled}
              aria-label="Send message to live session"
              className={cn(
                'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground',
                state === 'sent' && 'border-green-500/40 bg-green-600 hover:bg-green-600',
                state === 'error' && 'border-red-500/40 bg-red-600 hover:bg-red-600',
              )}
            >
              {state === 'sending'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <SendHorizontal className="h-4 w-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </div>
      {error && state === 'error' && (
        <p className="mt-1.5 text-xs text-red-600 dark:text-red-300">{error}</p>
      )}
    </form>
  );
}
