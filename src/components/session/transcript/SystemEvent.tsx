'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Brain, ChevronDown, Info, Terminal } from 'lucide-react';
import type { SessionMessageBlockDisplay, SessionMessageDisplay } from '@/lib/claude-data/types';
import { formatDisplayPath } from '@/lib/path-utils';
import { normalizeDisplayNewlines } from '@/lib/string-utils';
import { ANTHROPIC_FILE_DETAIL_KEYS } from '@/config/anthropic-schema';
import { Badge } from '@/components/ui/badge';
import {
  findDetail,
  omitDetails,
} from '../detail-utils';
import { SessionPill } from '../session-pill';
import { useSessionRenderContext } from '../session-render-context';
import { DetailPanel, type PillTone } from './ToolCall';

export function BlockCard({ block }: { block: SessionMessageBlockDisplay }) {
  const { projectRoot } = useSessionRenderContext();
  const shownKeys: string[] = [];
  const pills: { value: string; mono?: boolean; tone?: PillTone }[] = [];

  const command = findDetail(block.details, ['command']);
  const filePath = findDetail(block.details, [...ANTHROPIC_FILE_DETAIL_KEYS]);
  const query = findDetail(block.details, ['query']);
  const exitCode = findDetail(block.details, ['exitCode']);
  const duration = findDetail(block.details, ['durationMs']);

  let primary = block.summary;

  if (block.type === 'thinking') {
    shownKeys.push('thinking', 'signature');
    const remainingDetails = omitDetails(block.details, shownKeys);
    return (
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-0.5">
        <Badge variant="outline" className="shrink-0 text-[10px] px-1 py-0 leading-4">Think</Badge>
        <span className="text-[11px] text-muted-foreground truncate max-w-[60%]">{block.summary}</span>
        <DetailPanel details={remainingDetails} content={block.content} shownKeys={shownKeys} summaryLabel="reasoning" />
      </div>
    );
  }

  if (command) {
    primary = command.value;
    shownKeys.push('command');
    if (exitCode) {
      pills.push({ value: `exit ${exitCode.value}`, tone: exitCode.value === '0' ? 'good' : 'danger', mono: true });
      shownKeys.push('exitCode');
    }
    if (duration) { pills.push({ value: duration.value, mono: true }); shownKeys.push('durationMs'); }
  } else if (filePath) {
    primary = filePath.value;
    shownKeys.push(...ANTHROPIC_FILE_DETAIL_KEYS);
  } else if (query) {
    primary = query.value;
    shownKeys.push('query');
  }

  const remainingDetails = omitDetails(block.details, shownKeys);
  const isMono = Boolean(command || filePath || query);
  const displayPrimary = filePath
    ? formatDisplayPath(primary, projectRoot)
    : normalizeDisplayNewlines(primary);

  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-0.5">
      <Badge variant="outline" className="shrink-0 text-[10px] px-1 py-0 leading-4">{block.title}</Badge>
      <span className={`min-w-0 truncate text-[11px] max-w-[50%] ${isMono ? 'font-mono' : ''} text-foreground/80`}>
        {displayPrimary}
      </span>
      {pills.map((pill, index) => <SessionPill key={index} {...pill} />)}
      <DetailPanel details={remainingDetails} content={block.content} shownKeys={shownKeys} />
    </div>
  );
}

export function SystemGroup({ messages }: { messages: { message: SessionMessageDisplay; index: number }[] }) {
  const [expanded, setExpanded] = useState(false);
  const firstIndex = messages[0]?.index;
  const timeRange = (() => {
    const timestamps = messages
      .map(message => message.message.timestamp)
      .filter(timestamp => timestamp && !Number.isNaN(new Date(timestamp).getTime()));
    if (timestamps.length === 0) return '';
    const first = format(new Date(timestamps[0]), 'h:mm:ss');
    const last = timestamps.length > 1 ? format(new Date(timestamps[timestamps.length - 1]), 'h:mm:ss') : '';
    return last && last !== first ? `${first}-${last}` : first;
  })();

  const labels = messages.slice(0, 3).map(message => {
    if (message.message.role === 'command') return message.message.content.slice(0, 20);
    const blocks = message.message.blocks || [];
    if (blocks.length > 0) return blocks[0].title;
    return message.message.isMeta ? 'meta' : 'system';
  });

  if (!expanded) {
    return (
      <button
        id={firstIndex === undefined ? undefined : `conversation-message-${firstIndex}`}
        onClick={() => setExpanded(true)}
        className="flex items-center gap-2 w-full px-3 py-1.5 bg-muted/30 border border-dashed border-border/50 rounded text-[11px] text-muted-foreground hover:bg-muted/50 transition-colors"
      >
        <span>{messages.length} system event{messages.length === 1 ? '' : 's'}</span>
        <span className="opacity-60 truncate">- {labels.join(', ')}{timeRange ? ` - ${timeRange}` : ''}</span>
        <ChevronDown className="h-3 w-3 ml-auto shrink-0" />
      </button>
    );
  }

  return (
    <div id={firstIndex === undefined ? undefined : `conversation-message-${firstIndex}`} className="border border-dashed border-border/50 rounded bg-muted/20 px-3 py-2 space-y-1">
      <button
        onClick={() => setExpanded(false)}
        className="flex items-center gap-2 w-full text-[10px] text-muted-foreground hover:text-foreground mb-1"
      >
        <span>Collapse {messages.length} system events</span>
        <ChevronDown className="h-3 w-3 ml-auto shrink-0 rotate-180 transition-transform" />
      </button>
      {messages.map(({ message, index }) => (
        <div key={index} id={index === firstIndex ? undefined : `conversation-message-${index}`} className="flex items-start gap-2 text-[11px] text-muted-foreground">
          {message.role === 'command' ? (
            <Terminal className="h-2.5 w-2.5 text-blue-500/70" />
          ) : (
            <Info className="h-2.5 w-2.5 text-amber-600/70" />
          )}
          {message.role === 'command' ? (
            <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">{normalizeDisplayNewlines(message.content)}</pre>
          ) : (
            <span className="min-w-0 break-words">{message.content}</span>
          )}
          {message.timestamp && !Number.isNaN(new Date(message.timestamp).getTime()) && (
            <span className="ml-auto shrink-0 text-[9px]">{format(new Date(message.timestamp), 'h:mm:ss a')}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function CompactionDivider({ timestamp, targetId }: { timestamp: string; targetId: string }) {
  const timeLabel = !Number.isNaN(new Date(timestamp).getTime())
    ? format(new Date(timestamp), 'h:mm:ss a')
    : null;

  return (
    <div id={targetId} data-testid="conversation-compaction-marker" className="flex items-center gap-3 py-2.5">
      <div data-testid="conversation-compaction-line" className="h-px flex-1 bg-amber-500/50" />
      <div className="shrink-0 rounded-full border border-amber-300/70 bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-800 shadow-sm dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300">
        Context Window Compaction{timeLabel ? <span className="ml-1.5 font-mono font-normal opacity-70">{timeLabel}</span> : null}
      </div>
      <div data-testid="conversation-compaction-line" className="h-px flex-1 bg-amber-500/50" />
    </div>
  );
}

export function ThinkingSummary({ block }: { block: SessionMessageBlockDisplay }) {
  return (
    <div className="flex items-center gap-1.5 py-0.5 mt-1 text-[11px] text-muted-foreground">
      <Brain className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{block.summary}</span>
      {block.content && (
        <details className="inline">
          <summary className="cursor-pointer text-[10px]">...</summary>
          <pre className="mt-1 rounded bg-muted/20 p-1.5 text-[10px] whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {block.content}
          </pre>
        </details>
      )}
    </div>
  );
}
