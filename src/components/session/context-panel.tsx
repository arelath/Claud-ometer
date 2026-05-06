'use client';

import { useMemo, useState } from 'react';
import { Check, Copy, Paperclip } from 'lucide-react';
import {
  formatContextRanges,
  getContextFilePathsText,
  getContextLoadedLineCount,
  getContextRangeLineCount,
  mergeContextLineRanges,
  parseContextLineCount,
  type ContextFileGroups,
  type ContextFileInfo,
} from '@/lib/context-files';
import type { SessionMessageDisplay } from '@/lib/claude-data/types';
import { formatTokens } from '@/lib/format';
import { formatDisplayPath, splitDisplayPath } from '@/lib/path-utils';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSessionRenderContext } from './session-render-context';

type TokenMeterMode = 'usage' | 'window';

export interface SessionTokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

interface MeterSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

interface MeterSnapshot {
  total: number;
  totalLabel: string;
  segments: MeterSegment[];
}

function getMeterPercents(values: number[]): number[] {
  const linearTotal = values.reduce((sum, value) => sum + value, 0);
  if (linearTotal === 0) return values.map(() => 0);

  const linearShares = values.map(value => value / linearTotal);
  const emphasizedValues = values.map(value => (value > 0 ? Math.pow(value, 0.78) : 0));
  const emphasizedTotal = emphasizedValues.reduce((sum, value) => sum + value, 0);
  const emphasizedShares = emphasizedTotal > 0
    ? emphasizedValues.map(value => value / emphasizedTotal)
    : values.map(() => 0);

  return values.map((_, index) => ((linearShares[index] * 0.65) + (emphasizedShares[index] * 0.35)) * 100);
}

function buildUsageMeterSnapshot(session: SessionTokenSummary): MeterSnapshot {
  return {
    total: session.totalInputTokens + session.totalOutputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens,
    totalLabel: 'session total',
    segments: [
      { key: 'input', label: 'Input', value: session.totalInputTokens, color: '#378ADD' },
      { key: 'cache-read', label: 'Cache read', value: session.totalCacheReadTokens, color: '#BA7517' },
      { key: 'output', label: 'Output', value: session.totalOutputTokens, color: '#5DCAA5' },
      { key: 'cache-write', label: 'Cache write', value: session.totalCacheWriteTokens, color: '#8B5CF6' },
    ].filter(segment => segment.value > 0),
  };
}

function buildWindowMeterSnapshot(messages: SessionMessageDisplay[]): MeterSnapshot | null {
  const currentBreakdown = [...messages]
    .reverse()
    .find(message => message.role === 'assistant' && message.promptBreakdown)?.promptBreakdown;
  if (!currentBreakdown) return null;

  return {
    total: currentBreakdown.totalTokens,
    totalLabel: 'current prompt',
    segments: [
      { key: 'system', label: 'System', value: currentBreakdown.systemTokens, color: '#888780' },
      { key: 'files', label: 'Files', value: currentBreakdown.filesTokens, color: '#BA7517' },
      { key: 'conversation', label: 'Conversation', value: currentBreakdown.conversationTokens, color: '#378ADD' },
      { key: 'thinking', label: 'Thinking', value: currentBreakdown.thinkingTokens, color: '#D97706' },
      { key: 'tools', label: 'Tools', value: currentBreakdown.toolTokens, color: '#0F766E' },
      { key: 'other', label: 'Other', value: currentBreakdown.otherTokens, color: '#5DCAA5' },
    ].filter(segment => segment.value > 0),
  };
}

export function ContextWindowMeter({ session, messages }: { session: SessionTokenSummary; messages: SessionMessageDisplay[] }) {
  const [mode, setMode] = useState<TokenMeterMode>('usage');
  const usageSnapshot = useMemo(() => buildUsageMeterSnapshot(session), [session]);
  const windowSnapshot = useMemo(() => buildWindowMeterSnapshot(messages), [messages]);
  const snapshot = mode === 'window' && windowSnapshot ? windowSnapshot : usageSnapshot;
  if (snapshot.total === 0) return null;

  const percents = getMeterPercents(snapshot.segments.map(segment => segment.value));

  return (
    <Card className="border-border/50 shadow-sm py-0 gap-0">
      <CardContent className="p-3">
        <div className="mb-2.5 flex items-start justify-between gap-2">
          <div>
            <div className="text-xs font-medium text-foreground">Token usage</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {mode === 'window' ? 'Prompt composition before the latest assistant response' : 'Actual session token totals'}
            </div>
          </div>
          <div className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/20 p-0.5">
            <button
              type="button"
              onClick={() => setMode('usage')}
              className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                mode === 'usage' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Usage
            </button>
            <button
              type="button"
              onClick={() => setMode('window')}
              className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                mode === 'window' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Window
            </button>
          </div>
        </div>
        <div className="mb-2.5 flex items-baseline justify-between">
          <span className="text-[11px] text-muted-foreground">{snapshot.totalLabel}</span>
          <span className="text-[11px] font-mono text-muted-foreground">{formatTokens(snapshot.total)} total</span>
        </div>
        <div className="mb-2.5 flex h-2 overflow-hidden rounded bg-muted/50">
          {snapshot.segments.map((segment, index) => (
            <div
              key={segment.key}
              style={{ width: `${percents[index]}%`, backgroundColor: segment.color }}
              title={`${segment.label}: ${formatTokens(segment.value)}`}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          {snapshot.segments.map(segment => (
            <div key={segment.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: segment.color }} />
              <span className="truncate text-muted-foreground">{segment.label}</span>
              <span className="ml-auto font-mono text-muted-foreground">{formatTokens(segment.value)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ContextFileRow({ file, onJumpToMessage, copiedPath, onCopyPath, hasDiff, onOpenDiff }: {
  file: ContextFileInfo;
  onJumpToMessage: (messageIndexes: number[]) => void;
  copiedPath: string | null;
  onCopyPath: (filePath: string) => void;
  hasDiff?: boolean;
  onOpenDiff?: (filePath: string) => boolean;
}) {
  const { projectRoot } = useSessionRenderContext();
  const totalCount = parseContextLineCount(file.totalLines);
  const rangeSegments = totalCount != null && totalCount > 0
    ? mergeContextLineRanges(file.loadedRanges, totalCount)
    : [];
  const rangeLoadedCount = getContextRangeLineCount(rangeSegments, totalCount ?? undefined);
  const loadedCount = rangeLoadedCount ?? parseContextLineCount(file.loadedLines);
  const isCopied = copiedPath === file.fullPath;
  const displayPath = formatDisplayPath(file.fullPath, projectRoot);
  const displayPathParts = splitDisplayPath(displayPath);

  let fillPct = 100;
  let isPartial = false;
  if (loadedCount != null && totalCount != null && totalCount > 0) {
    fillPct = Math.min(100, Math.round((loadedCount / totalCount) * 100));
    isPartial = fillPct < 100;
  }

  const lineSummary = (() => {
    if (loadedCount != null && totalCount != null && loadedCount !== totalCount) {
      return `${loadedCount} / ${totalCount} ln`;
    }
    if (totalCount != null) return `${totalCount} / ${totalCount} ln`;
    if (loadedCount != null) return `${loadedCount} ln`;
    return null;
  })();

  const barColor = isPartial ? 'bg-amber-500' : 'bg-green-500';
  const lineColor = isPartial ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400';
  const rangeLabel = formatContextRanges(rangeSegments);
  const barTitle = rangeLabel
    ? `${rangeLabel} loaded`
    : lineSummary || undefined;
  const handlePrimaryClick = () => {
    if (hasDiff && onOpenDiff?.(file.fullPath)) return;
    onJumpToMessage(file.messageIndexes);
  };

  return (
    <div className="group py-1.5 border-b border-border/30 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handlePrimaryClick}
              className="flex min-w-0 max-w-full flex-1 items-baseline font-mono text-[11px] text-foreground hover:underline text-left"
            >
              {displayPathParts.prefix && (
                <span className="min-w-0 truncate text-muted-foreground">{displayPathParts.prefix}</span>
              )}
              <span className="shrink-0">{displayPathParts.basename}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-[300px]">
            <span className="font-mono text-[10px] break-all">{displayPath}</span>
            {hasDiff && <span className="mt-1 block text-[10px] text-muted-foreground">Open file diff</span>}
          </TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-1.5 shrink-0">
          {file.attached && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Paperclip className="h-2.5 w-2.5 text-amber-500" />
              </TooltipTrigger>
              <TooltipContent>Attached to prompt by user</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onCopyPath(file.fullPath)}
                className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground transition-opacity"
              >
                {isCopied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{isCopied ? 'Copied full path' : 'Copy full path'}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {lineSummary && (
        <div className="flex items-center gap-2">
          <div
            className="relative h-1 flex-1 overflow-hidden rounded bg-muted/50"
            title={barTitle}
            data-testid="context-file-range-bar"
          >
            {rangeSegments.length > 0 && totalCount != null && totalCount > 0 ? (
              rangeSegments.map(range => (
                <div
                  key={`${range.start}-${range.end}`}
                  className={`absolute inset-y-0 rounded-sm ${barColor}`}
                  data-testid="context-file-range-segment"
                  data-range-start={range.start}
                  data-range-end={range.end}
                  style={{
                    left: `${((range.start - 1) / totalCount) * 100}%`,
                    width: `${((range.end - range.start + 1) / totalCount) * 100}%`,
                    minWidth: '2px',
                  }}
                />
              ))
            ) : (
              <div className={`h-full ${barColor} rounded`} style={{ width: `${fillPct}%` }} />
            )}
          </div>
          <span className={`w-[86px] shrink-0 text-right font-mono tabular-nums text-[10px] whitespace-nowrap ${lineColor}`}>{lineSummary}</span>
        </div>
      )}
    </div>
  );
}

export function ContextFilesPanel({ contextFiles, copiedPath, onCopyPath, onJumpToMessage, hasDiffForPath, onOpenDiff }: {
  contextFiles: ContextFileGroups;
  copiedPath: string | null;
  onCopyPath: (filePath: string) => void;
  onJumpToMessage: (messageIndexes: number[]) => void;
  hasDiffForPath?: (filePath: string) => boolean;
  onOpenDiff?: (filePath: string) => boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const allFiles = [...contextFiles.inContext, ...contextFiles.referenced];
  const totalCount = allFiles.length;

  if (totalCount === 0) return null;

  const initialShow = 6;
  const visibleFiles = showAll ? allFiles : allFiles.slice(0, initialShow);
  const remaining = totalCount - initialShow;
  const allPathsText = getContextFilePathsText(allFiles);
  const isAllCopied = copiedPath === allPathsText;

  return (
    <Card className="border-border/50 shadow-sm py-0 gap-0">
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-foreground">
            Files in context <span className="text-muted-foreground font-normal">- {totalCount}</span>
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onCopyPath(allPathsText)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
              >
                {isAllCopied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
                Copy all
              </button>
            </TooltipTrigger>
            <TooltipContent>{isAllCopied ? 'Copied all paths' : 'Copy all file paths'}</TooltipContent>
          </Tooltip>
        </div>
        <div className="max-h-[320px] overflow-y-auto pr-1">
          {visibleFiles.map(file => (
            <ContextFileRow
              key={file.fullPath}
              file={file}
              onJumpToMessage={onJumpToMessage}
              copiedPath={copiedPath}
              onCopyPath={onCopyPath}
              hasDiff={hasDiffForPath?.(file.fullPath)}
              onOpenDiff={onOpenDiff}
            />
          ))}
        </div>
        {!showAll && remaining > 0 && (
          <button
            onClick={() => setShowAll(true)}
            className="w-full mt-2 py-1.5 border border-border/50 rounded text-[11px] text-muted-foreground hover:bg-muted/30 transition-colors"
          >
            Show {remaining} more
            {(() => {
              const hiddenFiles = allFiles.slice(initialShow);
              const hiddenLines = hiddenFiles.reduce((sum, file) => {
                const loaded = getContextLoadedLineCount(file);
                return sum + (loaded ?? 0);
              }, 0);
              if (hiddenLines > 0) {
                const tokenEstimate = hiddenLines * 4;
                return ` - ~${formatTokens(tokenEstimate)} tok`;
              }
              return '';
            })()}
          </button>
        )}
      </CardContent>
    </Card>
  );
}
