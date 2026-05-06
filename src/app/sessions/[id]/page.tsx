'use client';

import { createContext, use, useState, useCallback, useMemo, useRef, useEffect, useContext } from 'react';
import { useSessionDetail } from '@/lib/hooks';
import {
  formatContextRanges,
  getContextFileGroups,
  getContextFilePathsText,
  getContextLoadedLineCount,
  getContextRangeLineCount,
  mergeContextLineRanges,
  parseContextLineCount,
  type ContextFileGroups,
  type ContextFileInfo,
} from '@/lib/context-files';
import {
  buildTranscriptItems,
  getMinimapTargets,
  getToolResultId,
  messagePassesPreset,
  type AssistantTimelineItem,
  type FilterPreset,
  type ToolPair,
} from '@/lib/session-transcript';
import {
  getFilePatchText,
  getSessionDiffSummary,
  getSessionPatchText,
  type SessionDiffFile,
  type SessionDiffHunk,
  type SessionDiffRow,
  type SessionDiffSummary,
} from '@/lib/session-diff';
import { useCostMode } from '@/lib/cost-mode-context';
import { getModelDisplayName } from '@/config/pricing';
import { getCodeLanguageLabel, guessCodeLanguage, tokenizeCode, type CodeLanguage, type HighlightToken } from '@/lib/code-highlighting';
import { formatCost, formatDuration, formatTokens } from '@/lib/format';
import type { SessionMessageBlockDisplay, SessionMessageDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ArrowLeft, Clock, GitBranch, MessageSquare, Wrench,
  Bot, Coins, Activity, Minimize2, Brain, FileText, Info,
  Terminal, Copy, Check, Paperclip, ChevronDown,
  AlertCircle, ExternalLink, X,
} from 'lucide-react';
import Link from 'next/link';
import { format } from 'date-fns';

const FILTER_STORAGE_KEY = 'claud-ometer-session-filter-preset';

function loadPreset(): FilterPreset {
  if (typeof window === 'undefined') return 'narrative';
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (raw === 'narrative' || raw === 'tools' || raw === 'all') return raw;
    return 'narrative';
  } catch {
    return 'narrative';
  }
}

function savePreset(preset: FilterPreset): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(FILTER_STORAGE_KEY, preset);
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function getDetailKeyTail(key: string): string {
  const parts = key.split('.');
  return parts[parts.length - 1] || key;
}

function usesMonospaceDetail(key: string): boolean {
  const keyTail = getDetailKeyTail(key);
  return [
    'args', 'command', 'displayPath', 'file_path', 'filePath', 'filename',
    'includePattern', 'leafUuid', 'lineContent', 'messageId', 'path', 'paths',
    'query', 'scope', 'selector', 'signature', 'sourceToolAssistantUUID',
    'symbol', 'tool_use_id', 'toolUseId', 'url', 'uuid',
  ].includes(keyTail);
}

function detailMatchesKey(key: string, candidates: string[]): boolean {
  const keyTail = getDetailKeyTail(key);
  return candidates.includes(key) || candidates.includes(keyTail);
}

function findDetail(
  details: SessionToolCallDisplay['details'],
  candidates: string[],
): SessionToolCallDisplay['details'][number] | undefined {
  return details.find(detail => detailMatchesKey(detail.key, candidates));
}

function findPreferredDetail(
  details: SessionToolCallDisplay['details'],
  candidates: string[],
): SessionToolCallDisplay['details'][number] | undefined {
  for (const candidate of candidates) {
    const match = details.find(detail => detailMatchesKey(detail.key, [candidate]));
    if (match) return match;
  }
  return undefined;
}

function omitDetails(
  details: SessionToolCallDisplay['details'],
  candidates: string[],
): SessionToolCallDisplay['details'] {
  return details.filter(detail => !detailMatchesKey(detail.key, candidates));
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

type TokenMeterMode = 'usage' | 'window';

interface SessionTokenSummary {
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

interface MinimapSegment {
  type: 'user' | 'assistant' | 'system-group' | 'compaction';
  targetId: string;
  topPct: number;
  heightPct: number;
}

interface MinimapViewport {
  topPct: number;
  heightPct: number;
}

function findSegmentForRatio(segments: MinimapSegment[], ratio: number): MinimapSegment | undefined {
  if (segments.length === 0) return undefined;
  const targetPct = ratio * 100;
  return segments.find(segment => targetPct >= segment.topPct && targetPct <= segment.topPct + segment.heightPct)
    || segments.reduce((closest, segment) => {
      const closestCenter = closest.topPct + (closest.heightPct / 2);
      const segmentCenter = segment.topPct + (segment.heightPct / 2);
      return Math.abs(segmentCenter - targetPct) < Math.abs(closestCenter - targetPct) ? segment : closest;
    }, segments[0]);
}

function Minimap({ segments, viewport, onJump }: {
  segments: MinimapSegment[];
  viewport: MinimapViewport;
  onJump: (targetId: string) => void;
}) {
  const totalItems = segments.length;
  if (totalItems === 0) return null;

  const barHeight = 560;

  return (
    <div className="sticky top-2 self-start flex flex-col items-center gap-2 w-14 shrink-0">
      <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Timeline</span>
      {/* Legend pinned to the top, near the bar it explains */}
      <div className="flex flex-col gap-1 text-[9px] text-muted-foreground items-start">
        <div className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[rgb(56,138,221)]" />You</div>
        <div className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[rgb(186,117,23)]" />Claude</div>
        <div className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[rgb(107,114,128)]" />System</div>
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Session timeline"
        data-testid="session-minimap"
        className="relative w-3.5 rounded bg-muted/50 border border-border/40 cursor-pointer transition-colors hover:border-primary/60 hover:bg-muted"
        style={{ height: barHeight }}
        onClick={(event) => {
          const clickedSegment = (event.target as HTMLElement).closest<HTMLElement>('[data-target-id]');
          if (clickedSegment && event.currentTarget.contains(clickedSegment)) {
            const targetId = clickedSegment.dataset.targetId;
            if (targetId) {
              onJump(targetId);
              return;
            }
          }

          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientY - rect.top) / rect.height;
          const segment = findSegmentForRatio(segments, ratio);
          if (segment) onJump(segment.targetId);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Home') {
            event.preventDefault();
            onJump(segments[0].targetId);
          }
          if (event.key === 'End') {
            event.preventDefault();
            onJump(segments[segments.length - 1].targetId);
          }
        }}
      >
        {segments.map((segment, i) => {
          const isCompaction = segment.type === 'compaction';
          const height = isCompaction ? 0.7 : Math.max(segment.heightPct, 0.8);
          let color: string;
          let opacity = 0.7;

          if (isCompaction) {
            color = 'rgb(217, 119, 6)';
            opacity = 1;
          } else if (segment.type === 'user') {
            color = 'rgb(56, 138, 221)';
            opacity = 0.95;
          } else if (segment.type === 'assistant') {
            color = 'rgb(186, 117, 23)';
            opacity = 0.85;
          } else {
            color = 'rgb(107, 114, 128)';
            opacity = 0.4;
          }

          return (
            <div
              key={i}
              data-testid="session-minimap-segment"
              data-marker-type={isCompaction ? 'compaction' : segment.type}
              data-group-index={i}
              data-target-id={segment.targetId}
              className="absolute rounded-sm"
              style={isCompaction
                ? {
                    top: `${segment.topPct}%`,
                    left: '-8px',
                    right: '-8px',
                    height: '3px',
                    background: '#F59E0B',
                    opacity,
                    zIndex: 20,
                    transform: 'translateY(-50%)',
                    boxShadow: '0 0 0 1px rgba(120,53,15,0.9), 0 0 0 4px rgba(245,158,11,0.18)',
                  }
                : { top: `${segment.topPct}%`, left: 0, right: 0, height: `${height}%`, background: color, opacity }}
              title={isCompaction ? 'Context Window Compaction' : undefined}
            />
          );
        })}
        {/* Current viewport indicator — bordered box that follows scroll position */}
        <div
          data-testid="session-minimap-indicator"
          className="absolute -left-2.5 -right-2.5 rounded-sm border-2 border-primary bg-primary/20 shadow-[0_0_0_1px_rgba(255,255,255,0.45),0_2px_8px_rgba(0,0,0,0.22)] pointer-events-none transition-[top] duration-75"
          style={{
            top: `${viewport.topPct}%`,
            height: `${viewport.heightPct}%`,
            minHeight: '8px',
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared compact UI atoms
// ---------------------------------------------------------------------------

function Pill({ value, tone = 'neutral', mono = false }: {
  value: string;
  tone?: 'neutral' | 'good' | 'warn' | 'danger';
  mono?: boolean;
}) {
  const cls: Record<string, string> = {
    neutral: 'border-border/60 bg-muted/40 text-muted-foreground',
    good: 'border-green-200/70 bg-green-50/70 text-green-700 dark:border-green-800/50 dark:bg-green-950/30 dark:text-green-400',
    warn: 'border-amber-200/70 bg-amber-50/70 text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-400',
    danger: 'border-red-200/70 bg-red-50/70 text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-400',
  };
  return (
    <span className={`inline-flex rounded-full border px-1.5 py-0 text-[10px] leading-4 ${cls[tone]} ${mono ? 'font-mono' : ''}`}>
      {value}
    </span>
  );
}

function normalizeDisplayNewlines(value: string): string {
  if (!value) return value;
  if (/\r\n?|\n/.test(value)) return value;
  return value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
}

const COLLAPSED_PREVIEW_LINES = 5;
const EXPANDED_PREVIEW_LINES = 50;

type PreviewTone = 'neutral' | 'success' | 'error' | 'unknown';

interface ArtifactViewerState {
  title: string;
  subtitle?: string;
  kind: 'text' | 'diff';
  tone?: PreviewTone;
  language?: CodeLanguage;
  sourcePath?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  location?: string;
}

interface SessionRenderContextValue {
  projectRoot?: string;
  openArtifact: (artifact: ArtifactViewerState) => void;
}

const SessionRenderContext = createContext<SessionRenderContextValue | null>(null);

function useSessionRenderContext(): SessionRenderContextValue {
  const context = useContext(SessionRenderContext);
  if (!context) throw new Error('Session render context is missing.');
  return context;
}

function normalizeDisplayPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function formatDisplayPath(pathValue: string, projectRoot?: string): string {
  const normalizedRoot = projectRoot ? normalizeDisplayPath(projectRoot).replace(/\/$/, '') : undefined;
  return normalizeDisplayNewlines(pathValue)
    .split(/\r\n?|\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return trimmed;
      const normalizedLine = normalizeDisplayPath(trimmed);
      if (!normalizedRoot) return normalizedLine;
      if (normalizedLine.toLowerCase() === normalizedRoot.toLowerCase()) return '.';
      const prefix = `${normalizedRoot}/`;
      if (normalizedLine.toLowerCase().startsWith(prefix.toLowerCase())) {
        return normalizedLine.slice(prefix.length);
      }
      return normalizedLine;
    })
    .join('\n');
}

const CODE_PATH_DETAIL_KEYS = ['originalFile', 'content.file.filePath', 'displayPath', 'filePath', 'file_path', 'filename', 'path'];

function getCodePathDetailValue(details: SessionToolCallDisplay['details']): string | undefined {
  return findPreferredDetail(details, CODE_PATH_DETAIL_KEYS)?.value;
}

function isPathDetailKey(key: string): boolean {
  return detailMatchesKey(key, ['displayPath', 'file_path', 'filePath', 'path', 'paths', 'filename', 'content.file.filePath']);
}

function formatDisplayValue(key: string, value: string, projectRoot?: string): string {
  const normalized = normalizeDisplayNewlines(value);
  if (!isPathDetailKey(key)) return normalized;
  return formatDisplayPath(normalized, projectRoot);
}

function splitDisplayPath(pathValue: string): { prefix: string; basename: string } {
  const normalized = pathValue.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  if (parts.length <= 1) {
    return { prefix: '', basename: normalized };
  }

  const basename = parts[parts.length - 1];
  const prefixParts = parts.slice(0, -1);
  if (normalized.length <= 42) {
    return { prefix: `${prefixParts.join('/')}/`, basename };
  }

  return { prefix: `${prefixParts[0]}.../`, basename };
}

function parseExitCodeValue(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const direct = trimmed.match(/^-?\d+$/);
  if (direct) return Number.parseInt(direct[0], 10);

  const labeled = trimmed.match(/\bexit\s+code\b\s*:?\s*(-?\d+)/i) || trimmed.match(/\bexit\b\s*:?\s*(-?\d+)/i);
  return labeled ? Number.parseInt(labeled[1], 10) : null;
}

function getExitCodeFromDetails(details: SessionToolCallDisplay['details']): number | null {
  const detail = findDetail(details, ['exitCode']);
  return parseExitCodeValue(detail?.value);
}

function getOutputExitCode(blocks: SessionMessageBlockDisplay[], content: string): number | null {
  for (const block of blocks) {
    const exitCode = getExitCodeFromDetails(block.details);
    if (exitCode !== null) return exitCode;
  }
  return parseExitCodeValue(content);
}

function getOutputTone(exitCode: number | null): PreviewTone {
  if (exitCode === null) return 'unknown';
  return exitCode === 0 ? 'success' : 'error';
}

function toPreviewLines(value: string): string[] {
  const normalized = normalizeDisplayNewlines(value).replace(/\r\n?/g, '\n');
  return normalized ? normalized.split('\n') : [];
}

const HIGHLIGHT_TOKEN_CLASSES: Record<HighlightToken['kind'], string> = {
  plain: '',
  comment: 'text-muted-foreground/90 italic',
  function: 'text-violet-700 dark:text-violet-300',
  keyword: 'text-sky-700 dark:text-sky-300',
  number: 'text-fuchsia-700 dark:text-fuchsia-300',
  operator: 'text-rose-700 dark:text-rose-300',
  string: 'text-amber-700 dark:text-amber-300',
  type: 'text-emerald-700 dark:text-emerald-300',
};

function renderHighlightedTokens(tokens: HighlightToken[], keyPrefix: string) {
  return tokens.map((token, index) => {
    const className = HIGHLIGHT_TOKEN_CLASSES[token.kind];
    return (
      <span key={`${keyPrefix}-${index}`} className={className || undefined}>
        {token.text}
      </span>
    );
  });
}

function HighlightedCode({ content, language, className }: {
  content: string;
  language?: CodeLanguage;
  className: string;
}) {
  const tokenLines = useMemo(() => tokenizeCode(content, language), [content, language]);

  return (
    <pre className={className}>
      {tokenLines.map((tokens, lineIndex) => (
        <span key={`line-${lineIndex}`}>
          {renderHighlightedTokens(tokens, `token-${lineIndex}`)}
          {lineIndex < tokenLines.length - 1 ? '\n' : null}
        </span>
      ))}
    </pre>
  );
}

interface DiffPreviewLine {
  tone: 'meta' | 'remove' | 'add';
  text: string;
}

function buildDiffPreviewLines(oldText: string, newText: string, location?: string): DiffPreviewLine[] {
  const lines: DiffPreviewLine[] = [{ tone: 'meta', text: location ? `@@ ${location} @@` : '@@ edit @@' }];
  toPreviewLines(oldText).forEach(line => {
    lines.push({ tone: 'remove', text: `- ${line}` });
  });
  toPreviewLines(newText).forEach(line => {
    lines.push({ tone: 'add', text: `+ ${line}` });
  });
  return lines;
}

function getArtifactFrameClasses(artifact: ArtifactViewerState): { frame: string; header: string } {
  if (artifact.kind === 'diff' || artifact.tone === 'neutral' || artifact.tone === 'unknown' || !artifact.tone) {
    return {
      frame: 'border-border/50 bg-background/95',
      header: 'border-b border-border/40 bg-muted/25',
    };
  }

  if (artifact.tone === 'error') {
    return {
      frame: 'border-red-500/30 bg-red-500/[0.025]',
      header: 'border-b border-red-500/20 bg-red-500/[0.04]',
    };
  }

  return {
    frame: 'border-green-500/25 bg-green-500/[0.02]',
    header: 'border-b border-green-500/20 bg-green-500/[0.035]',
  };
}

function ArtifactPreviewContent({ artifact, maxLines, fullscreen = false }: {
  artifact: ArtifactViewerState;
  maxLines?: number;
  fullscreen?: boolean;
}) {
  const visibleLines = fullscreen ? Number.MAX_SAFE_INTEGER : (maxLines ?? COLLAPSED_PREVIEW_LINES);
  const artifactLanguage = artifact.language ?? guessCodeLanguage(artifact.sourcePath);

  if (artifact.kind === 'diff') {
    const diffLines = buildDiffPreviewLines(artifact.oldText || '', artifact.newText || '', artifact.location);
    const shownLines = diffLines.slice(0, visibleLines);
    const hiddenLines = Math.max(diffLines.length - shownLines.length, 0);

    return (
      <>
        <div className="space-y-0.5 font-mono text-[11px] leading-5">
          {shownLines.map((line, index) => {
            const toneClass = line.tone === 'meta'
              ? 'text-[10px] text-muted-foreground'
              : line.tone === 'remove'
                ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                : 'bg-green-500/10 text-green-700 dark:text-green-300';
            return (
              <div key={`${line.tone}-${index}`} className={`whitespace-pre-wrap break-words rounded px-2 py-0.5 ${toneClass}`}>
                {line.tone === 'meta' || !artifactLanguage ? line.text : (
                  <>
                    <span className="opacity-70">{line.text.slice(0, 2)}</span>
                    {renderHighlightedTokens(tokenizeCode(line.text.slice(2), artifactLanguage)[0] || [], `diff-${index}`)}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {!fullscreen && hiddenLines > 0 && (
          <div className="mt-2 border-t border-border/40 pt-1 text-[10px] italic text-muted-foreground">
            + {hiddenLines} more lines
          </div>
        )}
      </>
    );
  }

  const lines = toPreviewLines(artifact.content || '');
  const shownLines = lines.slice(0, visibleLines);
  const hiddenLines = Math.max(lines.length - shownLines.length, 0);

  return (
    <>
      <HighlightedCode
        content={shownLines.join('\n')}
        language={artifactLanguage}
        className={`whitespace-pre-wrap break-words text-foreground ${fullscreen ? 'font-mono text-sm leading-6' : 'font-mono text-[11px] leading-5'}`}
      />
      {!fullscreen && hiddenLines > 0 && (
        <div className="mt-2 border-t border-border/40 pt-1 text-[10px] italic text-muted-foreground">
          + {hiddenLines} more lines
        </div>
      )}
    </>
  );
}

function ArtifactPreview({ artifact, label, className = '' }: {
  artifact: ArtifactViewerState;
  label: string;
  className?: string;
}) {
  const { openArtifact } = useSessionRenderContext();
  const [expanded, setExpanded] = useState(false);
  const artifactLanguage = artifact.language ?? guessCodeLanguage(artifact.sourcePath);
  const frameClasses = getArtifactFrameClasses(artifact);
  const totalLines = artifact.kind === 'diff'
    ? buildDiffPreviewLines(artifact.oldText || '', artifact.newText || '', artifact.location).length
    : Math.max(toPreviewLines(artifact.content || '').length, 1);
  const canExpandInline = totalLines > COLLAPSED_PREVIEW_LINES;

  return (
    <div className={`overflow-hidden rounded-md border ${frameClasses.frame} ${className}`}>
      <div className={`flex items-center justify-between gap-2 px-2 py-0.5 ${frameClasses.header}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
          {artifactLanguage && (
            <span className="rounded-full border border-border/50 bg-background/70 px-1.5 py-0 font-mono text-[10px] leading-4 text-muted-foreground">
              {getCodeLanguageLabel(artifactLanguage)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {canExpandInline && (
            <button
              type="button"
              onClick={() => setExpanded(current => !current)}
              className="inline-flex items-center gap-1 rounded border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown className={`h-2.5 w-2.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
          <button
            type="button"
            onClick={() => openArtifact(artifact)}
            className="inline-flex items-center gap-1 rounded border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-2.5 w-2.5" />
            Open
          </button>
        </div>
      </div>
      <div className="px-2 py-1.5">
        <ArtifactPreviewContent artifact={artifact} maxLines={expanded ? EXPANDED_PREVIEW_LINES : COLLAPSED_PREVIEW_LINES} />
      </div>
    </div>
  );
}

function ArtifactFullscreenViewer({ artifact, onClose }: {
  artifact: ArtifactViewerState | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!artifact) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [artifact, onClose]);

  if (!artifact) return null;

  const artifactLanguage = artifact.language ?? guessCodeLanguage(artifact.sourcePath);

  return (
    <div className="fixed inset-0 z-50 bg-black/45 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/60 bg-card px-4 py-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground">{artifact.title}</h2>
              {artifactLanguage && (
                <span className="rounded-full border border-border/50 bg-background/80 px-2 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground">
                  {getCodeLanguageLabel(artifactLanguage)}
                </span>
              )}
            </div>
            {artifact.subtitle && (
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{artifact.subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border/60 bg-background/80 p-1 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close fullscreen preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto bg-card px-4 py-4">
          <ArtifactPreviewContent artifact={artifact} fullscreen />
        </div>
      </div>
    </div>
  );
}

/** Expandable detail panel */
function DetailPanel({ details, content, shownKeys = [], summaryLabel = 'details' }: {
  details: SessionToolCallDisplay['details'];
  content?: string;
  shownKeys?: string[];
  summaryLabel?: string;
}) {
  const { projectRoot } = useSessionRenderContext();
  // Suppress noisy/redundant keys that don't add value
  const NOISE_KEYS = new Set([
    'type', 'description', 'cache_control', 'sourceToolAssistantUUID', 'tool_use_id', 'toolUseId',
    'leafUuid', 'messageId', 'uuid', 'parent_tool_use_id',
  ]);
  const filtered = details.filter(d => {
    if (shownKeys.some(k => detailMatchesKey(d.key, [k]))) return false;
    if (NOISE_KEYS.has(getDetailKeyTail(d.key))) return false;
    if (!d.value || d.value === '[]' || d.value === '""' || d.value === '{}') return false;
    return true;
  });
  if (filtered.length === 0 && !content) return null;

  const codePath = getCodePathDetailValue(details);
  const previewLanguage = guessCodeLanguage(codePath);

  const previewArtifact = content
    ? {
        title: summaryLabel,
        kind: 'text' as const,
        language: previewLanguage,
        sourcePath: codePath,
        content: normalizeDisplayNewlines(content),
      }
    : null;

  return (
    <div className="space-y-1.5">
      {previewArtifact && <ArtifactPreview artifact={previewArtifact} label={`${summaryLabel} preview`} />}
      {filtered.length > 0 && filtered.length <= 2 && (
        <div className="px-2 py-1 space-y-1">
          {filtered.map((d, idx) => (
            <div key={`${d.key}-${d.value}-${idx}`} className="grid grid-cols-[80px_1fr] gap-1.5 text-[11px]">
              <span className="text-muted-foreground truncate">{d.label}</span>
              <span className={`break-words ${usesMonospaceDetail(d.key) ? 'font-mono text-[10px]' : ''}`}>
                {formatDisplayValue(d.key, d.value, projectRoot)}
              </span>
            </div>
          ))}
        </div>
      )}
      {filtered.length > 2 && (
        <details className="rounded border border-border/40 bg-muted/10">
          <summary className="cursor-pointer px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
            {summaryLabel} ({filtered.length})
          </summary>
          <div className="border-t border-border/30 px-2 py-1.5 space-y-1">
            {filtered.map((d, idx) => (
              <div key={`${d.key}-${d.value}-${idx}`} className="grid grid-cols-[80px_1fr] gap-1.5 text-[11px]">
                <span className="text-muted-foreground truncate">{d.label}</span>
                <span className={`break-words ${usesMonospaceDetail(d.key) ? 'font-mono text-[10px]' : ''}`}>
                  {formatDisplayValue(d.key, d.value, projectRoot)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call rendering (nested under assistant)
// ---------------------------------------------------------------------------

function ToolCallInline({ tool }: { tool: SessionToolCallDisplay }) {
  const { projectRoot } = useSessionRenderContext();
  const command = findDetail(tool.details, ['command']);
  const query = findDetail(tool.details, ['query']);
  const filePath = findDetail(tool.details, ['file_path', 'filePath', 'path']);
  const normalizedCommand = command ? normalizeDisplayNewlines(command.value) : undefined;
  const shouldPreviewCommand = Boolean(
    normalizedCommand && (normalizedCommand.includes('\n') || normalizedCommand.length > 96),
  );

  let primary: string | undefined;
  const shownKeys: string[] = [];
  const pills: { value: string; mono?: boolean; tone?: 'neutral' | 'good' | 'warn' | 'danger' }[] = [];

  if (command) {
    primary = command.value;
    shownKeys.push('command');
    const goal = findDetail(tool.details, ['goal']);
    const mode = findDetail(tool.details, ['mode']);
    if (goal) { pills.push({ value: goal.value }); shownKeys.push('goal'); }
    if (mode) { pills.push({ value: mode.value, mono: true }); shownKeys.push('mode'); }
  } else if (filePath) {
    primary = filePath.value;
    shownKeys.push('file_path', 'filePath', 'path');
    const sl = findDetail(tool.details, ['startLine']);
    const el = findDetail(tool.details, ['endLine']);
    if (sl || el) { pills.push({ value: `L${sl?.value || '?'}–${el?.value || '?'}`, mono: true }); shownKeys.push('startLine', 'endLine'); }
    if (tool.artifact?.kind === 'diff') {
      pills.push({ value: 'edit', tone: 'warn' });
    }
  } else if (query) {
    primary = query.value;
    shownKeys.push('query');
    const inc = findDetail(tool.details, ['includePattern']);
    if (inc) { pills.push({ value: `in ${inc.value}`, mono: true }); shownKeys.push('includePattern'); }
  } else {
    primary = tool.summary !== tool.name ? tool.summary : undefined;
  }

  const remainingDetails = omitDetails(tool.details, shownKeys);
  const isEdit = tool.name.toLowerCase().includes('edit') || tool.name.toLowerCase().includes('write') || tool.name.toLowerCase().includes('replace');
  const previewArtifact: ArtifactViewerState | null = tool.artifact?.kind === 'diff'
    ? {
        title: `${tool.name} diff`,
        subtitle: primary && filePath ? formatDisplayPath(primary, projectRoot) : undefined,
        kind: 'diff',
        tone: 'neutral',
        language: guessCodeLanguage(primary),
        sourcePath: primary,
        oldText: tool.artifact.oldText,
        newText: tool.artifact.newText,
        location: tool.artifact.location,
      }
    : shouldPreviewCommand && normalizedCommand
      ? {
          title: `${tool.name} command`,
          kind: 'text',
          tone: 'neutral',
          content: normalizedCommand,
        }
      : null;
  const displayPrimary = primary
    ? filePath
      ? formatDisplayPath(primary, projectRoot)
      : normalizeDisplayNewlines(primary)
    : undefined;
  const diffCounts = tool.artifact?.kind === 'diff'
    ? {
        added: toPreviewLines(tool.artifact.newText || '').length,
        removed: toPreviewLines(tool.artifact.oldText || '').length,
      }
    : null;

  return (
    <div className="px-3 py-1.5 text-[13px]" data-testid="tool-call-inline" data-tool-call-id={tool.id}>
      <div className="flex flex-wrap items-start gap-2">
        <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ${isEdit ? 'bg-amber-500/10' : 'bg-muted'}`}>
          {isEdit ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 8l5-5 1.5 1.5-5 5L1 8.5z" stroke="currentColor" className="text-amber-500" strokeWidth="1"/></svg>
          ) : (
            <FileText className="h-2.5 w-2.5 text-muted-foreground" />
          )}
        </div>
        <span className="pt-0.5 font-medium text-foreground text-[12px] shrink-0">{tool.name}</span>
        {displayPrimary && (
          <div className="min-w-0 basis-[20rem] flex-1">
            <code className={`block font-mono text-[11px] text-muted-foreground ${previewArtifact ? 'truncate' : 'whitespace-pre-wrap break-all'}`}>
              {previewArtifact ? displayPrimary.split('\n')[0] : displayPrimary}
            </code>
          </div>
        )}
        {diffCounts && (
          <div className="inline-flex items-center gap-1 shrink-0 font-mono text-[10px]">
            <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-green-700 dark:text-green-300">
              +{diffCounts.added}
            </span>
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-red-700 dark:text-red-300">
              -{diffCounts.removed}
            </span>
          </div>
        )}
        {pills.map((p, i) => <Pill key={i} value={p.value} mono={p.mono} tone={p.tone} />)}
        {remainingDetails.length > 0 && <div className="shrink-0"><DetailPanel details={remainingDetails} shownKeys={shownKeys} /></div>}
      </div>
      {previewArtifact && (
        <ArtifactPreview
          artifact={previewArtifact}
          label={previewArtifact.kind === 'diff' ? 'Diff preview' : 'Command preview'}
          className="mt-1.5 ml-6"
        />
      )}
    </div>
  );
}

function ToolResultInline({ msg }: { msg: SessionMessageDisplay }) {
  const { projectRoot } = useSessionRenderContext();
  const blocks = msg.blocks || [];
  if (blocks.length === 0 && !msg.content) return null;

  const blockContent = normalizeDisplayNewlines(
    blocks
      .map(block => block.content)
      .filter((content): content is string => Boolean(content))
      .join('\n\n'),
  ).trim();
  const normalizedMessageContent = normalizeDisplayNewlines(msg.content).trim();
  const exitCode = getOutputExitCode(blocks, `${normalizedMessageContent}\n${blockContent}`);
  const outputTone = getOutputTone(exitCode);
  const hasExplicitFailure = outputTone === 'error';

  const accent = outputTone === 'error'
    ? 'border-l-2 border-red-500/70 bg-red-500/[0.02]'
    : outputTone === 'success'
      ? 'border-l-2 border-green-500/40 bg-transparent'
      : 'border-l-2 border-border/60 bg-transparent';
  const textColor = outputTone === 'error'
    ? 'text-red-600 dark:text-red-400'
    : outputTone === 'success'
      ? 'text-green-700/80 dark:text-green-500/80'
      : 'text-muted-foreground';
  const previewPath = blocks.map(block => getCodePathDetailValue(block.details)).find(Boolean);
  const previewLanguage = guessCodeLanguage(previewPath);

  // Determine effective content for display
  const effectiveContent = blockContent || normalizedMessageContent;
  const contentLines = effectiveContent ? effectiveContent.split('\n') : [];

  // Short inline output: 1–4 lines, show as plain code block without the heavyweight preview frame
  const isShortOutput = contentLines.length > 0 && contentLines.length <= 4 && effectiveContent.length <= 300;

  if (isShortOutput) {
    return (
      <div className={`${accent} px-3 py-1.5`}>
        <HighlightedCode
          content={effectiveContent}
          language={previewLanguage}
          className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-5 ${outputTone === 'unknown' ? 'text-foreground/80' : textColor}`}
        />
      </div>
    );
  }

  const previewArtifact: ArtifactViewerState | null = blockContent
    ? {
        title: blocks[0]?.title || (hasExplicitFailure ? 'Error output' : 'Tool output'),
        subtitle: previewPath
          ? formatDisplayPath(previewPath, projectRoot)
          : normalizedMessageContent && !normalizedMessageContent.includes('\n')
            ? normalizedMessageContent
            : undefined,
        kind: 'text',
        language: previewLanguage,
        sourcePath: previewPath,
        content: blockContent,
        tone: outputTone,
      }
    : normalizedMessageContent && (normalizedMessageContent.includes('\n') || normalizedMessageContent.length > 120)
      ? {
          title: hasExplicitFailure ? 'Error output' : 'Tool output',
          kind: 'text',
          tone: outputTone,
          language: previewLanguage,
          sourcePath: previewPath,
          content: normalizedMessageContent,
        }
      : null;
  const showStatusRow = Boolean(previewArtifact && normalizedMessageContent && !normalizedMessageContent.includes('\n') && normalizedMessageContent !== blockContent);

  if (!previewArtifact) {
    return (
      <div className={`flex items-center gap-1.5 px-3 py-1 text-[11px] ${accent}`}>
        {outputTone === 'error'
          ? <AlertCircle className={`h-2.5 w-2.5 shrink-0 ${textColor}`} />
          : <Check className={`h-2.5 w-2.5 shrink-0 ${textColor}`} />}
        <span className={`truncate ${textColor}`}>{normalizedMessageContent || 'Completed'}</span>
      </div>
    );
  }

  return (
    <div className={`${accent} py-1`}>
      {showStatusRow && (
        <div className="flex items-center gap-1.5 px-3 py-1 text-[11px]">
          {outputTone === 'error'
            ? <AlertCircle className={`h-2.5 w-2.5 shrink-0 ${textColor}`} />
            : <Check className={`h-2.5 w-2.5 shrink-0 ${textColor}`} />}
          <span className={`truncate ${textColor}`}>{normalizedMessageContent}</span>
        </div>
      )}
      <ArtifactPreview artifact={previewArtifact} label={hasExplicitFailure ? 'Error output' : 'Output preview'} className="mx-3 mb-1.5 mt-1" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block cards (thinking, tool-result, event)
// ---------------------------------------------------------------------------

function BlockCard({ block }: { block: SessionMessageBlockDisplay }) {
  const { projectRoot } = useSessionRenderContext();
  const shownKeys: string[] = [];
  const pills: { value: string; mono?: boolean; tone?: 'neutral' | 'good' | 'warn' | 'danger' }[] = [];

  const command = findDetail(block.details, ['command']);
  const filePath = findDetail(block.details, ['displayPath', 'filePath', 'file_path', 'content.file.filePath', 'filename', 'path']);
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
    if (exitCode) { pills.push({ value: `exit ${exitCode.value}`, tone: exitCode.value === '0' ? 'good' : 'danger', mono: true }); shownKeys.push('exitCode'); }
    if (duration) { pills.push({ value: duration.value, mono: true }); shownKeys.push('durationMs'); }
  } else if (filePath) {
    primary = filePath.value;
    shownKeys.push('displayPath', 'filePath', 'file_path', 'content.file.filePath', 'filename', 'path');
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
      {pills.map((p, i) => <Pill key={i} {...p} />)}
      <DetailPanel details={remainingDetails} content={block.content} shownKeys={shownKeys} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grouped message renderers
// ---------------------------------------------------------------------------

/** Collapsed system event group */
function SystemGroup({ messages }: { messages: { message: SessionMessageDisplay; index: number }[] }) {
  const [expanded, setExpanded] = useState(false);
  const firstIndex = messages[0]?.index;
  const timeRange = (() => {
    const timestamps = messages
      .map(m => m.message.timestamp)
      .filter(t => t && !isNaN(new Date(t).getTime()));
    if (timestamps.length === 0) return '';
    const first = format(new Date(timestamps[0]), 'h:mm:ss');
    const last = timestamps.length > 1 ? format(new Date(timestamps[timestamps.length - 1]), 'h:mm:ss') : '';
    return last && last !== first ? `${first}–${last}` : first;
  })();

  const labels = messages.slice(0, 3).map(m => {
    if (m.message.role === 'command') return m.message.content.slice(0, 20);
    const blocks = m.message.blocks || [];
    if (blocks.length > 0) return blocks[0].title;
    return m.message.isMeta ? 'meta' : 'system';
  });

  if (!expanded) {
    return (
      <button
        id={firstIndex === undefined ? undefined : `conversation-message-${firstIndex}`}
        onClick={() => setExpanded(true)}
        className="flex items-center gap-2 w-full px-3 py-1.5 bg-muted/30 border border-dashed border-border/50 rounded text-[11px] text-muted-foreground hover:bg-muted/50 transition-colors"
      >
        <span>{messages.length} system event{messages.length === 1 ? '' : 's'}</span>
        <span className="opacity-60 truncate">· {labels.join(', ')}{timeRange ? ` · ${timeRange}` : ''}</span>
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
          {message.timestamp && !isNaN(new Date(message.timestamp).getTime()) && (
            <span className="ml-auto shrink-0 text-[9px]">{format(new Date(message.timestamp), 'h:mm:ss a')}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function CompactionDivider({ timestamp, targetId }: { timestamp: string; targetId: string }) {
  const timeLabel = !isNaN(new Date(timestamp).getTime())
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

/** User message — colored left border, content-forward */
function UserMessage({ msg, index }: { msg: SessionMessageDisplay; index: number }) {
  return (
    <div id={`conversation-message-${index}`} className="border-l-2 border-blue-500 pl-3.5 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-blue-500">User</span>
        {msg.timestamp && !isNaN(new Date(msg.timestamp).getTime()) && (
          <span className="text-[11px] text-muted-foreground">{format(new Date(msg.timestamp), 'h:mm a')}</span>
        )}
      </div>
      <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
        {msg.content}
      </div>
    </div>
  );
}

/** Assistant message — card-like with token/cost metadata right-aligned */
function AssistantCard({ msg, index, toolPairs, toolTimeline }: {
  msg: SessionMessageDisplay;
  index: number;
  toolPairs: ToolPair[];
  toolTimeline?: AssistantTimelineItem[];
}) {
  const { pickCost } = useCostMode();
  const thinkingBlocks = (msg.blocks || []).filter(b => b.type === 'thinking');
  const eventBlocks = (msg.blocks || []).filter(b => b.type === 'event');

  const modelLabel = msg.model
    ? getModelDisplayName(msg.model)
    : null;

  const turnCost = pickCost(msg.estimatedCosts, 0);
  const nestedTimeline = toolTimeline || toolPairs.map(pair => ({ type: 'tool-pair' as const, pair }));

  // Surface a readable summary even when the assistant emitted only tool calls
  const unpairedTools = msg.toolCalls || [];
  const fallbackSummary = (() => {
    if (msg.content) return null;
    const firstThink = thinkingBlocks.find(b => b.summary)?.summary;
    if (firstThink) return firstThink;
    if (unpairedTools.length === 1) {
      const t = unpairedTools[0];
      const path = findDetail(t.details, ['file_path', 'filePath', 'path', 'displayPath'])?.value;
      const cmd = findDetail(t.details, ['command'])?.value;
      const query = findDetail(t.details, ['query'])?.value;
      const arg = path || cmd?.split('\n')[0] || query;
      return arg ? `${t.name} ${arg}` : t.name;
    }
    if (unpairedTools.length > 1) {
      const names = Array.from(new Set(unpairedTools.map(t => t.name))).slice(0, 3).join(', ');
      return `${unpairedTools.length} tool calls · ${names}`;
    }
    return null;
  })();

  return (
    <div id={`conversation-message-${index}`} data-testid="assistant-turn">
      {/* Assistant card */}
      <div className="bg-card border border-border/50 rounded-lg p-3">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-[18px] h-[18px] rounded bg-amber-500/10 flex items-center justify-center">
            <Bot className="h-2.5 w-2.5 text-amber-600" />
          </div>
          <span className="text-[11px] font-medium text-foreground">Claude</span>
          {modelLabel && <span className="text-[11px] text-muted-foreground">{modelLabel}</span>}
          {msg.timestamp && !isNaN(new Date(msg.timestamp).getTime()) && (
            <span className="text-[11px] text-muted-foreground">· {format(new Date(msg.timestamp), 'h:mm:ss a')}</span>
          )}
          {msg.usage && (
            <div className="ml-auto flex gap-2.5 text-[11px] text-muted-foreground font-mono">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>↓ {formatTokens((msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0))}</span>
                </TooltipTrigger>
                <TooltipContent>Input tokens (including cache read)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>↑ {formatTokens(msg.usage.output_tokens || 0)}</span>
                </TooltipTrigger>
                <TooltipContent>Output tokens</TooltipContent>
              </Tooltip>
              {turnCost > 0.001 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-foreground/70">{formatCost(turnCost)}</span>
                  </TooltipTrigger>
                  <TooltipContent>Estimated cost this turn</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {/* Body */}
        {msg.content && (
          <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
            {msg.content}
          </div>
        )}
        {!msg.content && fallbackSummary && (
          <div className="text-sm leading-relaxed text-foreground/70 italic">
            {fallbackSummary}
          </div>
        )}

        {/* Thinking blocks */}
        {thinkingBlocks.filter(b => b.summary).map((block, i) => (
          <div key={`think-${i}`} className="flex items-center gap-1.5 py-0.5 mt-1 text-[11px] text-muted-foreground">
            <Brain className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{block.summary}</span>
            {block.content && (
              <details className="inline">
                <summary className="cursor-pointer text-[10px]">…</summary>
                <pre className="mt-1 rounded bg-muted/20 p-1.5 text-[10px] whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                  {block.content}
                </pre>
              </details>
            )}
          </div>
        ))}

        {/* Inline tool calls from the assistant message itself */}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="mt-2 border-t border-border/30 pt-2 space-y-0">
            {msg.toolCalls.map((tool, i) => <ToolCallInline key={tool.id || i} tool={tool} />)}
          </div>
        )}

        {/* Event blocks */}
        {eventBlocks.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[10px] text-muted-foreground">{eventBlocks.length} event{eventBlocks.length === 1 ? '' : 's'}</summary>
            <div className="space-y-0 mt-1">{eventBlocks.map((b, i) => <BlockCard key={i} block={b} />)}</div>
          </details>
        )}
      </div>

      {/* Nested tool pairs — visually attached to parent assistant turn via left rule */}
      {nestedTimeline.length > 0 && (
        <div className="ml-4 border-l-2 border-border/50 pl-3 mt-1 space-y-1">
          {nestedTimeline.map((item, i) => {
            if (item.type === 'compaction') {
              return (
                <CompactionDivider
                  key={`nested-compaction-${item.index}-${item.timestamp}`}
                  timestamp={item.timestamp}
                  targetId={item.targetId}
                />
              );
            }

            const { pair } = item;
            const toolUseId = pair.toolUse?.message.toolCalls?.[0]?.id;
            const toolResultId = pair.toolResult ? getToolResultId(pair.toolResult.message) : undefined;

            return (
              <div
                key={i}
                data-testid="tool-io-pair"
                data-tool-use-id={toolUseId}
                data-tool-result-id={toolResultId}
                className="rounded border border-border/30 bg-card/40 overflow-hidden"
              >
                {pair.toolUse && (
                  <div id={`conversation-message-${pair.toolUse.index}`}>
                    {(pair.toolUse.message.toolCalls || []).map((tool, j) => (
                      <ToolCallInline key={tool.id || j} tool={tool} />
                    ))}
                    {(pair.toolUse.message.blocks || []).filter(b => b.type === 'thinking').filter(b => b.summary).map((block, j) => (
                      <div key={`think-${j}`} className="flex items-center gap-1.5 px-3 py-0.5 text-[11px] text-muted-foreground">
                        <Brain className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{block.summary}</span>
                      </div>
                    ))}
                  </div>
                )}
                {pair.toolResult && (
                  <div id={`conversation-message-${pair.toolResult.index}`} className="border-t border-border/30">
                    <ToolResultInline msg={pair.toolResult.message} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context Window Composition Bar
// ---------------------------------------------------------------------------

function ContextWindowMeter({ session, messages }: { session: SessionTokenSummary; messages: SessionMessageDisplay[] }) {
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

// ---------------------------------------------------------------------------
// Context Files Panel (redesigned with fill bars)
// ---------------------------------------------------------------------------

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
      {/* Fill bar */}
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

function ContextFilesPanel({ contextFiles, copiedPath, onCopyPath, onJumpToMessage, hasDiffForPath, onOpenDiff }: {
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

  const INITIAL_SHOW = 6;
  const visibleFiles = showAll ? allFiles : allFiles.slice(0, INITIAL_SHOW);
  const remaining = totalCount - INITIAL_SHOW;
  const allPathsText = getContextFilePathsText(allFiles);
  const isAllCopied = copiedPath === allPathsText;

  return (
    <Card className="border-border/50 shadow-sm py-0 gap-0">
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-foreground">
            Files in context <span className="text-muted-foreground font-normal">· {totalCount}</span>
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
              const hiddenFiles = allFiles.slice(INITIAL_SHOW);
              const hiddenLines = hiddenFiles.reduce((sum, f) => {
                const loaded = getContextLoadedLineCount(f);
                return sum + (loaded ?? 0);
              }, 0);
              // ~4 tokens per line is a rough code estimate
              if (hiddenLines > 0) {
                const tokenEstimate = hiddenLines * 4;
                return ` · ~${formatTokens(tokenEstimate)} tok`;
              }
              return '';
            })()}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Filter Presets
// ---------------------------------------------------------------------------

function FilterPresets({ preset, onChange, counts }: {
  preset: FilterPreset;
  onChange: (p: FilterPreset) => void;
  counts: { narrative: number; tools: number; all: number };
}) {
  const buttons: { key: FilterPreset; label: string }[] = [
    { key: 'narrative', label: 'Narrative' },
    { key: 'tools', label: '+ Tools' },
    { key: 'all', label: 'All events' },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[12px] text-muted-foreground">Show:</span>
      {buttons.map(b => {
        const active = preset === b.key;
        return (
          <button
            key={b.key}
            onClick={() => onChange(b.key)}
            className={`text-[12px] px-2.5 py-1 rounded-full font-medium transition-colors inline-flex items-center gap-1.5 ${
              active
                ? 'border-2 border-blue-500 bg-blue-500/10 text-blue-600 shadow-sm dark:border-blue-400 dark:bg-blue-500/20 dark:text-blue-300'
                : 'border border-border/60 bg-card/70 text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            <span>{b.label}</span>
            <span className={`text-[10px] font-mono px-1 rounded ${active ? 'bg-white/70 text-current dark:bg-white/20' : 'bg-muted/60 text-muted-foreground'}`}>
              {counts[b.key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

type MainSessionView = 'conversation' | 'changes';
type DiffDisplayMode = 'net' | 'edits';

function formatDiffFileCountLabel(summary: SessionDiffSummary): string {
  if (summary.fileCount === 0) return '0 files';
  return summary.fileCount === 1 ? '1 file' : `${summary.fileCount} files`;
}

function normalizeDiffPathKey(pathValue: string): string {
  return normalizeDisplayPath(pathValue).replace(/^\.\//, '').toLowerCase();
}

function SessionViewTabs({ view, onChange, conversationCount, diffSummary, diffMode, onDiffModeChange, copiedPatchKey, onCopyPatch }: {
  view: MainSessionView;
  onChange: (view: MainSessionView) => void;
  conversationCount: number;
  diffSummary: SessionDiffSummary;
  diffMode: DiffDisplayMode;
  onDiffModeChange: (mode: DiffDisplayMode) => void;
  copiedPatchKey: string | null;
  onCopyPatch: (patchText: string, key: string) => void;
}) {
  const buttonClass = (active: boolean) => (
    `-mb-px inline-flex items-center gap-2 border-b-2 px-2 py-2 text-sm font-semibold transition-colors ${
      active
        ? 'border-blue-500 text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`
  );
  const allPatchKey = `${diffMode}:__all__`;
  const allCopied = copiedPatchKey === allPatchKey;

  return (
    <div className="-mx-6 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-6">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange('conversation')}
          className={buttonClass(view === 'conversation')}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          Conversation
          <span className="font-mono text-[11px] font-normal text-muted-foreground">{conversationCount}</span>
        </button>
        <button
          type="button"
          onClick={() => onChange('changes')}
          className={buttonClass(view === 'changes')}
          disabled={diffSummary.fileCount === 0}
        >
          <FileText className="h-3.5 w-3.5" />
          Changes
          <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 font-mono text-[11px] font-normal text-blue-700 dark:text-blue-300">
            {formatDiffFileCountLabel(diffSummary)}
          </span>
        </button>
      </div>
      {diffSummary.fileCount > 0 && (
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 font-mono text-[11px] text-green-700 dark:text-green-300">
            +{diffSummary.addedLines}
          </span>
          <span className="rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 font-mono text-[11px] text-red-700 dark:text-red-300">
            -{diffSummary.removedLines}
          </span>
          {view === 'changes' && (
            <>
              <DiffModeToggle mode={diffMode} onChange={onDiffModeChange} />
              <button
                type="button"
                onClick={() => onCopyPatch(getSessionPatchText(diffSummary, diffMode), allPatchKey)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/40"
              >
                {allCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {allCopied ? 'Copied patch' : 'Copy patch'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DiffModeToggle({ mode, onChange }: {
  mode: DiffDisplayMode;
  onChange: (mode: DiffDisplayMode) => void;
}) {
  const buttons: { key: DiffDisplayMode; label: string }[] = [
    { key: 'net', label: 'Net diff' },
    { key: 'edits', label: 'Per edit' },
  ];

  return (
    <div className="inline-flex rounded-md border border-border/60 bg-background p-0.5">
      {buttons.map(button => (
        <button
          key={button.key}
          type="button"
          onClick={() => onChange(button.key)}
          className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
            mode === button.key
              ? 'bg-muted/80 text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {button.label}
        </button>
      ))}
    </div>
  );
}

function DiffStat({ value, tone }: { value: number; tone: 'add' | 'remove' }) {
  const className = tone === 'add'
    ? 'text-green-700 dark:text-green-300'
    : 'text-red-700 dark:text-red-300';
  return (
    <span className={`font-mono text-[11px] tabular-nums ${className}`}>
      {tone === 'add' ? '+' : '-'}{value}
    </span>
  );
}

function DiffFileRow({ file, selected, onSelect, projectRoot }: {
  file: SessionDiffFile;
  selected: boolean;
  onSelect: () => void;
  projectRoot?: string;
}) {
  const displayPath = formatDisplayPath(file.path, projectRoot);
  const parts = splitDisplayPath(displayPath);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="session-diff-file-row"
      className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${
        selected
          ? 'bg-blue-100 text-foreground dark:bg-blue-500/15'
          : 'bg-white hover:bg-blue-50/70 dark:bg-transparent dark:hover:bg-muted/40'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`truncate font-mono text-xs ${file.status === 'deleted' ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
            {parts.basename}
          </div>
          {parts.prefix && (
            <div className="truncate font-mono text-[10px] text-muted-foreground">{parts.prefix}</div>
          )}
        </div>
        {file.status !== 'modified' && (
          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
            file.status === 'added'
              ? 'bg-green-500/10 text-green-700 dark:text-green-300'
              : 'bg-red-500/10 text-red-700 dark:text-red-300'
          }`}>
            {file.status === 'added' ? 'NEW' : 'DEL'}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {file.addedLines > 0 && <DiffStat value={file.addedLines} tone="add" />}
          {file.removedLines > 0 && <DiffStat value={file.removedLines} tone="remove" />}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {file.editCount} edit{file.editCount === 1 ? '' : 's'}
        </span>
      </div>
    </button>
  );
}

function DiffRow({ row, language, rowKey }: {
  row: SessionDiffRow;
  language?: CodeLanguage;
  rowKey: string;
}) {
  const toneClass = row.type === 'add'
    ? 'bg-green-50 text-green-950 dark:bg-green-500/[0.08] dark:text-green-100'
    : row.type === 'remove'
      ? 'bg-red-50 text-red-950 dark:bg-red-500/[0.08] dark:text-red-100'
      : 'bg-white text-foreground dark:bg-transparent';
  const prefix = row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' ';
  const tokenLine = language ? tokenizeCode(row.text, language)[0] || [] : [];
  const lineNumberClass = 'select-none border-r border-border/30 bg-white px-2 text-right text-slate-500 dark:bg-background dark:text-muted-foreground';
  const oldLineNumber = row.oldLineNumber ?? (row.newLineNumber == null ? '?' : '');
  const newLineNumber = row.newLineNumber ?? (row.oldLineNumber == null ? '?' : '');

  return (
    <div className={`grid min-w-max grid-cols-[3.5rem_3.5rem_minmax(0,1fr)] border-b border-border/20 font-mono text-[11px] leading-5 ${toneClass}`}>
      <div data-testid="session-diff-old-line-number" className={lineNumberClass}>{oldLineNumber}</div>
      <div data-testid="session-diff-new-line-number" className={lineNumberClass}>{newLineNumber}</div>
      <pre className="whitespace-pre-wrap break-words px-2">
        <span className="select-none pr-2 text-muted-foreground/70">{prefix}</span>
        {language ? renderHighlightedTokens(tokenLine, rowKey) : row.text}
      </pre>
    </div>
  );
}

function DiffHunkView({ hunk, language, onJumpToMessage }: {
  hunk: SessionDiffHunk;
  language?: CodeLanguage;
  onJumpToMessage: (messageIndex: number) => void;
}) {
  const timeLabel = hunk.timestamp && !isNaN(new Date(hunk.timestamp).getTime())
    ? format(new Date(hunk.timestamp), 'h:mm:ss a')
    : 'message';
  const formatRange = (start: number | null, count: number) => (
    start == null ? '?' : `${start},${count}`
  );

  return (
    <div data-testid="session-diff-hunk" className="border-b border-border/50 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 bg-muted/30 px-3 py-2 font-mono text-[11px]">
        <span className="text-muted-foreground">
          @@ -{formatRange(hunk.oldStartLine, hunk.oldLineCount)} +{formatRange(hunk.newStartLine, hunk.newLineCount)} @@ {hunk.location || hunk.toolName}
        </span>
        <button
          type="button"
          onClick={() => onJumpToMessage(hunk.messageIndex)}
          className="text-blue-600 hover:underline dark:text-blue-300"
        >
          Jump to message · {timeLabel}
        </button>
      </div>
      <div>
        {hunk.rows.map((row, index) => (
          <DiffRow
            key={`${hunk.id}-${index}`}
            row={row}
            language={language}
            rowKey={`${hunk.id}-${index}`}
          />
        ))}
      </div>
    </div>
  );
}

function FileDiffViewer({ file, mode, copiedPatchKey, onCopyPatch, onJumpToMessage, projectRoot }: {
  file: SessionDiffFile | undefined;
  mode: DiffDisplayMode;
  copiedPatchKey: string | null;
  onCopyPatch: (patchText: string, key: string) => void;
  onJumpToMessage: (messageIndex: number) => void;
  projectRoot?: string;
}) {
  if (!file) {
    return (
      <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground">
        No file changes found in this session.
      </div>
    );
  }

  const displayPath = formatDisplayPath(file.path, projectRoot);
  const language = guessCodeLanguage(file.path);
  const visibleHunks = mode === 'edits' ? file.editHunks : file.hunks;
  const visibleAddedLines = visibleHunks.reduce((sum, hunk) => sum + hunk.addedLines, 0);
  const visibleRemovedLines = visibleHunks.reduce((sum, hunk) => sum + hunk.removedLines, 0);
  const patchText = getFilePatchText(file, mode);
  const patchKey = `${mode}:${file.path}`;
  const isCopied = copiedPatchKey === patchKey;

  return (
    <div data-testid="session-diff-viewer" className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-white dark:bg-background">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-white px-3 py-3 dark:bg-card">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-sm font-semibold">{displayPath}</span>
            <DiffStat value={visibleAddedLines} tone="add" />
            <DiffStat value={visibleRemovedLines} tone="remove" />
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {mode === 'net' ? 'Cumulative session diff' : `${file.editCount} edit${file.editCount === 1 ? '' : 's'} in session order`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onCopyPatch(patchText, patchKey)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {isCopied ? 'Copied' : 'Copy patch'}
        </button>
      </div>
      <div className="max-h-[68vh] overflow-auto">
        {visibleHunks.map(hunk => (
          <DiffHunkView
            key={hunk.id}
            hunk={hunk}
            language={language}
            onJumpToMessage={onJumpToMessage}
          />
        ))}
      </div>
    </div>
  );
}

function ChangesView({ summary, selectedPath, mode, copiedPatchKey, onSelectPath, onCopyPatch, onJumpToMessage, projectRoot }: {
  summary: SessionDiffSummary;
  selectedPath: string | null;
  mode: DiffDisplayMode;
  copiedPatchKey: string | null;
  onSelectPath: (path: string) => void;
  onCopyPatch: (patchText: string, key: string) => void;
  onJumpToMessage: (messageIndex: number) => void;
  projectRoot?: string;
}) {
  const selectedFile = summary.files.find(file => file.path === selectedPath) || summary.files[0];

  return (
    <div data-testid="session-changes-view" className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="space-y-2">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Files Changed
          </div>
          <div className="max-h-[68vh] space-y-1 overflow-y-auto pr-1">
            {summary.files.map(file => (
              <DiffFileRow
                key={file.path}
                file={file}
                selected={(selectedFile?.path || selectedPath) === file.path}
                onSelect={() => onSelectPath(file.path)}
                projectRoot={projectRoot}
              />
            ))}
          </div>
        </div>
        <FileDiffViewer
          file={selectedFile}
          mode={mode}
          copiedPatchKey={copiedPatchKey}
          onCopyPatch={onCopyPatch}
          onJumpToMessage={onJumpToMessage}
          projectRoot={projectRoot}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session, isLoading, error } = useSessionDetail(id);
  const { pickCost } = useCostMode();

  const [preset, setPreset] = useState<FilterPreset>(loadPreset);
  const [copiedContextPath, setCopiedContextPath] = useState<string | null>(null);
  const [minimapSegments, setMinimapSegments] = useState<MinimapSegment[]>([]);
  const [minimapViewport, setMinimapViewport] = useState<MinimapViewport>({ topPct: 0, heightPct: 6 });
  const [artifactViewer, setArtifactViewer] = useState<ArtifactViewerState | null>(null);
  const [toolFilter, setToolFilter] = useState<string | null>(null);
  const [mainView, setMainView] = useState<MainSessionView>('conversation');
  const [diffMode, setDiffMode] = useState<DiffDisplayMode>('net');
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [copiedPatchKey, setCopiedPatchKey] = useState<string | null>(null);
  const [pendingConversationJump, setPendingConversationJump] = useState<number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  const handlePresetChange = useCallback((next: FilterPreset) => {
    setPreset(next);
    savePreset(next);
  }, []);

  const scrollElementIntoConversation = useCallback((targetId: string, block: 'start' | 'center' = 'center') => {
    const container = conversationRef.current;
    const safeTargetId = CSS.escape(targetId);
    const selector = `#${safeTargetId}`;
    const element = (container?.querySelector<HTMLElement>(selector) || document.getElementById(targetId));
    if (!element) return false;

    if (!container) {
      element.scrollIntoView({ behavior: 'smooth', block });
      return true;
    }

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const elementTop = elementRect.top - containerRect.top + container.scrollTop;
    const targetTop = block === 'center'
      ? elementTop - (container.clientHeight / 2) + (elementRect.height / 2)
      : elementTop;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: 'smooth',
    });
    return true;
  }, []);

  const scrollMessageIntoConversation = useCallback((messageIndex: number, block: 'start' | 'center' = 'center') => (
    scrollElementIntoConversation(`conversation-message-${messageIndex}`, block)
  ), [scrollElementIntoConversation]);

  const handleJumpToMessage = useCallback((messageIndexes: number[]) => {
    for (const messageIndex of messageIndexes) {
      if (mainView === 'conversation' && scrollMessageIntoConversation(messageIndex, 'center')) return;
      setMainView('conversation');
      setPendingConversationJump(messageIndex);
      return;
    }
  }, [mainView, scrollMessageIntoConversation]);

  const handleJumpToDiffMessage = useCallback((messageIndex: number) => {
    if (mainView === 'conversation' && scrollMessageIntoConversation(messageIndex, 'center')) return;
    setMainView('conversation');
    setPendingConversationJump(messageIndex);
  }, [mainView, scrollMessageIntoConversation]);

  const handleCopyContextPath = useCallback((filePath: string) => {
    void navigator.clipboard.writeText(filePath).then(() => {
      setCopiedContextPath(filePath);
      window.setTimeout(() => {
        setCopiedContextPath(current => (current === filePath ? null : current));
      }, 1200);
    });
  }, []);

  const handleCopyPatch = useCallback((patchText: string, key: string) => {
    void navigator.clipboard.writeText(patchText).then(() => {
      setCopiedPatchKey(key);
      window.setTimeout(() => {
        setCopiedPatchKey(current => (current === key ? null : current));
      }, 1200);
    });
  }, []);

  const messages = useMemo(() => session?.messages || [], [session]);
  const compactionInfo = useMemo(
    () => session?.compaction || { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
    [session?.compaction],
  );
  const compactionTimestamps = useMemo(
    () => compactionInfo.compactionTimestamps || [],
    [compactionInfo],
  );

  const groupedMessages = useMemo(
    () => buildTranscriptItems(messages, preset, compactionTimestamps, toolFilter),
    [messages, preset, toolFilter, compactionTimestamps],
  );
  const diffSummary = useMemo(() => getSessionDiffSummary(messages), [messages]);
  const diffPathMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of diffSummary.files) {
      map.set(normalizeDiffPathKey(file.path), file.path);
    }
    return map;
  }, [diffSummary.files]);
  const effectiveSelectedDiffPath = useMemo(() => {
    if (selectedDiffPath && diffSummary.files.some(file => file.path === selectedDiffPath)) return selectedDiffPath;
    return diffSummary.files[0]?.path || null;
  }, [diffSummary.files, selectedDiffPath]);
  const minimapTargets = useMemo(() => getMinimapTargets(groupedMessages), [groupedMessages]);

  useEffect(() => {
    if (mainView !== 'conversation' || pendingConversationJump === null) return;
    const frame = window.requestAnimationFrame(() => {
      scrollMessageIntoConversation(pendingConversationJump, 'center');
      setPendingConversationJump(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mainView, pendingConversationJump, scrollMessageIntoConversation]);

  const hasDiffForPath = useCallback((filePath: string) => (
    diffPathMap.has(normalizeDiffPathKey(filePath))
  ), [diffPathMap]);

  const handleOpenDiffForPath = useCallback((filePath: string) => {
    const diffPath = diffPathMap.get(normalizeDiffPathKey(filePath));
    if (!diffPath) return false;
    setSelectedDiffPath(diffPath);
    setMainView('changes');
    return true;
  }, [diffPathMap]);

  const updateMinimapViewport = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return;

    const scrollHeight = Math.max(container.scrollHeight, 1);
    const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 0);
    const rawHeightPct = (container.clientHeight / scrollHeight) * 100;
    const heightPct = Math.min(100, Math.max(rawHeightPct, 6));
    const topPct = maxScroll > 0
      ? (container.scrollTop / maxScroll) * (100 - heightPct)
      : 0;

    setMinimapViewport({ topPct, heightPct });
  }, []);

  const updateMinimapSegments = useCallback(() => {
    const container = conversationRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const scrollHeight = Math.max(container.scrollHeight, 1);
    const nextSegments = minimapTargets
      .map((target): MinimapSegment | null => {
        const element = container.querySelector<HTMLElement>(`#${CSS.escape(target.targetId)}`);
        if (!element) return null;

        const rect = element.getBoundingClientRect();
        const top = rect.top - containerRect.top + container.scrollTop;
        return {
          type: target.type,
          targetId: target.targetId,
          topPct: Math.max(0, Math.min(100, (top / scrollHeight) * 100)),
          heightPct: Math.max((rect.height / scrollHeight) * 100, target.type === 'compaction' ? 0.7 : 0.8),
        };
      })
      .filter((segment): segment is MinimapSegment => Boolean(segment))
      .sort((left, right) => left.topPct - right.topPct);

    setMinimapSegments(nextSegments);
    updateMinimapViewport();
  }, [minimapTargets, updateMinimapViewport]);

  // Scroll and layout tracking for minimap. Segment positions are measured from
  // real DOM geometry so tall outputs occupy proportionally more map space.
  useEffect(() => {
    const container = conversationRef.current;
    if (!container) return;

    updateMinimapSegments();
    const handleScroll = () => updateMinimapViewport();
    container.addEventListener('scroll', handleScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateMinimapSegments());
    resizeObserver.observe(container);
    Array.from(container.children).forEach(child => resizeObserver.observe(child));

    return () => {
      container.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
    };
  }, [groupedMessages, mainView, updateMinimapSegments, updateMinimapViewport]);

  if (isLoading || !session || !session.id) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <div className="space-y-3 text-center">
          {error ? (
            <p className="text-sm text-muted-foreground">Session not found.</p>
          ) : (
            <>
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">Loading session...</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const topTools = Object.entries(session.toolsUsed || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const models = [...new Set(session.models || [])];

  const presetCounts = {
    narrative: messages.filter(m => messagePassesPreset(m, 'narrative')).length,
    tools: messages.filter(m => messagePassesPreset(m, 'tools')).length,
    all: messages.length,
  };

  const contextFiles = getContextFileGroups(messages);
  const compaction = compactionInfo;
  const compactionCount = compaction.compactions + compaction.microcompactions;
  const sessionRenderContext: SessionRenderContextValue = {
    projectRoot: session.cwd || undefined,
    openArtifact: setArtifactViewer,
  };

  return (
    <SessionRenderContext.Provider value={sessionRenderContext}>
      <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Link href="/sessions" className="mt-0.5 rounded-lg border border-border p-1.5 hover:bg-accent transition-colors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 truncate text-xl font-bold tracking-tight">{session.projectName}</h1>
              {models.map(m => <Badge key={m} variant="secondary" className="text-xs">{m}</Badge>)}
              <Pill
                value={compactionCount > 0 ? 'compacted' : 'completed'}
                tone={compactionCount > 0 ? 'warn' : 'good'}
              />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{session.id.slice(0, 8)}</span>
              {session.gitBranch && (
                <>
                  <span className="opacity-40">•</span>
                  <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{session.gitBranch}</span>
                </>
              )}
              <span className="opacity-40">•</span>
              <span>{format(new Date(session.timestamp), 'MMM d, yyyy h:mm a')}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:shrink-0 lg:justify-end">
          <Card className="min-w-[86px] border-primary/30 bg-primary/5 shadow-sm">
            <CardContent className="px-2.5 py-1.5 text-center">
              <div className="flex items-center justify-center gap-1">
                <Coins className="h-3 w-3 text-primary" />
                <p className="whitespace-nowrap text-sm font-bold leading-5 text-primary">{formatCost(pickCost(session.estimatedCosts, session.estimatedCost))}</p>
              </div>
              <p className="text-[9px] leading-3 text-muted-foreground">Est. Usage</p>
            </CardContent>
          </Card>
          <Card className="min-w-[86px] border-border/50 shadow-sm">
            <CardContent className="px-2.5 py-1.5 text-center">
              <div className="flex items-center justify-center gap-1">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <p className="whitespace-nowrap text-sm font-bold leading-5">{formatDuration(session.duration)}</p>
              </div>
              <p className="text-[9px] leading-3 text-muted-foreground">Duration</p>
            </CardContent>
          </Card>
          <Card className="min-w-[86px] border-border/50 shadow-sm">
            <CardContent className="px-2.5 py-1.5 text-center">
              <div className="flex items-center justify-center gap-1">
                <MessageSquare className="h-3 w-3 text-muted-foreground" />
                <p className="whitespace-nowrap text-sm font-bold leading-5">{session.messageCount}</p>
              </div>
              <p className="text-[9px] leading-3 text-muted-foreground">Messages</p>
            </CardContent>
          </Card>
          <Card className="min-w-[86px] border-border/50 shadow-sm">
            <CardContent className="px-2.5 py-1.5 text-center">
              <div className="flex items-center justify-center gap-1">
                <Wrench className="h-3 w-3 text-muted-foreground" />
                <p className="whitespace-nowrap text-sm font-bold leading-5">{session.toolCallCount}</p>
              </div>
              <p className="text-[9px] leading-3 text-muted-foreground">Tool Calls</p>
            </CardContent>
          </Card>
          {diffSummary.fileCount > 0 && (
            <button
              type="button"
              onClick={() => setMainView('changes')}
              className="min-w-[108px] rounded-xl border border-border/50 bg-card text-card-foreground shadow-sm transition-colors hover:bg-muted/30"
            >
              <div className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1.5">
                  <FileText className="h-3 w-3 text-muted-foreground" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5">{diffSummary.fileCount}</p>
                  <span className="font-mono text-[10px] text-green-700 dark:text-green-300">+{diffSummary.addedLines}</span>
                  <span className="font-mono text-[10px] text-red-700 dark:text-red-300">-{diffSummary.removedLines}</span>
                </div>
                <p className="text-[9px] leading-3 text-muted-foreground">Changes</p>
              </div>
            </button>
          )}
          <Card className="min-w-[86px] border-border/50 shadow-sm">
            <CardContent className="px-2.5 py-1.5 text-center">
              <div className="flex items-center justify-center gap-1">
                <Activity className="h-3 w-3 text-muted-foreground" />
                <p className="whitespace-nowrap text-sm font-bold leading-5">{formatTokens(session.totalInputTokens + session.totalOutputTokens)}</p>
              </div>
              <p className="text-[9px] leading-3 text-muted-foreground">Tokens</p>
            </CardContent>
          </Card>
          {compactionCount > 0 && (
            <Card className="min-w-[86px] border-amber-300/50 bg-amber-50/30 shadow-sm dark:bg-amber-950/10">
              <CardContent className="px-2.5 py-1.5 text-center">
                <div className="flex items-center justify-center gap-1">
                  <Minimize2 className="h-3 w-3 text-amber-600" />
                  <p className="whitespace-nowrap text-sm font-bold leading-5 text-amber-700 dark:text-amber-400">{compactionCount}</p>
                </div>
                <p className="text-[9px] leading-3 text-muted-foreground">Compactions</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Main content: Conversation + Right rail. Stacks on narrower viewports so the rail never falls off-screen. */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_308px] gap-3">
        {/* Conversation */}
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="space-y-3 pb-3">
            <SessionViewTabs
              view={mainView}
              onChange={setMainView}
              conversationCount={messages.length}
              diffSummary={diffSummary}
              diffMode={diffMode}
              onDiffModeChange={setDiffMode}
              copiedPatchKey={copiedPatchKey}
              onCopyPatch={handleCopyPatch}
            />
            {mainView === 'conversation' && (
              <FilterPresets preset={preset} onChange={handlePresetChange} counts={presetCounts} />
            )}
          </CardHeader>
          <CardContent className="pt-0">
            {mainView === 'conversation' ? (
              <div className="flex gap-3">
                {/* Conversation column — internal scroll keeps minimap aligned */}
                <div ref={conversationRef} data-testid="conversation-scroll-viewer" className="flex-1 min-w-0 max-h-[78vh] overflow-y-auto pr-2 space-y-2">
                  {groupedMessages.map((group, gi) => {
                    if (group.type === 'compaction') {
                      return <CompactionDivider key={`c-${group.index}-${group.timestamp}`} timestamp={group.timestamp} targetId={group.targetId} />;
                    }
                    if (group.type === 'user') {
                      return <UserMessage key={`u-${gi}`} msg={group.message} index={group.index} />;
                    }
                    if (group.type === 'assistant') {
                      return (
                        <AssistantCard
                          key={`a-${gi}`}
                          msg={group.message}
                          index={group.index}
                          toolPairs={group.toolPairs}
                          toolTimeline={group.toolTimeline}
                        />
                      );
                    }
                    if (group.type === 'system-group') {
                      return <SystemGroup key={`s-${gi}`} messages={group.messages} />;
                    }
                    return null;
                  })}
                </div>

                {/* Minimap */}
                <Minimap
                  segments={minimapSegments}
                  viewport={minimapViewport}
                  onJump={(targetId) => {
                    scrollElementIntoConversation(targetId, 'start');
                  }}
                />
              </div>
            ) : (
              <ChangesView
                summary={diffSummary}
                selectedPath={effectiveSelectedDiffPath}
                mode={diffMode}
                copiedPatchKey={copiedPatchKey}
                onSelectPath={setSelectedDiffPath}
                onCopyPatch={handleCopyPatch}
                onJumpToMessage={handleJumpToDiffMessage}
                projectRoot={session.cwd || undefined}
              />
            )}
          </CardContent>
        </Card>

        {/* Right rail */}
        <div className="space-y-2">
          {/* Context window meter */}
          <ContextWindowMeter session={session} messages={messages} />

          {/* Files in context */}
          <ContextFilesPanel
            contextFiles={contextFiles}
            copiedPath={copiedContextPath}
            onCopyPath={handleCopyContextPath}
            onJumpToMessage={handleJumpToMessage}
            hasDiffForPath={hasDiffForPath}
            onOpenDiff={handleOpenDiffForPath}
          />

          {/* Tools Used */}
          {topTools.length > 0 && (
            <Card className="border-border/50 shadow-sm py-0 gap-0">
              <CardHeader className="px-3 pt-3 pb-2.5">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">Tools Used</CardTitle>
                  {toolFilter && (
                    <button
                      onClick={() => setToolFilter(null)}
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      Clear filter
                    </button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 space-y-1.5">
                {topTools.map(([tool, count]) => {
                  const maxCount = topTools[0][1];
                  const barWidth = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  const isActive = toolFilter === tool;
                  return (
                    <button
                      key={tool}
                      onClick={() => setToolFilter(isActive ? null : tool)}
                      className={`relative flex items-center justify-between py-0.5 w-full text-left rounded-sm transition-colors ${isActive ? 'ring-1 ring-blue-500/50' : 'hover:bg-muted/20'}`}
                    >
                      <div className="absolute inset-0 rounded-sm bg-muted/40" style={{ width: `${barWidth}%` }} />
                      <span className="relative text-xs font-mono truncate max-w-[150px] pl-1.5">{tool}</span>
                      <span className="relative text-[11px] font-mono text-muted-foreground pr-1.5">{count}</span>
                    </button>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Compaction */}
          {compactionCount > 0 && (
            <Card className="border-amber-300/50 bg-amber-50/30 dark:bg-amber-950/10 shadow-sm py-0 gap-0">
              <CardHeader className="px-3 pt-3 pb-2.5">
                <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                  <Minimize2 className="h-3.5 w-3.5" />
                  Context Compaction
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Full Compactions</span>
                  <span className="font-bold">{compaction.compactions}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Micro-compactions</span>
                  <span className="font-bold">{compaction.microcompactions}</span>
                </div>
                {compaction.totalTokensSaved > 0 && (
                  <>
                    <Separator />
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Tokens Saved</span>
                      <span className="font-bold text-green-600">{formatTokens(compaction.totalTokensSaved)}</span>
                    </div>
                  </>
                )}
                {(compaction.compactionTimestamps || []).length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted-foreground font-medium">Timeline</span>
                      {compaction.compactionTimestamps.map((ts, i) => (
                        <div key={i} className="text-[10px] text-muted-foreground font-mono">
                          {format(new Date(ts), 'h:mm:ss a')}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Metadata */}
          <Card className="border-border/50 shadow-sm py-0 gap-0">
            <CardHeader className="px-3 pt-3 pb-2.5">
              <CardTitle className="text-sm font-semibold">Metadata</CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3 pt-0 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Version</span>
                <span className="font-mono">{session.version}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Project</span>
                <span className="font-medium truncate max-w-[120px]">{session.projectName}</span>
              </div>
              {session.gitBranch && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Branch</span>
                  <span className="font-mono truncate max-w-[120px]">{session.gitBranch}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      </div>
      <ArtifactFullscreenViewer artifact={artifactViewer} onClose={() => setArtifactViewer(null)} />
    </SessionRenderContext.Provider>
  );
}
