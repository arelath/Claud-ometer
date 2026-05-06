'use client';

import { format } from 'date-fns';
import type { SessionMessageDisplay } from '@/lib/claude-data/types';

export function UserMessage({ msg, index }: { msg: SessionMessageDisplay; index: number }) {
  return (
    <div id={`conversation-message-${index}`} className="border-l-2 border-blue-500 pl-3.5 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-blue-500">User</span>
        {msg.timestamp && !Number.isNaN(new Date(msg.timestamp).getTime()) && (
          <span className="text-[11px] text-muted-foreground">{format(new Date(msg.timestamp), 'h:mm a')}</span>
        )}
      </div>
      <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
        {msg.content}
      </div>
    </div>
  );
}
