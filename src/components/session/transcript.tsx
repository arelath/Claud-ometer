'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { AlertCircle, Bot, Brain, Check, ChevronDown, FileText, Info, Terminal } from 'lucide-react';
import { getModelDisplayName } from '@/config/pricing';
import type { SessionMessageBlockDisplay, SessionMessageDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';
import { formatCost, formatTokens } from '@/lib/format';
import { useCostMode } from '@/lib/cost-mode-context';
import { getToolResultId, type AssistantTimelineItem, type ToolPair } from '@/lib/session-transcript';
import { formatDisplayPath } from '@/lib/path-utils';
import { getDetailKeyTail, normalizeDisplayNewlines, detailMatchesKey } from '@/lib/string-utils';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ArtifactPreview, HighlightedCode, toPreviewLines } from './artifact-viewer';
import {
  findDetail,
  formatDisplayValue,
  getCodePathDetailValue,
  getOutputExitCode,
  getOutputTone,
  omitDetails,
  usesMonospaceDetail,
} from './detail-utils';
import { SessionPill } from './session-pill';
import { useSessionRenderContext, type ArtifactViewerState } from './session-render-context';
import { guessCodeLanguage } from '@/lib/code-highlighting';

type PillTone = 'neutral' | 'good' | 'warn' | 'danger';

function DetailPanel({ details, content, shownKeys = [], summaryLabel = 'details' }: {
  details: SessionToolCallDisplay['details'];
  content?: string;
  shownKeys?: string[];
  summaryLabel?: string;
}) {
  const { projectRoot } = useSessionRenderContext();
  const noiseKeys = new Set([
    'type', 'description', 'cache_control', 'sourceToolAssistantUUID', 'tool_use_id', 'toolUseId',
    'leafUuid', 'messageId', 'uuid', 'parent_tool_use_id',
  ]);
  const filtered = details.filter(detail => {
    if (shownKeys.some(key => detailMatchesKey(detail.key, [key]))) return false;
    if (noiseKeys.has(getDetailKeyTail(detail.key))) return false;
    if (!detail.value || detail.value === '[]' || detail.value === '""' || detail.value === '{}') return false;
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
          {filtered.map((detail, idx) => (
            <div key={`${detail.key}-${detail.value}-${idx}`} className="grid grid-cols-[80px_1fr] gap-1.5 text-[11px]">
              <span className="text-muted-foreground truncate">{detail.label}</span>
              <span className={`break-words ${usesMonospaceDetail(detail.key) ? 'font-mono text-[10px]' : ''}`}>
                {formatDisplayValue(detail.key, detail.value, projectRoot)}
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
            {filtered.map((detail, idx) => (
              <div key={`${detail.key}-${detail.value}-${idx}`} className="grid grid-cols-[80px_1fr] gap-1.5 text-[11px]">
                <span className="text-muted-foreground truncate">{detail.label}</span>
                <span className={`break-words ${usesMonospaceDetail(detail.key) ? 'font-mono text-[10px]' : ''}`}>
                  {formatDisplayValue(detail.key, detail.value, projectRoot)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function ToolCallInline({ tool }: { tool: SessionToolCallDisplay }) {
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
  const pills: { value: string; mono?: boolean; tone?: PillTone }[] = [];

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
    const startLine = findDetail(tool.details, ['startLine']);
    const endLine = findDetail(tool.details, ['endLine']);
    if (startLine || endLine) {
      pills.push({ value: `L${startLine?.value || '?'}-${endLine?.value || '?'}`, mono: true });
      shownKeys.push('startLine', 'endLine');
    }
    if (tool.artifact?.kind === 'diff') {
      pills.push({ value: 'edit', tone: 'warn' });
    }
  } else if (query) {
    primary = query.value;
    shownKeys.push('query');
    const includePattern = findDetail(tool.details, ['includePattern']);
    if (includePattern) {
      pills.push({ value: `in ${includePattern.value}`, mono: true });
      shownKeys.push('includePattern');
    }
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
            <FileText className="h-2.5 w-2.5 text-amber-500" />
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
        {pills.map((pill, index) => <SessionPill key={index} value={pill.value} mono={pill.mono} tone={pill.tone} />)}
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

export function ToolResultInline({ msg }: { msg: SessionMessageDisplay }) {
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
  const effectiveContent = blockContent || normalizedMessageContent;
  const contentLines = effectiveContent ? effectiveContent.split('\n') : [];
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

export function BlockCard({ block }: { block: SessionMessageBlockDisplay }) {
  const { projectRoot } = useSessionRenderContext();
  const shownKeys: string[] = [];
  const pills: { value: string; mono?: boolean; tone?: PillTone }[] = [];

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
    if (exitCode) {
      pills.push({ value: `exit ${exitCode.value}`, tone: exitCode.value === '0' ? 'good' : 'danger', mono: true });
      shownKeys.push('exitCode');
    }
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

export function AssistantCard({ msg, index, toolPairs, toolTimeline }: {
  msg: SessionMessageDisplay;
  index: number;
  toolPairs: ToolPair[];
  toolTimeline?: AssistantTimelineItem[];
}) {
  const { pickCost } = useCostMode();
  const thinkingBlocks = (msg.blocks || []).filter(block => block.type === 'thinking');
  const eventBlocks = (msg.blocks || []).filter(block => block.type === 'event');

  const modelLabel = msg.model
    ? getModelDisplayName(msg.model)
    : null;

  const turnCost = pickCost(msg.estimatedCosts, 0);
  const nestedTimeline = toolTimeline || toolPairs.map(pair => ({ type: 'tool-pair' as const, pair }));
  const unpairedTools = msg.toolCalls || [];
  const fallbackSummary = (() => {
    if (msg.content) return null;
    const firstThink = thinkingBlocks.find(block => block.summary)?.summary;
    if (firstThink) return firstThink;
    if (unpairedTools.length === 1) {
      const tool = unpairedTools[0];
      const path = findDetail(tool.details, ['file_path', 'filePath', 'path', 'displayPath'])?.value;
      const command = findDetail(tool.details, ['command'])?.value;
      const query = findDetail(tool.details, ['query'])?.value;
      const arg = path || command?.split('\n')[0] || query;
      return arg ? `${tool.name} ${arg}` : tool.name;
    }
    if (unpairedTools.length > 1) {
      const names = Array.from(new Set(unpairedTools.map(tool => tool.name))).slice(0, 3).join(', ');
      return `${unpairedTools.length} tool calls - ${names}`;
    }
    return null;
  })();

  return (
    <div id={`conversation-message-${index}`} data-testid="assistant-turn">
      <div className="bg-card border border-border/50 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-[18px] h-[18px] rounded bg-amber-500/10 flex items-center justify-center">
            <Bot className="h-2.5 w-2.5 text-amber-600" />
          </div>
          <span className="text-[11px] font-medium text-foreground">Claude</span>
          {modelLabel && <span className="text-[11px] text-muted-foreground">{modelLabel}</span>}
          {msg.timestamp && !Number.isNaN(new Date(msg.timestamp).getTime()) && (
            <span className="text-[11px] text-muted-foreground">- {format(new Date(msg.timestamp), 'h:mm:ss a')}</span>
          )}
          {msg.usage && (
            <div className="ml-auto flex gap-2.5 text-[11px] text-muted-foreground font-mono">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>down {formatTokens((msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0))}</span>
                </TooltipTrigger>
                <TooltipContent>Input tokens (including cache read)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>up {formatTokens(msg.usage.output_tokens || 0)}</span>
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

        {thinkingBlocks.filter(block => block.summary).map((block, i) => (
          <div key={`think-${i}`} className="flex items-center gap-1.5 py-0.5 mt-1 text-[11px] text-muted-foreground">
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
        ))}

        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="mt-2 border-t border-border/30 pt-2 space-y-0">
            {msg.toolCalls.map((tool, i) => <ToolCallInline key={tool.id || i} tool={tool} />)}
          </div>
        )}

        {eventBlocks.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[10px] text-muted-foreground">{eventBlocks.length} event{eventBlocks.length === 1 ? '' : 's'}</summary>
            <div className="space-y-0 mt-1">{eventBlocks.map((block, i) => <BlockCard key={i} block={block} />)}</div>
          </details>
        )}
      </div>

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
                    {(pair.toolUse.message.blocks || []).filter(block => block.type === 'thinking').filter(block => block.summary).map((block, j) => (
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
