'use client';

import { use, useState, useCallback } from 'react';
import { useSessionDetail } from '@/lib/hooks';
import { useCostMode } from '@/lib/cost-mode-context';
import { formatCost, formatDuration, formatTokens } from '@/lib/format';
import type { SessionMessageBlockDisplay, SessionMessageDisplay, SessionToolCallDisplay, TokenUsage } from '@/lib/claude-data/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ArrowLeft, Clock, GitBranch, MessageSquare, Wrench,
  User, Bot, Coins, Activity, Minimize2, Brain, FileText, Info,
  Filter, Terminal, ArrowDownToLine, ArrowUpFromLine, Copy, Check, Paperclip,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { format } from 'date-fns';

// ---------------------------------------------------------------------------
// Filter persistence
// ---------------------------------------------------------------------------

const FILTER_STORAGE_KEY = 'claud-ometer-session-filters';

interface SessionFilters {
  showUser: boolean;
  showAssistant: boolean;
  showSystem: boolean;
  showMeta: boolean;
  showToolUse: boolean;
  showToolResult: boolean;
  showCommand: boolean;
}

const DEFAULT_FILTERS: SessionFilters = {
  showUser: true,
  showAssistant: true,
  showSystem: false,
  showMeta: false,
  showToolUse: true,
  showToolResult: true,
  showCommand: true,
};

function loadFilters(): SessionFilters {
  if (typeof window === 'undefined') return DEFAULT_FILTERS;
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveFilters(filters: SessionFilters): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
}

function messagePassesFilter(msg: SessionMessageDisplay, filters: SessionFilters): boolean {
  if (msg.role === 'user') return filters.showUser;
  if (msg.role === 'assistant') return filters.showAssistant;
  if (msg.role === 'tool-use') return filters.showToolUse;
  if (msg.role === 'tool-result') return filters.showToolResult;
  if (msg.role === 'command') return filters.showCommand;
  if (msg.role === 'system') {
    if (msg.isMeta) return filters.showMeta;
    return filters.showSystem;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function getToolCallListSummary(toolCalls: SessionToolCallDisplay[]): string {
  return toolCalls
    .slice(0, 3)
    .map(tool => (tool.summary && tool.summary !== tool.name ? `${tool.name}: ${tool.summary}` : tool.name))
    .join(' · ');
}

function getBlockListSummary(blocks: SessionMessageBlockDisplay[]): string {
  return blocks
    .slice(0, 2)
    .map(block => (block.summary && block.summary !== block.title ? `${block.title}: ${block.summary}` : block.title))
    .join(' · ');
}

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

function getMessageTotalTokens(usage?: TokenUsage): number {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.output_tokens || 0) +
    (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
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

const CONTEXT_FILE_DETAIL_KEYS = ['content.file.filePath', 'filePath', 'file_path', 'path', 'displayPath', 'filename'];
const CONTEXT_LOADED_LINE_DETAIL_KEYS = ['content.file.numLines', 'numLines'];
const CONTEXT_TOTAL_LINE_DETAIL_KEYS = ['content.file.totalLines', 'totalLines'];

type ContextFileKind = 'in-context' | 'referenced';

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

function getContextLineSummary(file: ContextFileInfo): string | null {
  if (file.loadedLines && file.totalLines) {
    const loadedCount = parseCount(file.loadedLines);
    const totalCount = parseCount(file.totalLines);
    if (loadedCount != null && totalCount != null && loadedCount !== totalCount) {
      return `${file.loadedLines}/${file.totalLines} ln`;
    }
    return `${file.totalLines} ln`;
  }

  if (file.totalLines) return `${file.totalLines} ln`;
  if (file.loadedLines) return `${file.loadedLines} ln`;
  return null;
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
    good: 'border-green-200/70 bg-green-50/70 text-green-700',
    warn: 'border-amber-200/70 bg-amber-50/70 text-amber-700',
    danger: 'border-red-200/70 bg-red-50/70 text-red-700',
  };
  return (
    <span className={`inline-flex rounded-full border px-1.5 py-0 text-[10px] leading-4 ${cls[tone]} ${mono ? 'font-mono' : ''}`}>
      {value}
    </span>
  );
}

/** Expandable detail panel. `shownKeys` lists keys already visible in the parent — they won't repeat. */
function DetailPanel({ details, content, shownKeys = [], summaryLabel = 'details' }: {
  details: SessionToolCallDisplay['details'];
  content?: string;
  shownKeys?: string[];
  summaryLabel?: string;
}) {
  const filtered = details.filter(d => !shownKeys.some(k => detailMatchesKey(d.key, [k])));
  if (filtered.length === 0 && !content) return null;

  return (
    <details className="mt-1 rounded border border-border/40 bg-muted/10">
      <summary className="cursor-pointer px-2 py-0.5 text-[10px] text-muted-foreground">
        {summaryLabel}{filtered.length > 0 && ` (${filtered.length})`}{content ? ' + preview' : ''}
      </summary>
      <div className="border-t border-border/30 px-2 py-1.5 space-y-1">
        {filtered.map((d, idx) => (
          <div key={`${d.key}-${d.value}-${idx}`} className="grid grid-cols-[80px_1fr] gap-1.5 text-[11px]">
            <span className="text-muted-foreground truncate">{d.label}</span>
            <span className={`break-words ${usesMonospaceDetail(d.key) ? 'font-mono text-[10px]' : ''}`}>{d.value}</span>
          </div>
        ))}
        {content && (
          <pre className="mt-1 rounded bg-background/80 p-1.5 text-[10px] whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {content}
          </pre>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Tool call compact cards
// ---------------------------------------------------------------------------

function ToolCallCard({ tool }: { tool: SessionToolCallDisplay }) {
  const command = findDetail(tool.details, ['command']);
  const query = findDetail(tool.details, ['query']);
  const filePath = findDetail(tool.details, ['file_path', 'filePath', 'path']);

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
  } else if (query) {
    primary = query.value;
    shownKeys.push('query');
    const inc = findDetail(tool.details, ['includePattern']);
    if (inc) { pills.push({ value: `in ${inc.value}`, mono: true }); shownKeys.push('includePattern'); }
  } else if (filePath) {
    primary = filePath.value;
    shownKeys.push('file_path', 'filePath', 'path');
    const sl = findDetail(tool.details, ['startLine']);
    const el = findDetail(tool.details, ['endLine']);
    if (sl || el) { pills.push({ value: `L${sl?.value || '?'}–${el?.value || '?'}`, mono: true }); shownKeys.push('startLine', 'endLine'); }
    const content = findDetail(tool.details, ['content', 'file_text']);
    const oldStr = findDetail(tool.details, ['old_string']);
    if (content) { pills.push({ value: content.value }); shownKeys.push('content', 'file_text'); }
    if (oldStr) { pills.push({ value: `edit ${oldStr.value}` }); shownKeys.push('old_string', 'new_string'); }
  } else {
    primary = tool.summary !== tool.name ? tool.summary : undefined;
  }

  const remainingDetails = omitDetails(tool.details, shownKeys);

  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-0.5">
      <Badge variant="outline" className="shrink-0 text-[10px] px-1 py-0 font-mono leading-4">{tool.name}</Badge>
      {primary && <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80 max-w-[50%]">{primary}</span>}
      {pills.map((p, i) => <Pill key={i} value={p.value} mono={p.mono} tone={p.tone} />)}
      <DetailPanel details={remainingDetails} shownKeys={shownKeys} />
    </div>
  );
}

function ToolCallSection({ toolCalls }: { toolCalls: SessionToolCallDisplay[] }) {
  if (toolCalls.length === 0) return null;
  return (
    <details className="mt-1 rounded-md border border-border/50 bg-muted/10">
      <summary className="cursor-pointer px-2 py-1 text-[11px] font-medium flex items-center gap-1">
        <Wrench className="h-3 w-3 text-muted-foreground" />
        {toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'}
        <span className="ml-1 text-[10px] font-normal text-muted-foreground truncate">
          {getToolCallListSummary(toolCalls)}
        </span>
      </summary>
      <div className="border-t border-border/40 px-2 py-1 space-y-0">
        {toolCalls.map((tool, i) => <ToolCallCard key={tool.id || i} tool={tool} />)}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Block cards (thinking, tool-result, event)
// ---------------------------------------------------------------------------

function BlockCard({ block }: { block: SessionMessageBlockDisplay }) {
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
    const sig = findDetail(block.details, ['signature']);
    if (sig) pills.push({ value: 'sig', tone: 'warn' });
    const remainingDetails = omitDetails(block.details, shownKeys);
    return (
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-0.5">
        <Badge variant="outline" className="shrink-0 text-[10px] px-1 py-0 leading-4">Think</Badge>
        <span className="text-[11px] text-muted-foreground truncate max-w-[60%]">{block.summary}</span>
        {pills.map((p, i) => <Pill key={i} {...p} />)}
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
    const lines = findDetail(block.details, ['numLines']);
    if (lines) { pills.push({ value: `${lines.value} ln`, mono: true }); shownKeys.push('numLines'); }
  } else if (query) {
    primary = query.value;
    shownKeys.push('query');
    const matches = findDetail(block.details, ['matches']);
    if (matches) { pills.push({ value: `${matches.value} matches` }); shownKeys.push('matches'); }
  }

  const remainingDetails = omitDetails(block.details, shownKeys);
  const isMono = Boolean(command || filePath || query);

  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-0.5">
      <Badge variant="outline" className="shrink-0 text-[10px] px-1 py-0 leading-4">{block.title}</Badge>
      <span className={`min-w-0 truncate text-[11px] max-w-[50%] ${isMono ? 'font-mono' : ''} text-foreground/80`}>
        {primary}
      </span>
      {pills.map((p, i) => <Pill key={i} {...p} />)}
      <DetailPanel details={remainingDetails} content={block.content} shownKeys={shownKeys} />
    </div>
  );
}

function BlockSection({ blocks, icon: Icon, label }: {
  blocks: SessionMessageBlockDisplay[];
  icon: LucideIcon;
  label: string;
}) {
  if (blocks.length === 0) return null;
  return (
    <details className="mt-1 rounded-md border border-border/50 bg-muted/10">
      <summary className="cursor-pointer px-2 py-1 text-[11px] font-medium flex items-center gap-1">
        <Icon className="h-3 w-3 text-muted-foreground" />
        {blocks.length} {label}
        <span className="ml-1 text-[10px] font-normal text-muted-foreground truncate">
          {getBlockListSummary(blocks)}
        </span>
      </summary>
      <div className="border-t border-border/40 px-2 py-1 space-y-0">
        {blocks.map((block, i) => <BlockCard key={`${block.type}-${i}`} block={block} />)}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Filter Panel
// ---------------------------------------------------------------------------

function FilterPanel({ filters, onChange }: { filters: SessionFilters; onChange: (f: SessionFilters) => void }) {
  const toggle = (key: keyof SessionFilters) => {
    const next = { ...filters, [key]: !filters[key] };
    onChange(next);
  };

  const items: { key: keyof SessionFilters; label: string; icon: LucideIcon }[] = [
    { key: 'showUser', label: 'User', icon: User },
    { key: 'showAssistant', label: 'Assistant', icon: Bot },
    { key: 'showToolUse', label: 'Tool Use', icon: ArrowUpFromLine },
    { key: 'showToolResult', label: 'Tool Result', icon: ArrowDownToLine },
    { key: 'showCommand', label: 'Commands', icon: Terminal },
    { key: 'showSystem', label: 'System', icon: Info },
    { key: 'showMeta', label: 'Meta', icon: Activity },
  ];

  return (
    <div className="flex items-center gap-1">
      <Filter className="h-3 w-3 text-muted-foreground" />
      {items.map(({ key, label, icon: ItemIcon }) => (
        <button
          key={key}
          onClick={() => toggle(key)}
          className={`flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors ${
            filters[key]
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'border-border/60 bg-muted/30 text-muted-foreground line-through'
          }`}
        >
          <ItemIcon className="h-2.5 w-2.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function ContextFileItem({
  file,
  copiedPath,
  onCopyPath,
  onJumpToMessage,
}: {
  file: ContextFileInfo;
  copiedPath: string | null;
  onCopyPath: (filePath: string) => void;
  onJumpToMessage: (messageIndexes: number[]) => void;
}) {
  const lineSummary = getContextLineSummary(file);
  const isCopied = copiedPath === file.fullPath;

  return (
    <div className="group rounded border border-border/40 bg-muted/10 px-2 py-1.5 transition-colors hover:bg-muted/20">
      <div className="flex items-start gap-1.5">
        <FileText className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex items-center gap-1.5">
              {file.attached && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 text-amber-600/80">
                      <Paperclip className="h-3 w-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">Attached</TooltipContent>
                </Tooltip>
              )}
              <button
                type="button"
                onClick={() => onJumpToMessage(file.messageIndexes)}
                className="truncate text-left text-xs font-mono font-medium text-foreground/90 hover:underline"
              >
                {file.fileName}
              </button>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {lineSummary && (
                <span className="rounded-full border border-border/50 bg-background/80 px-1.5 py-0 text-[10px] leading-4 text-muted-foreground">
                  {lineSummary}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onCopyPath(file.fullPath)}
                    aria-label={`Copy full path for ${file.fileName}`}
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background/80 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{isCopied ? 'Copied' : 'Copy path'}</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="truncate text-[10px] font-mono text-muted-foreground">{file.fullPath}</div>
        </div>
      </div>
    </div>
  );
}

function ContextFileSection({
  title,
  files,
  copiedPath,
  onCopyPath,
  onJumpToMessage,
}: {
  title: string;
  files: ContextFileInfo[];
  copiedPath: string | null;
  onCopyPath: (filePath: string) => void;
  onJumpToMessage: (messageIndexes: number[]) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        <span>{title}</span>
        <span>{files.length}</span>
      </div>
      <div className="space-y-1">
        {files.map(file => (
          <ContextFileItem
            key={file.fullPath}
            file={file}
            copiedPath={copiedPath}
            onCopyPath={onCopyPath}
            onJumpToMessage={onJumpToMessage}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message renderers
// ---------------------------------------------------------------------------

/** System/meta messages render as a single line, expandable only if they have blocks. */
function SystemMessageRow({ msg }: { msg: SessionMessageDisplay }) {
  const blocks = msg.blocks || [];
  const eventBlocks = blocks.filter(b => b.type === 'event');
  const hasExpandable = eventBlocks.length > 0;
  const summaryText = eventBlocks.length === 1
    ? (eventBlocks[0].summary !== eventBlocks[0].title ? `${eventBlocks[0].title} — ${eventBlocks[0].summary}` : eventBlocks[0].title)
    : msg.content;

  if (!hasExpandable) {
    return (
      <div className="flex items-center gap-2 px-1 py-0.5 text-[11px] text-muted-foreground">
        <Info className="h-2.5 w-2.5 shrink-0 text-amber-600/70" />
        <span className="truncate">{msg.isMeta ? 'Meta' : 'System'} — {msg.content}</span>
        {msg.timestamp && !isNaN(new Date(msg.timestamp).getTime()) && (
          <span className="ml-auto shrink-0 text-[9px]">{format(new Date(msg.timestamp), 'h:mm:ss a')}</span>
        )}
      </div>
    );
  }

  return (
    <details className="rounded border border-border/30 bg-muted/5">
      <summary className="cursor-pointer flex items-center gap-2 px-1.5 py-0.5 text-[11px] text-muted-foreground">
        <Info className="h-2.5 w-2.5 shrink-0 text-amber-600/70" />
        <span className="truncate">{msg.isMeta ? 'Meta' : 'System'} — {summaryText}</span>
        {msg.timestamp && !isNaN(new Date(msg.timestamp).getTime()) && (
          <span className="ml-auto shrink-0 text-[9px]">{format(new Date(msg.timestamp), 'h:mm:ss a')}</span>
        )}
      </summary>
      <div className="border-t border-border/20 px-2 py-1 space-y-0">
        {eventBlocks.map((block, i) => <BlockCard key={i} block={block} />)}
      </div>
    </details>
  );
}

/** Command messages render as a single compact line. */
function CommandMessageRow({ msg }: { msg: SessionMessageDisplay }) {
  return (
    <div className="flex items-center gap-2 px-1 py-0.5 text-[11px] text-muted-foreground">
      <Terminal className="h-2.5 w-2.5 shrink-0 text-blue-500/70" />
      <span className="truncate font-mono text-foreground/70">{msg.content}</span>
      {msg.timestamp && !isNaN(new Date(msg.timestamp).getTime()) && (
        <span className="ml-auto shrink-0 text-[9px]">{format(new Date(msg.timestamp), 'h:mm:ss a')}</span>
      )}
    </div>
  );
}

/** Tool-use messages (assistant with only tool calls, no text). */
function ToolUseMessage({ msg }: { msg: SessionMessageDisplay }) {
  const toolCalls = msg.toolCalls || [];
  const thinkingBlocks = (msg.blocks || []).filter(b => b.type === 'thinking');

  return (
    <div className="py-1 px-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        <ArrowUpFromLine className="h-2.5 w-2.5 shrink-0 text-violet-500/70" />
        <span className="font-medium text-muted-foreground">{toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'}</span>
        {msg.usage && (
          <span className="text-[9px] text-muted-foreground">
            {formatTokens(getMessageTotalTokens(msg.usage))} tok
          </span>
        )}
        {msg.stopReason && msg.stopReason !== 'tool_use' && <Pill value={`stop: ${msg.stopReason}`} />}
        {msg.timestamp && !isNaN(new Date(msg.timestamp).getTime()) && (
          <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{format(new Date(msg.timestamp), 'h:mm:ss a')}</span>
        )}
      </div>
      {msg.usage && (
        <div className="flex flex-wrap gap-x-2 text-[10px] text-muted-foreground leading-4 justify-end">
          <span>in {formatTokens(msg.usage.input_tokens || 0)}</span>
          <span>out {formatTokens(msg.usage.output_tokens || 0)}</span>
          {(msg.usage.cache_read_input_tokens || 0) > 0 && <span>cache↓ {formatTokens(msg.usage.cache_read_input_tokens || 0)}</span>}
          {(msg.usage.cache_creation_input_tokens || 0) > 0 && <span>cache↑ {formatTokens(msg.usage.cache_creation_input_tokens || 0)}</span>}
        </div>
      )}
      {thinkingBlocks.filter(b => b.summary).map((block, i) => (
        <div key={`think-${i}`} className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground">
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
      <ToolCallSection toolCalls={toolCalls} />
    </div>
  );
}

/** Tool-result messages (user message with only tool results, no text). */
function ToolResultMessage({ msg }: { msg: SessionMessageDisplay }) {
  const blocks = msg.blocks || [];

  return (
    <div className="py-1 px-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        <ArrowDownToLine className="h-2.5 w-2.5 shrink-0 text-emerald-500/70" />
        <span className="font-medium text-muted-foreground">{blocks.length} result{blocks.length === 1 ? '' : 's'}</span>
        {msg.timestamp && !isNaN(new Date(msg.timestamp).getTime()) && (
          <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{format(new Date(msg.timestamp), 'h:mm:ss a')}</span>
        )}
      </div>
      {blocks.length > 0 && <BlockSection blocks={blocks} icon={FileText} label="results" />}
    </div>
  );
}

/** User/assistant messages — full conversation rendering. */
function ConversationMessage({ msg }: { msg: SessionMessageDisplay }) {
  const thinkingBlocks = (msg.blocks || []).filter(b => b.type === 'thinking');
  const resultBlocks = (msg.blocks || []).filter(b => b.type === 'tool-result');
  const eventBlocks = (msg.blocks || []).filter(b => b.type === 'event');

  return (
    <div className="flex gap-2 py-1.5">
      <div className={`mt-0.5 shrink-0 rounded p-1 ${
        msg.role === 'user' ? 'bg-primary/10' : 'bg-muted'
      }`}>
        {msg.role === 'user'
          ? <User className="h-3 w-3 text-primary" />
          : <Bot className="h-3 w-3 text-muted-foreground" />
        }
      </div>
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="font-medium">{msg.role === 'user' ? 'You' : 'Claude'}</span>
          {msg.model && (
            <Badge variant="secondary" className="text-[9px] px-1 py-0 leading-3">
              {msg.model.includes('opus') ? 'Opus' : msg.model.includes('sonnet') ? 'Sonnet' : 'Haiku'}
            </Badge>
          )}
          {msg.usage && (
            <span className="text-[9px] text-muted-foreground">
              {formatTokens(getMessageTotalTokens(msg.usage))} tok
            </span>
          )}
          {msg.stopReason && <Pill value={`stop: ${msg.stopReason}`} />}
          {msg.timestamp && !isNaN(new Date(msg.timestamp).getTime()) && (
            <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{format(new Date(msg.timestamp), 'h:mm:ss a')}</span>
          )}
        </div>

        {/* Usage breakdown */}
        {msg.usage && (
          <div className="flex flex-wrap gap-x-2 text-[10px] text-muted-foreground leading-4 justify-end">
            <span>in {formatTokens(msg.usage.input_tokens || 0)}</span>
            <span>out {formatTokens(msg.usage.output_tokens || 0)}</span>
            {(msg.usage.cache_read_input_tokens || 0) > 0 && <span>cache↓ {formatTokens(msg.usage.cache_read_input_tokens || 0)}</span>}
            {(msg.usage.cache_creation_input_tokens || 0) > 0 && <span>cache↑ {formatTokens(msg.usage.cache_creation_input_tokens || 0)}</span>}
          </div>
        )}

        {/* Message body */}
        {msg.content && (
          <div className="text-sm text-foreground/90 whitespace-pre-wrap break-words leading-relaxed mt-0.5">
            {msg.content}
          </div>
        )}

        {/* Sections */}
        {thinkingBlocks.filter(b => b.summary).map((block, i) => (
          <div key={`think-${i}`} className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground">
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
        {msg.toolCalls && msg.toolCalls.length > 0 && <ToolCallSection toolCalls={msg.toolCalls} />}
        {resultBlocks.length > 0 && <BlockSection blocks={resultBlocks} icon={FileText} label="results" />}
        {eventBlocks.length > 0 && <BlockSection blocks={eventBlocks} icon={Activity} label="events" />}
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

  const [filters, setFilters] = useState<SessionFilters>(loadFilters);
  const [copiedContextPath, setCopiedContextPath] = useState<string | null>(null);

  const handleFilterChange = useCallback((next: SessionFilters) => {
    setFilters(next);
    saveFilters(next);
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
  const messages = session.messages || [];
  const filteredMessages = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => messagePassesFilter(message, filters));
  const contextFiles = getContextFileGroups(messages);
  const compaction = session.compaction || { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] };
  const compactionCount = compaction.compactions + compaction.microcompactions;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/sessions" className="rounded-lg border border-border p-1.5 hover:bg-accent transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight">{session.projectName}</h1>
            {models.map(m => <Badge key={m} variant="secondary" className="text-xs">{m}</Badge>)}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span className="font-mono">{session.id.slice(0, 8)}</span>
            {session.gitBranch && (
              <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{session.gitBranch}</span>
            )}
            <span>{format(new Date(session.timestamp), 'MMM d, yyyy h:mm a')}</span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-6 gap-3">
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
        <Card className="border-border/50 shadow-sm">
          <CardContent className="p-3 text-center">
            <Coins className="h-3.5 w-3.5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold">{formatCost(pickCost(session.estimatedCosts, session.estimatedCost))}</p>
            <p className="text-[10px] text-muted-foreground">Est. Usage</p>
          </CardContent>
        </Card>
        <Card className={`border-border/50 shadow-sm ${compactionCount > 0 ? 'border-amber-300/50 bg-amber-50/30' : ''}`}>
          <CardContent className="p-3 text-center">
            <Minimize2 className="h-3.5 w-3.5 mx-auto mb-1 text-muted-foreground" />
            <p className="text-lg font-bold">{compactionCount}</p>
            <p className="text-[10px] text-muted-foreground">Compactions</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Conversation */}
        <div className="col-span-2">
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Conversation</CardTitle>
                <FilterPanel filters={filters} onChange={handleFilterChange} />
              </div>
              {filteredMessages.length !== messages.length && (
                <p className="text-[10px] text-muted-foreground">
                  Showing {filteredMessages.length} of {messages.length} messages
                </p>
              )}
            </CardHeader>
            <CardContent className="pt-0 max-h-[600px] overflow-y-auto">
              <div className="divide-y divide-border/30">
                {filteredMessages.map(({ message, index }) => {
                  if (message.role === 'system') {
                    return <div key={index} id={`conversation-message-${index}`} className="scroll-mt-24"><SystemMessageRow msg={message} /></div>;
                  }
                  if (message.role === 'command') {
                    return <div key={index} id={`conversation-message-${index}`} className="scroll-mt-24"><CommandMessageRow msg={message} /></div>;
                  }
                  if (message.role === 'tool-use') {
                    return <div key={index} id={`conversation-message-${index}`} className="scroll-mt-24"><ToolUseMessage msg={message} /></div>;
                  }
                  if (message.role === 'tool-result') {
                    return <div key={index} id={`conversation-message-${index}`} className="scroll-mt-24"><ToolResultMessage msg={message} /></div>;
                  }
                  return <div key={index} id={`conversation-message-${index}`} className="scroll-mt-24"><ConversationMessage msg={message} /></div>;
                })}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Token Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Input Tokens</span>
                <span className="font-medium">{formatTokens(session.totalInputTokens)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Output Tokens</span>
                <span className="font-medium">{formatTokens(session.totalOutputTokens)}</span>
              </div>
              <Separator />
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Cache Read</span>
                <span className="font-medium">{formatTokens(session.totalCacheReadTokens)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Cache Write</span>
                <span className="font-medium">{formatTokens(session.totalCacheWriteTokens)}</span>
              </div>
            </CardContent>
          </Card>

          {(contextFiles.inContext.length > 0 || contextFiles.referenced.length > 0) && (
            <Card className="border-border/50 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm font-semibold">Context Files</CardTitle>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{contextFiles.inContext.length + contextFiles.referenced.length}</Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="max-h-[280px] space-y-3 overflow-y-auto pr-1">
                  <ContextFileSection
                    title="In Context"
                    files={contextFiles.inContext}
                    copiedPath={copiedContextPath}
                    onCopyPath={handleCopyContextPath}
                    onJumpToMessage={handleJumpToMessage}
                  />
                  <ContextFileSection
                    title="Just Referenced"
                    files={contextFiles.referenced}
                    copiedPath={copiedContextPath}
                    onCopyPath={handleCopyContextPath}
                    onJumpToMessage={handleJumpToMessage}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {topTools.length > 0 && (
            <Card className="border-border/50 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Tools Used</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                {topTools.map(([tool, count]) => (
                  <div key={tool} className="flex items-center justify-between">
                    <span className="text-xs font-mono truncate max-w-[150px]">{tool}</span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{count}x</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {compactionCount > 0 && (
            <Card className="border-amber-300/50 bg-amber-50/30 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                  <Minimize2 className="h-3.5 w-3.5" />
                  Context Compaction
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
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

          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Metadata</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
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
  );
}
