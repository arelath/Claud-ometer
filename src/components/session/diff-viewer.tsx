'use client';

import { Check, Copy, FileText, MessageSquare } from 'lucide-react';
import {
  getFilePatchText,
  getSessionPatchText,
  type SessionDiffFile,
  type SessionDiffHunk,
  type SessionDiffRow,
  type SessionDiffSummary,
} from '@/lib/session-diff';
import { getCodeLanguageLabel, guessCodeLanguage, tokenizeCode, type CodeLanguage } from '@/lib/code-highlighting';
import { formatDisplayPath, normalizeDisplayPath, splitDisplayPath } from '@/lib/path-utils';
import { renderHighlightedTokens } from './artifact-viewer';

export type MainSessionView = 'conversation' | 'changes';
export type DiffDisplayMode = 'net' | 'edits';

export function normalizeDiffPathKey(pathValue: string): string {
  return normalizeDisplayPath(pathValue).replace(/^\.\//, '').toLowerCase();
}

function formatDiffFileCountLabel(summary: SessionDiffSummary): string {
  if (summary.fileCount === 0) return '0 files';
  return summary.fileCount === 1 ? '1 file' : `${summary.fileCount} files`;
}

export function SessionViewTabs({ view, onChange, conversationCount, diffSummary, diffMode, onDiffModeChange, copiedPatchKey, onCopyPatch }: {
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

export function DiffFileRow({ file, selected, onSelect, projectRoot }: {
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

export function DiffRow({ row, language, rowKey }: {
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

export function DiffHunkView({ hunk, language, onJumpToMessage }: {
  hunk: SessionDiffHunk;
  language?: CodeLanguage;
  onJumpToMessage: (messageIndex: number) => void;
}) {
  const timeLabel = hunk.timestamp && !Number.isNaN(new Date(hunk.timestamp).getTime())
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(hunk.timestamp))
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
          Jump to message - {timeLabel}
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

export function FileDiffViewer({ file, mode, copiedPatchKey, onCopyPatch, onJumpToMessage, projectRoot }: {
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
            {language && (
              <span className="rounded-full border border-border/50 bg-background/70 px-1.5 py-0 font-mono text-[10px] leading-4 text-muted-foreground">
                {getCodeLanguageLabel(language)}
              </span>
            )}
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

export function ChangesView({ summary, selectedPath, mode, copiedPatchKey, onSelectPath, onCopyPatch, onJumpToMessage, projectRoot }: {
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
