'use client';

import { AlertCircle, Check, FileText } from 'lucide-react';
import type { SessionMessageDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';
import { formatDisplayPath } from '@/lib/path-utils';
import { getDetailKeyTail, normalizeDisplayNewlines, detailMatchesKey } from '@/lib/string-utils';
import { guessCodeLanguage } from '@/lib/code-highlighting';
import {
  ANTHROPIC_END_LINE_DETAIL_KEYS,
  ANTHROPIC_FILE_DETAIL_KEYS,
  ANTHROPIC_START_LINE_DETAIL_KEYS,
} from '@/config/anthropic-schema';
import { ArtifactPreview, HighlightedCode, toPreviewLines } from '../artifact-viewer';
import {
  findDetail,
  formatDisplayValue,
  getCodePathDetailValue,
  getOutputExitCode,
  getOutputTone,
  omitDetails,
  usesMonospaceDetail,
} from '../detail-utils';
import { SessionPill } from '../session-pill';
import { useSessionRenderContext, type ArtifactViewerState } from '../session-render-context';

export type PillTone = 'neutral' | 'good' | 'warn' | 'danger';

export function DetailPanel({ details, content, shownKeys = [], summaryLabel = 'details' }: {
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
  const filePath = findDetail(tool.details, [...ANTHROPIC_FILE_DETAIL_KEYS]);
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
    shownKeys.push(...ANTHROPIC_FILE_DETAIL_KEYS);
    const startLine = findDetail(tool.details, [...ANTHROPIC_START_LINE_DETAIL_KEYS]);
    const endLine = findDetail(tool.details, [...ANTHROPIC_END_LINE_DETAIL_KEYS]);
    if (startLine || endLine) {
      pills.push({ value: `L${startLine?.value || '?'}-${endLine?.value || '?'}`, mono: true });
      shownKeys.push(...ANTHROPIC_START_LINE_DETAIL_KEYS, ...ANTHROPIC_END_LINE_DETAIL_KEYS);
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
          <FileText className={`h-2.5 w-2.5 ${isEdit ? 'text-amber-500' : 'text-muted-foreground'}`} />
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
