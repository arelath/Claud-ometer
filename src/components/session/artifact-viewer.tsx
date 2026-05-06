'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, X } from 'lucide-react';
import { getCodeLanguageLabel, guessCodeLanguage, tokenizeCode, type CodeLanguage, type HighlightToken } from '@/lib/code-highlighting';
import { normalizeDisplayNewlines } from '@/lib/string-utils';
import { useSessionRenderContext, type ArtifactViewerState } from './session-render-context';

const COLLAPSED_PREVIEW_LINES = 5;
const EXPANDED_PREVIEW_LINES = 50;

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

export function toPreviewLines(value: string): string[] {
  const normalized = normalizeDisplayNewlines(value).replace(/\r\n?/g, '\n');
  return normalized ? normalized.split('\n') : [];
}

export function renderHighlightedTokens(tokens: HighlightToken[], keyPrefix: string) {
  return tokens.map((token, index) => {
    const className = HIGHLIGHT_TOKEN_CLASSES[token.kind];
    return (
      <span key={`${keyPrefix}-${index}`} className={className || undefined}>
        {token.text}
      </span>
    );
  });
}

export function HighlightedCode({ content, language, className }: {
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

export function ArtifactPreview({ artifact, label, className = '' }: {
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

export function ArtifactFullscreenViewer({ artifact, onClose }: {
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
