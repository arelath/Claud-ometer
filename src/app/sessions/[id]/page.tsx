'use client';

import { createContext, use, useState, useCallback, useMemo, useRef, useEffect, useContext } from 'react';
import { useSessionDetail } from '@/lib/hooks';
import { useCostMode } from '@/lib/cost-mode-context';
import { getModelDisplayName } from '@/config/pricing';
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
  AlertCircle, Maximize2, X,
} from 'lucide-react';
import Link from 'next/link';
import { format } from 'date-fns';

// ---------------------------------------------------------------------------
// Filter presets
// ---------------------------------------------------------------------------

type FilterPreset = 'narrative' | 'tools' | 'all';

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

function messagePassesPreset(msg: SessionMessageDisplay, preset: FilterPreset): boolean {
  if (preset === 'all') return true;
  if (preset === 'tools') {
    return msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool-use' || msg.role === 'tool-result' || msg.role === 'command';
  }
  // narrative — User + Assistant only
  return msg.role === 'user' || msg.role === 'assistant';
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

function hasVisibleAssistantContent(message: SessionMessageDisplay): boolean {
  if (message.content.trim()) return true;
  if ((message.toolCalls || []).length > 0) return true;
  return (message.blocks || []).some(block => {
    if (block.type === 'thinking') return Boolean(block.summary || block.content);
    return Boolean(block.summary || block.content || block.details.length > 0);
  });
}

function mergeTokenUsage(usages: Array<SessionMessageDisplay['usage']>): SessionMessageDisplay['usage'] {
  const present = usages.filter((usage): usage is NonNullable<SessionMessageDisplay['usage']> => Boolean(usage));
  if (present.length === 0) return undefined;

  return {
    input_tokens: present.reduce((sum, usage) => sum + (usage.input_tokens || 0), 0),
    output_tokens: present.reduce((sum, usage) => sum + (usage.output_tokens || 0), 0),
    cache_creation_input_tokens: present.reduce((sum, usage) => sum + (usage.cache_creation_input_tokens || 0), 0),
    cache_read_input_tokens: present.reduce((sum, usage) => sum + (usage.cache_read_input_tokens || 0), 0),
    cache_creation: {
      ephemeral_5m_input_tokens: present.reduce((sum, usage) => sum + (usage.cache_creation?.ephemeral_5m_input_tokens || 0), 0),
      ephemeral_1h_input_tokens: present.reduce((sum, usage) => sum + (usage.cache_creation?.ephemeral_1h_input_tokens || 0), 0),
    },
    service_tier: present[present.length - 1]?.service_tier,
  };
}

function mergeAssistantRun(run: { message: SessionMessageDisplay; index: number }[]): SessionMessageDisplay | null {
  const visibleMessages = run.filter(({ message }) => hasVisibleAssistantContent(message));
  if (visibleMessages.length === 0) return null;

  const first = run[0].message;
  const lastVisible = visibleMessages[visibleMessages.length - 1].message;
  const content = visibleMessages
    .map(({ message }) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const toolCalls = visibleMessages.flatMap(({ message }) => message.toolCalls || []);
  const blocks = visibleMessages.flatMap(({ message }) => message.blocks || []);

  return {
    role: 'assistant',
    content,
    timestamp: lastVisible.timestamp || first.timestamp,
    model: lastVisible.model || first.model,
    usage: mergeTokenUsage(run.map(({ message }) => message.usage)),
    promptBreakdown: lastVisible.promptBreakdown,
    stopReason: lastVisible.stopReason || first.stopReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    blocks: blocks.length > 0 ? blocks : undefined,
    isMeta: run.some(({ message }) => Boolean(message.isMeta)),
  };
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
      { key: 'files', label: 'Files', value: session.totalCacheReadTokens, color: '#BA7517' },
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

const CONTEXT_FILE_DETAIL_KEYS = ['content.file.filePath', 'filePath', 'file_path', 'path', 'displayPath', 'filename'];
const CONTEXT_LOADED_LINE_DETAIL_KEYS = ['content.file.numLines', 'numLines'];
const CONTEXT_TOTAL_LINE_DETAIL_KEYS = ['content.file.totalLines', 'totalLines'];

type ContextFileKind = 'in-context' | 'referenced';
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

interface ContextFileInfo {
  fullPath: string;
  fileName: string;
  kind: ContextFileKind;
  attached: boolean;
  firstMessageIndex: number;
  messageIndexes: number[];
  loadedLines?: string;
  totalLines?: string;
}

interface ContextFileGroups {
  inContext: ContextFileInfo[];
  referenced: ContextFileInfo[];
}

function isLikelyFilePath(value: string): boolean {
  if (!value || value === '[]' || value === '""') return false;
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,12}$/.test(value);
}

function isBasenameOnly(value: string): boolean {
  return !/[\\/]/.test(value);
}

function getFileBasename(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function parseCount(value?: string): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, '').trim();
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
}

function chooseBetterCount(current?: string, candidate?: string): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentCount = parseCount(current);
  const candidateCount = parseCount(candidate);
  if (currentCount == null || candidateCount == null) return current;
  return candidateCount > currentCount ? candidate : current;
}

function chooseBetterPath(current: string, candidate: string): string {
  if (isBasenameOnly(current) && !isBasenameOnly(candidate)) return candidate;
  return current;
}

function sortContextFiles(files: ContextFileInfo[]): ContextFileInfo[] {
  return [...files].sort((left, right) => {
    const nameCompare = left.fileName.localeCompare(right.fileName);
    if (nameCompare !== 0) return nameCompare;
    return left.fullPath.localeCompare(right.fullPath);
  });
}

function getContextFileGroups(messages: SessionMessageDisplay[]): ContextFileGroups {
  const files = new Map<string, ContextFileInfo>();

  const upsertCandidate = (rawValue: string | undefined, next: Omit<ContextFileInfo, 'fullPath' | 'fileName'>) => {
    if (!rawValue) return;
    let candidate = rawValue.replace(/\r?\n/g, ' ').trim();
    if (!isLikelyFilePath(candidate)) return;

    let mapKey = candidate.toLowerCase();
    let existing = files.get(mapKey);

    if (!existing) {
      for (const [existingKey, existingValue] of files.entries()) {
        if (getFileBasename(existingValue.fullPath).toLowerCase() !== getFileBasename(candidate).toLowerCase()) continue;
        if (isBasenameOnly(existingValue.fullPath) && !isBasenameOnly(candidate)) {
          existing = existingValue;
          mapKey = existingKey;
          break;
        }
        if (!isBasenameOnly(existingValue.fullPath) && isBasenameOnly(candidate)) {
          existing = existingValue;
          mapKey = existingKey;
          candidate = existingValue.fullPath;
          break;
        }
      }
    }

    const fullPath = existing ? chooseBetterPath(existing.fullPath, candidate) : candidate;
    const merged: ContextFileInfo = {
      fullPath,
      fileName: getFileBasename(fullPath),
      kind: existing?.kind === 'in-context' || next.kind === 'in-context' ? 'in-context' : 'referenced',
      attached: Boolean(existing?.attached || next.attached),
      firstMessageIndex: Math.min(existing?.firstMessageIndex ?? next.firstMessageIndex, next.firstMessageIndex),
      messageIndexes: Array.from(new Set([...(existing?.messageIndexes || []), ...next.messageIndexes])).sort((left, right) => left - right),
      loadedLines: chooseBetterCount(existing?.loadedLines, next.loadedLines),
      totalLines: chooseBetterCount(existing?.totalLines, next.totalLines),
    };

    files.delete(mapKey);
    files.set(fullPath.toLowerCase(), merged);
  };

  messages.forEach((message, messageIndex) => {
    for (const block of message.blocks || []) {
      const fileDetail = findPreferredDetail(block.details, CONTEXT_FILE_DETAIL_KEYS);
      if (!fileDetail) continue;

      const loadedLines = findPreferredDetail(block.details, CONTEXT_LOADED_LINE_DETAIL_KEYS)?.value;
      const totalLines = findPreferredDetail(block.details, CONTEXT_TOTAL_LINE_DETAIL_KEYS)?.value;
      const attached = block.type === 'event' && block.title.startsWith('Attachment:');
      const inContext = attached || Boolean(block.content) || Boolean(loadedLines) || Boolean(totalLines);

      upsertCandidate(fileDetail.value, {
        kind: inContext ? 'in-context' : 'referenced',
        attached,
        firstMessageIndex: messageIndex,
        messageIndexes: [messageIndex],
        loadedLines,
        totalLines,
      });
    }
  });

  const allFiles = Array.from(files.values());
  return {
    inContext: sortContextFiles(allFiles.filter(file => file.kind === 'in-context')),
    referenced: sortContextFiles(allFiles.filter(file => file.kind === 'referenced')),
  };
}

// ---------------------------------------------------------------------------
// Grouped message types for the new design
// ---------------------------------------------------------------------------

type GroupedItem =
  | { type: 'user'; message: SessionMessageDisplay; index: number }
  | { type: 'assistant'; message: SessionMessageDisplay; index: number; toolPairs: ToolPair[] }
  | { type: 'system-group'; messages: { message: SessionMessageDisplay; index: number }[] };

interface ToolPair {
  toolUse?: { message: SessionMessageDisplay; index: number };
  toolResult?: { message: SessionMessageDisplay; index: number };
}

/** Group messages: pair tool-use/tool-result with their parent assistant, collapse consecutive system messages, merge consecutive empty assistant turns */
function groupMessages(items: { message: SessionMessageDisplay; index: number }[]): GroupedItem[] {
  const groups: GroupedItem[] = [];
  let i = 0;

  while (i < items.length) {
    const { message, index } = items[i];

    if (message.role === 'user') {
      groups.push({ type: 'user', message, index });
      i++;
    } else if (message.role === 'assistant') {
      const assistantRun = [{ message, index }];
      let j = i + 1;
      while (j < items.length && items[j].message.role === 'assistant') {
        assistantRun.push(items[j]);
        j++;
      }

      // Collect following tool-use/tool-result pairs
      const toolPairs: ToolPair[] = [];
      while (j < items.length) {
        const next = items[j];
        if (next.message.role === 'tool-use') {
          const pair: ToolPair = { toolUse: next };
          j++;
          // Look for immediately following tool-result
          if (j < items.length && items[j].message.role === 'tool-result') {
            pair.toolResult = items[j];
            j++;
          }
          toolPairs.push(pair);
        } else if (next.message.role === 'tool-result') {
          // Orphaned tool-result
          toolPairs.push({ toolResult: next });
          j++;
        } else {
          break;
        }
      }

      const mergedMessage = mergeAssistantRun(assistantRun);
      if (!mergedMessage && toolPairs.length === 0) {
        i = j;
        continue;
      }

      groups.push({
        type: 'assistant',
        message: mergedMessage || {
          role: 'assistant',
          content: '',
          timestamp: assistantRun[assistantRun.length - 1].message.timestamp,
          model: assistantRun[assistantRun.length - 1].message.model,
          usage: mergeTokenUsage(assistantRun.map(({ message: runMessage }) => runMessage.usage)),
          stopReason: assistantRun[assistantRun.length - 1].message.stopReason,
          isMeta: assistantRun.some(({ message: runMessage }) => Boolean(runMessage.isMeta)),
        },
        index,
        toolPairs,
      });
      i = j;
    } else if (message.role === 'system' || message.role === 'command') {
      // Collect consecutive system/command messages
      const systemBatch: { message: SessionMessageDisplay; index: number }[] = [{ message, index }];
      let j = i + 1;
      while (j < items.length && (items[j].message.role === 'system' || items[j].message.role === 'command')) {
        systemBatch.push(items[j]);
        j++;
      }
      groups.push({ type: 'system-group', messages: systemBatch });
      i = j;
    } else if (message.role === 'tool-use') {
      // Standalone tool-use not following an assistant
      const pair: ToolPair = { toolUse: { message, index } };
      i++;
      if (i < items.length && items[i].message.role === 'tool-result') {
        pair.toolResult = items[i];
        i++;
      }
      groups.push({ type: 'assistant', message: { ...message, role: 'assistant', content: '' }, index, toolPairs: [pair] });
    } else if (message.role === 'tool-result') {
      // Standalone tool-result
      groups.push({ type: 'assistant', message: { ...message, role: 'assistant', content: '' }, index, toolPairs: [{ toolResult: { message, index } }] });
      i++;
    } else {
      i++;
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------

function Minimap({ groups, scrollRatio, onJump }: {
  groups: GroupedItem[];
  scrollRatio: number;
  onJump: (index: number) => void;
}) {
  const totalItems = groups.length;
  if (totalItems === 0) return null;

  const barHeight = 560;
  // Show indicator height proportional to roughly visible viewport, with a sensible minimum
  const indicatorHeightPct = Math.max(100 / Math.max(totalItems, 1) * 3, 6);

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
        className="relative w-3.5 rounded bg-muted/50 border border-border/40 cursor-pointer"
        style={{ height: barHeight }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientY - rect.top) / rect.height;
          const targetGroup = Math.floor(ratio * totalItems);
          const group = groups[Math.min(targetGroup, totalItems - 1)];
          const idx = group.type === 'system-group' ? group.messages[0].index : group.index;
          onJump(idx);
        }}
      >
        {groups.map((group, i) => {
          const top = (i / totalItems) * 100;
          const height = Math.max(100 / totalItems, 1.5);
          let color: string;
          let opacity = 0.7;

          if (group.type === 'user') {
            color = 'rgb(56, 138, 221)';
            opacity = 0.95;
          } else if (group.type === 'assistant') {
            color = 'rgb(186, 117, 23)';
            opacity = 0.85;
          } else {
            color = 'rgb(107, 114, 128)';
            opacity = 0.4;
          }

          return (
            <div
              key={i}
              className="absolute left-0 right-0 rounded-sm"
              style={{ top: `${top}%`, height: `${height}%`, background: color, opacity }}
            />
          );
        })}
        {/* Current viewport indicator — bordered box that follows scroll position */}
        <div
          className="absolute -left-2 -right-2 border-2 border-foreground/80 rounded-sm pointer-events-none transition-[top] duration-75 shadow-md"
          style={{
            top: `calc(${scrollRatio * 100}% - ${(scrollRatio * indicatorHeightPct) / 100}%)`,
            height: `${indicatorHeightPct}%`,
            minHeight: '8px',
            background: 'rgba(255,255,255,0.08)',
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

interface ArtifactViewerState {
  title: string;
  subtitle?: string;
  kind: 'text' | 'diff';
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

function isPathDetailKey(key: string): boolean {
  return detailMatchesKey(key, ['displayPath', 'file_path', 'filePath', 'path', 'paths', 'filename', 'content.file.filePath']);
}

function formatDisplayValue(key: string, value: string, projectRoot?: string): string {
  const normalized = normalizeDisplayNewlines(value);
  if (!isPathDetailKey(key)) return normalized;
  return formatDisplayPath(normalized, projectRoot);
}

function toPreviewLines(value: string): string[] {
  const normalized = normalizeDisplayNewlines(value).replace(/\r\n?/g, '\n');
  return normalized ? normalized.split('\n') : [];
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

function ArtifactPreviewContent({ artifact, maxLines, fullscreen = false }: {
  artifact: ArtifactViewerState;
  maxLines?: number;
  fullscreen?: boolean;
}) {
  const visibleLines = fullscreen ? Number.MAX_SAFE_INTEGER : (maxLines ?? COLLAPSED_PREVIEW_LINES);

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
                {line.text}
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
      <pre className={`whitespace-pre-wrap break-words text-foreground ${fullscreen ? 'font-mono text-sm leading-6' : 'font-mono text-[11px] leading-5'}`}>
        {shownLines.join('\n')}
      </pre>
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
  const totalLines = artifact.kind === 'diff'
    ? buildDiffPreviewLines(artifact.oldText || '', artifact.newText || '', artifact.location).length
    : Math.max(toPreviewLines(artifact.content || '').length, 1);
  const canExpandInline = totalLines > COLLAPSED_PREVIEW_LINES;

  return (
    <div className={`overflow-hidden rounded-md border ${artifact.kind === 'diff' ? 'border-border/50 bg-background/95' : 'border-green-500/20 bg-green-500/[0.02]'} ${className}`}>
      <div className={`flex items-center justify-between gap-2 px-2 py-0.5 ${artifact.kind === 'diff' ? 'border-b border-border/40 bg-muted/25' : 'border-b border-green-500/15 bg-green-500/[0.03]'}`}>
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {canExpandInline && (
            <button
              type="button"
              onClick={() => setExpanded(current => !current)}
              className="rounded border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {expanded ? 'Less' : 'More'}
            </button>
          )}
          <button
            type="button"
            onClick={() => openArtifact(artifact)}
            className="inline-flex items-center gap-1 rounded border border-border/60 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Maximize2 className="h-2.5 w-2.5" />
            Fullscreen
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

  return (
    <div className="fixed inset-0 z-50 bg-black/45 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/60 bg-card px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{artifact.title}</h2>
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

  const previewArtifact = content
    ? {
        title: summaryLabel,
        kind: 'text' as const,
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
        oldText: tool.artifact.oldText,
        newText: tool.artifact.newText,
        location: tool.artifact.location,
      }
    : shouldPreviewCommand && normalizedCommand
      ? {
          title: `${tool.name} command`,
          kind: 'text',
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
    <div className="px-3 py-1.5 text-[13px]">
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
  const blocks = msg.blocks || [];
  if (blocks.length === 0 && !msg.content) return null;

  const hasError = blocks.some(b => b.title.toLowerCase().includes('error'));
  const blockContent = normalizeDisplayNewlines(
    blocks
      .map(block => block.content)
      .filter((content): content is string => Boolean(content))
      .join('\n\n'),
  ).trim();
  const normalizedMessageContent = normalizeDisplayNewlines(msg.content).trim();

  const accent = hasError
    ? 'border-l-2 border-red-500/70 bg-red-500/[0.02]'
    : 'border-l-2 border-green-500/40 bg-transparent';
  const textColor = hasError ? 'text-red-600 dark:text-red-400' : 'text-green-700/80 dark:text-green-500/80';

  // Determine effective content for display
  const effectiveContent = blockContent || normalizedMessageContent;
  const contentLines = effectiveContent ? effectiveContent.split('\n') : [];

  // Short inline output: 1–4 lines, show as plain code block without the heavyweight preview frame
  const isShortOutput = contentLines.length > 0 && contentLines.length <= 4 && effectiveContent.length <= 300;

  if (isShortOutput) {
    return (
      <div className={`${accent} px-3 py-1.5`}>
        <pre className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-5 ${hasError ? 'text-red-600 dark:text-red-400' : 'text-foreground/80'}`}>
          {effectiveContent}
        </pre>
      </div>
    );
  }

  const previewArtifact: ArtifactViewerState | null = blockContent
    ? {
        title: blocks[0]?.title || (hasError ? 'Error output' : 'Tool output'),
        subtitle: normalizedMessageContent && !normalizedMessageContent.includes('\n') ? normalizedMessageContent : undefined,
        kind: 'text',
        content: blockContent,
      }
    : normalizedMessageContent && (normalizedMessageContent.includes('\n') || normalizedMessageContent.length > 120)
      ? {
          title: hasError ? 'Error output' : 'Tool output',
          kind: 'text',
          content: normalizedMessageContent,
        }
      : null;
  const showStatusRow = Boolean(previewArtifact && normalizedMessageContent && !normalizedMessageContent.includes('\n') && normalizedMessageContent !== blockContent);

  if (!previewArtifact) {
    return (
      <div className={`flex items-center gap-1.5 px-3 py-1 text-[11px] ${accent}`}>
        {hasError
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
          {hasError
            ? <AlertCircle className={`h-2.5 w-2.5 shrink-0 ${textColor}`} />
            : <Check className={`h-2.5 w-2.5 shrink-0 ${textColor}`} />}
          <span className={`truncate ${textColor}`}>{normalizedMessageContent}</span>
        </div>
      )}
      <ArtifactPreview artifact={previewArtifact} label={hasError ? 'Error output' : 'Output preview'} className="mx-3 mb-1.5 mt-1" />
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
    <div className="border border-dashed border-border/50 rounded bg-muted/20 px-3 py-2 space-y-1">
      <button
        onClick={() => setExpanded(false)}
        className="flex items-center gap-2 w-full text-[10px] text-muted-foreground hover:text-foreground mb-1"
      >
        <span>Collapse {messages.length} system events</span>
        <ChevronDown className="h-3 w-3 ml-auto shrink-0 rotate-180 transition-transform" />
      </button>
      {messages.map(({ message, index }) => (
        <div key={index} id={`conversation-message-${index}`} className="flex items-start gap-2 text-[11px] text-muted-foreground">
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
function AssistantCard({ msg, index, toolPairs }: {
  msg: SessionMessageDisplay;
  index: number;
  toolPairs: ToolPair[];
}) {
  const thinkingBlocks = (msg.blocks || []).filter(b => b.type === 'thinking');
  const eventBlocks = (msg.blocks || []).filter(b => b.type === 'event');

  const modelLabel = msg.model
    ? getModelDisplayName(msg.model)
    : null;

  // Rough per-turn cost estimate
  const turnCost = msg.usage
    ? ((msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0)) * 0.000015 + (msg.usage.output_tokens || 0) * 0.000075
    : 0;

  // Surface a readable summary even when the assistant emitted only tool calls
  const allTools = [
    ...(msg.toolCalls || []),
    ...toolPairs.flatMap(p => p.toolUse?.message.toolCalls || []),
  ];
  const fallbackSummary = (() => {
    if (msg.content) return null;
    const firstThink = thinkingBlocks.find(b => b.summary)?.summary;
    if (firstThink) return firstThink;
    if (allTools.length === 1) {
      const t = allTools[0];
      const path = findDetail(t.details, ['file_path', 'filePath', 'path', 'displayPath'])?.value;
      const cmd = findDetail(t.details, ['command'])?.value;
      const query = findDetail(t.details, ['query'])?.value;
      const arg = path || cmd?.split('\n')[0] || query;
      return arg ? `${t.name} ${arg}` : t.name;
    }
    if (allTools.length > 1) {
      const names = Array.from(new Set(allTools.map(t => t.name))).slice(0, 3).join(', ');
      return `${allTools.length} tool calls · ${names}`;
    }
    return null;
  })();

  return (
    <div id={`conversation-message-${index}`}>
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
      {toolPairs.length > 0 && (
        <div className="ml-4 border-l-2 border-border/50 pl-3 mt-1 space-y-1">
          {toolPairs.map((pair, i) => (
            <div key={i} className="rounded border border-border/30 bg-card/40 overflow-hidden">
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
          ))}
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

function ContextFileRow({ file, onJumpToMessage, copiedPath, onCopyPath }: {
  file: ContextFileInfo;
  onJumpToMessage: (messageIndexes: number[]) => void;
  copiedPath: string | null;
  onCopyPath: (filePath: string) => void;
}) {
  const { projectRoot } = useSessionRenderContext();
  const loadedCount = parseCount(file.loadedLines);
  const totalCount = parseCount(file.totalLines);
  const isCopied = copiedPath === file.fullPath;
  const displayPath = formatDisplayPath(file.fullPath, projectRoot);

  // Truncate from the middle, preserving the basename at the end
  const truncatedPath = (() => {
    if (displayPath.length <= 35) return displayPath;
    const parts = displayPath.replace(/\\/g, '/').split('/');
    if (parts.length <= 2) return displayPath;
    const basename = parts[parts.length - 1];
    const firstDir = parts[0];
    return `${firstDir}/…/${basename}`;
  })();

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

  return (
    <div className="group py-1.5 border-b border-border/30 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onJumpToMessage(file.messageIndexes)}
              className="font-mono text-[11px] text-foreground truncate hover:underline text-left"
            >
              {truncatedPath}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-[300px]">
            <span className="font-mono text-[10px] break-all">{displayPath}</span>
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
          <div className="flex-1 h-1 bg-muted/50 rounded overflow-hidden">
            <div className={`h-full ${barColor} rounded`} style={{ width: `${fillPct}%` }} />
          </div>
          <span className={`w-[86px] shrink-0 text-right font-mono tabular-nums text-[10px] whitespace-nowrap ${lineColor}`}>{lineSummary}</span>
        </div>
      )}
    </div>
  );
}

function ContextFilesPanel({ contextFiles, copiedPath, onCopyPath, onJumpToMessage }: {
  contextFiles: ContextFileGroups;
  copiedPath: string | null;
  onCopyPath: (filePath: string) => void;
  onJumpToMessage: (messageIndexes: number[]) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const allFiles = [...contextFiles.inContext, ...contextFiles.referenced];
  const totalCount = allFiles.length;

  if (totalCount === 0) return null;

  const INITIAL_SHOW = 6;
  const visibleFiles = showAll ? allFiles : allFiles.slice(0, INITIAL_SHOW);
  const remaining = totalCount - INITIAL_SHOW;

  return (
    <Card className="border-border/50 shadow-sm py-0 gap-0">
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-foreground">
            Files in context <span className="text-muted-foreground font-normal">· {totalCount}</span>
          </span>
        </div>
        <div className="max-h-[320px] overflow-y-auto pr-1">
          {visibleFiles.map(file => (
            <ContextFileRow
              key={file.fullPath}
              file={file}
              onJumpToMessage={onJumpToMessage}
              copiedPath={copiedPath}
              onCopyPath={onCopyPath}
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
                const loaded = parseCount(f.loadedLines);
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session, isLoading, error } = useSessionDetail(id);
  const { pickCost } = useCostMode();

  const [preset, setPreset] = useState<FilterPreset>(loadPreset);
  const [copiedContextPath, setCopiedContextPath] = useState<string | null>(null);
  const [scrollRatio, setScrollRatio] = useState(0);
  const [artifactViewer, setArtifactViewer] = useState<ArtifactViewerState | null>(null);
  const [toolFilter, setToolFilter] = useState<string | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  const handlePresetChange = useCallback((next: FilterPreset) => {
    setPreset(next);
    savePreset(next);
  }, []);

  const handleJumpToMessage = useCallback((messageIndexes: number[]) => {
    for (const messageIndex of messageIndexes) {
      const element = document.getElementById(`conversation-message-${messageIndex}`);
      if (!element) continue;
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }, []);

  const handleCopyContextPath = useCallback((filePath: string) => {
    void navigator.clipboard.writeText(filePath).then(() => {
      setCopiedContextPath(filePath);
      window.setTimeout(() => {
        setCopiedContextPath(current => (current === filePath ? null : current));
      }, 1200);
    });
  }, []);

  // Scroll tracking for minimap
  useEffect(() => {
    const container = conversationRef.current;
    if (!container) return;
    const handleScroll = () => {
      const maxScroll = container.scrollHeight - container.clientHeight;
      if (maxScroll <= 0) return;
      setScrollRatio(container.scrollTop / maxScroll);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [session]);

  const messages = useMemo(() => session?.messages || [], [session]);

  const groupedMessages = useMemo(
    () => {
      const groups = groupMessages(
        messages.map((message, index) => ({ message, index })).filter(({ message }) => messagePassesPreset(message, preset)),
      );
      if (!toolFilter) return groups;
      // When a tool filter is active, only show assistant turns that include that tool
      return groups.filter(group => {
        if (group.type === 'user') return true;
        if (group.type === 'system-group') return false;
        if (group.type === 'assistant') {
          const inlineTools = group.message.toolCalls || [];
          const pairedTools = group.toolPairs.flatMap(p => p.toolUse?.message.toolCalls || []);
          return [...inlineTools, ...pairedTools].some(t => t.name === toolFilter);
        }
        return true;
      });
    },
    [messages, preset, toolFilter],
  );

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
  const compaction = session.compaction || { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] };
  const compactionCount = compaction.compactions + compaction.microcompactions;
  const sessionRenderContext: SessionRenderContextValue = {
    projectRoot: session.cwd || undefined,
    openArtifact: setArtifactViewer,
  };

  return (
    <SessionRenderContext.Provider value={sessionRenderContext}>
      <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/sessions" className="rounded-lg border border-border p-1.5 hover:bg-accent transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight">{session.projectName}</h1>
            {models.map(m => <Badge key={m} variant="secondary" className="text-xs">{m}</Badge>)}
            <Pill
              value={compactionCount > 0 ? 'compacted' : 'completed'}
              tone={compactionCount > 0 ? 'warn' : 'good'}
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
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

      {/* Stats row — cost-led when there's spend, compaction card only if > 0 */}
      <div className={`grid gap-3 ${compactionCount > 0 ? 'grid-cols-6' : 'grid-cols-5'}`}>
        <Card className="border-primary/30 bg-primary/5 shadow-sm">
          <CardContent className="p-3 text-center">
            <Coins className="h-3.5 w-3.5 mx-auto mb-1 text-primary" />
            <p className="text-lg font-bold text-primary">{formatCost(pickCost(session.estimatedCosts, session.estimatedCost))}</p>
            <p className="text-[10px] text-muted-foreground">Est. Usage</p>
          </CardContent>
        </Card>
        <Card className="border-border/50 shadow-sm">
          <CardContent className="p-3 text-center">
            <Clock className="h-3.5 w-3.5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold">{formatDuration(session.duration)}</p>
            <p className="text-[10px] text-muted-foreground">Duration</p>
          </CardContent>
        </Card>
        <Card className="border-border/50 shadow-sm">
          <CardContent className="p-3 text-center">
            <MessageSquare className="h-3.5 w-3.5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold">{session.messageCount}</p>
            <p className="text-[10px] text-muted-foreground">Messages</p>
          </CardContent>
        </Card>
        <Card className="border-border/50 shadow-sm">
          <CardContent className="p-3 text-center">
            <Wrench className="h-3.5 w-3.5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold">{session.toolCallCount}</p>
            <p className="text-[10px] text-muted-foreground">Tool Calls</p>
          </CardContent>
        </Card>
        <Card className="border-border/50 shadow-sm">
          <CardContent className="p-3 text-center">
            <Activity className="h-3.5 w-3.5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold">{formatTokens(session.totalInputTokens + session.totalOutputTokens)}</p>
            <p className="text-[10px] text-muted-foreground">Tokens</p>
          </CardContent>
        </Card>
        {compactionCount > 0 && (
          <Card className="border-amber-300/50 bg-amber-50/30 dark:bg-amber-950/10 shadow-sm">
            <CardContent className="p-3 text-center">
              <Minimize2 className="h-3.5 w-3.5 mx-auto mb-1 text-amber-600" />
              <p className="text-lg font-bold text-amber-700 dark:text-amber-400">{compactionCount}</p>
              <p className="text-[10px] text-muted-foreground">Compactions</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Main content: Conversation + Right rail. Stacks on narrower viewports so the rail never falls off-screen. */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_308px] gap-3">
        {/* Conversation */}
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="border-b border-border/60 pb-3">
            <FilterPresets preset={preset} onChange={handlePresetChange} counts={presetCounts} />
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex gap-3">
              {/* Conversation column — internal scroll keeps minimap aligned */}
              <div ref={conversationRef} className="flex-1 min-w-0 max-h-[78vh] overflow-y-auto pr-2 space-y-2">
                {groupedMessages.map((group, gi) => {
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
                groups={groupedMessages}
                scrollRatio={scrollRatio}
                onJump={(idx) => {
                  const el = document.getElementById(`conversation-message-${idx}`);
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              />
            </div>
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
