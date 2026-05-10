import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CostModeProvider } from '@/lib/cost-mode-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ArtifactFullscreenViewer, ArtifactPreview, HighlightedCode, toPreviewLines } from '@/components/session/artifact-viewer';
import { ContextFilesPanel, ContextWindowMeter } from '@/components/session/context-panel';
import {
  ChangesView,
  FileDiffViewer,
  SessionViewTabs,
  normalizeDiffPathKey,
} from '@/components/session/diff-viewer';
import {
  findDetail,
  findPreferredDetail,
  formatDisplayValue,
  getOutputExitCode,
  getOutputTone,
  omitDetails,
  parseExitCodeValue,
  usesMonospaceDetail,
} from '@/components/session/detail-utils';
import { findSegmentForRatio, Minimap, type MinimapSegment } from '@/components/session/minimap';
import { SessionPill } from '@/components/session/session-pill';
import { SessionRenderContext, type ArtifactViewerState, type SessionRenderContextValue } from '@/components/session/session-render-context';
import { AssistantCard } from '@/components/session/transcript/AssistantTurn';
import { BlockCard, CompactionDivider, SystemGroup, ThinkingSummary } from '@/components/session/transcript/SystemEvent';
import { DetailPanel, ToolCallInline, ToolResultInline } from '@/components/session/transcript/ToolCall';
import { UserMessage } from '@/components/session/transcript/UserTurn';
import type { SessionDiffSummary } from '@/lib/session-diff';
import type { SessionMessageDisplay, SessionToolCallDisplay } from '@/lib/claude-data/types';

function renderWithProviders(
  ui: React.ReactElement,
  openArtifact = vi.fn(),
  context: Partial<SessionRenderContextValue> = {},
) {
  return {
    openArtifact,
    ...render(
      <CostModeProvider>
        <TooltipProvider>
          <SessionRenderContext.Provider value={{ projectRoot: 'D:/repo', openArtifact, ...context }}>
            {ui}
          </SessionRenderContext.Provider>
        </TooltipProvider>
      </CostModeProvider>,
    ),
  };
}

function toolCall(overrides: Partial<SessionToolCallDisplay> = {}): SessionToolCallDisplay {
  return {
    name: 'Bash',
    id: 'tool-1',
    summary: 'Run tests',
    details: [
      { key: 'command', label: 'Command', value: 'npm test\nnpm run lint' },
      { key: 'exitCode', label: 'Exit', value: '0' },
      { key: 'durationMs', label: 'Duration', value: '1200' },
    ],
    ...overrides,
  };
}

function toolResult(content = 'completed', exitCode = '0'): SessionMessageDisplay {
  return {
    role: 'tool-result',
    content,
    timestamp: '2026-05-08T12:00:03.000Z',
    blocks: [{
      type: 'tool-result',
      title: 'Bash output',
      summary: content,
      content,
      details: [
        { key: 'tool_use_id', label: 'Tool', value: 'tool-1' },
        { key: 'exitCode', label: 'Exit', value: exitCode },
        { key: 'file_path', label: 'File', value: 'D:/repo/src/app.ts' },
      ],
    }],
  };
}

const diffSummary: SessionDiffSummary = {
  fileCount: 1,
  addedLines: 1,
  removedLines: 1,
  editCount: 1,
  files: [{
    path: 'src/app.ts',
    addedLines: 1,
    removedLines: 1,
    editCount: 1,
    status: 'modified',
    hunks: [{
      id: 'hunk-1',
      filePath: 'src/app.ts',
      toolName: 'Edit',
      toolId: 'tool-1',
      messageIndex: 2,
      timestamp: '2026-05-08T12:00:00.000Z',
      location: 'function main',
      oldStartLine: 10,
      newStartLine: 10,
      oldLineCount: 2,
      newLineCount: 2,
      addedLines: 1,
      removedLines: 1,
      rows: [
        { type: 'context', oldLineNumber: 10, newLineNumber: 10, text: 'const value = 1;' },
        { type: 'remove', oldLineNumber: 11, newLineNumber: null, text: 'return value;' },
        { type: 'add', oldLineNumber: null, newLineNumber: 11, text: 'return value + 1;' },
      ],
    }],
    editHunks: [],
  }],
};
diffSummary.files[0].editHunks = diffSummary.files[0].hunks;

describe('session UI building blocks', () => {
  it('renders artifact previews, expansion, open action, and fullscreen viewer', () => {
    const artifact: ArtifactViewerState = {
      title: 'Patch',
      kind: 'diff',
      sourcePath: 'src/app.ts',
      oldText: 'const value = 1;',
      newText: 'const value = 2;\nconsole.log(value);\nreturn value;\n',
      location: 'L10',
    };
    const { openArtifact } = renderWithProviders(
      <>
        <ArtifactPreview artifact={artifact} label="Diff preview" />
        <ArtifactFullscreenViewer artifact={artifact} onClose={vi.fn()} />
      </>,
    );

    expect(screen.getAllByText('Diff preview')[0]).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    expect(openArtifact).toHaveBeenCalledWith(artifact);
    expect(screen.getByRole('button', { name: 'Close fullscreen preview' })).toBeInTheDocument();
    expect(toPreviewLines('a\r\nb')).toEqual(['a', 'b']);
  });

  it('renders highlighted code and detail helper branches', () => {
    const details = [
      { key: 'input.file_path', label: 'File', value: 'D:/repo/src/app.ts' },
      { key: 'command', label: 'Command', value: 'npm test' },
      { key: 'exitCode', label: 'Exit', value: 'exit code: 2' },
    ];

    renderWithProviders(
      <>
        <HighlightedCode content="const x = 1;" language="typescript" className="code" />
        <DetailPanel details={details} content="output" shownKeys={['command']} />
      </>,
    );

    expect(screen.getByText('const')).toBeInTheDocument();
    expect(findDetail(details, ['file_path'])?.value).toContain('app.ts');
    expect(findPreferredDetail(details, ['missing', 'command'])?.value).toBe('npm test');
    expect(omitDetails(details, ['command'])).toHaveLength(2);
    expect(usesMonospaceDetail('command')).toBe(true);
    expect(formatDisplayValue('file_path', 'D:/repo/src/app.ts', 'D:/repo')).toBe('src/app.ts');
    expect(parseExitCodeValue('exit code: 2')).toBe(2);
    expect(getOutputExitCode([{ type: 'tool-result', title: 'Bash', summary: '', details }], '')).toBe(2);
    expect(getOutputTone(0)).toBe('success');
    expect(getOutputTone(1)).toBe('error');
  });

  it('renders tool calls, tool results, and assistant cards', () => {
    const editTool = toolCall({
      name: 'Edit',
      details: [{ key: 'file_path', label: 'File', value: 'D:/repo/src/app.ts' }],
      artifact: { kind: 'diff', title: 'Edit', oldText: 'old', newText: 'new', location: 'L1' },
    });
    const result = toolResult('line one\nline two\nline three\nline four\nline five', '1');

    renderWithProviders(
      <>
        <ToolCallInline tool={editTool} />
        <ToolResultInline msg={result} />
        <AssistantCard
          index={2}
          msg={{
            role: 'assistant',
            content: '',
            timestamp: '2026-05-08T12:00:00.000Z',
            model: 'claude-opus-4',
            usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 30 },
            estimatedCosts: { api: 1, conservative: 0.5, subscription: 0.25 },
            toolCalls: [editTool],
            blocks: [
              { type: 'thinking', title: 'Thinking', summary: 'considering edit', details: [], content: 'private summary' },
              { type: 'event', title: 'Hook', summary: 'hook event', details: [] },
            ],
          }}
          toolPairs={[{
            toolUse: { message: { role: 'tool-use', content: '', timestamp: '2026-05-08T12:00:01.000Z', toolCalls: [editTool] }, index: 3 },
            toolResult: { message: result, index: 4 },
          }]}
        />
      </>,
    );

    expect(screen.getAllByText('Edit').length).toBeGreaterThan(0);
    expect(screen.getAllByText('considering edit').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('tool-io-pair')).toHaveLength(1);
    expect(screen.getAllByText('Error output').length).toBeGreaterThan(0);
  });

  it('uses provider-aware assistant labels from render context', () => {
    renderWithProviders(
      <AssistantCard
        index={1}
        msg={{ role: 'assistant', content: 'Codex answer', timestamp: '2026-05-08T12:00:00.000Z' }}
        toolPairs={[]}
      />,
      vi.fn(),
      { agentKind: 'codex', assistantLabel: 'Codex' },
    );

    expect(screen.getByTestId('assistant-turn')).toHaveTextContent('Codex');
    expect(screen.getByTestId('assistant-turn')).not.toHaveTextContent('Claude');
  });

  it('renders system, command, user, compaction, and thinking rows', () => {
    renderWithProviders(
      <>
        <UserMessage index={0} msg={{ role: 'user', content: 'Hello Claude', timestamp: '2026-05-08T12:00:00.000Z' }} />
        <SystemGroup
          messages={[
            { index: 1, message: { role: 'system', content: 'System notice', timestamp: '2026-05-08T12:00:01.000Z' } },
            { index: 2, message: { role: 'command', content: 'npm test', timestamp: '2026-05-08T12:00:02.000Z' } },
          ]}
        />
        <BlockCard block={{ type: 'event', title: 'Bash', summary: 'npm test', details: [{ key: 'command', label: 'Command', value: 'npm test' }, { key: 'exitCode', label: 'Exit', value: '0' }] }} />
        <CompactionDivider timestamp="2026-05-08T12:00:03.000Z" targetId="compact-1" />
        <ThinkingSummary block={{ type: 'thinking', title: 'Think', summary: 'thinking summary', content: 'long thought', details: [] }} />
      </>,
    );

    expect(screen.getByText('Hello Claude')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /2 system events/i }));
    expect(screen.getByText('System notice')).toBeInTheDocument();
    expect(screen.getByText('Context Window Compaction')).toBeInTheDocument();
    expect(screen.getByText('thinking summary')).toBeInTheDocument();
  });

  it('renders context token and file panels', () => {
    const copyPath = vi.fn();
    const jump = vi.fn();
    const openDiff = vi.fn().mockReturnValue(true);

    renderWithProviders(
      <>
        <ContextWindowMeter
          session={{
            totalInputTokens: 1000,
            totalOutputTokens: 200,
            totalCacheReadTokens: 300,
            totalCacheWriteTokens: 50,
          }}
          messages={[{
            role: 'assistant',
            content: 'Done',
            timestamp: '2026-05-08T12:00:00.000Z',
            promptBreakdown: {
              totalTokens: 575,
              systemTokens: 100,
              conversationTokens: 150,
              filesTokens: 200,
              cacheReadTokens: 75,
              thinkingTokens: 25,
              toolTokens: 20,
              otherTokens: 5,
            },
          }]}
        />
        <ContextFilesPanel
          copiedPath={null}
          onCopyPath={copyPath}
          onJumpToMessage={jump}
          hasDiffForPath={() => true}
          onOpenDiff={openDiff}
          contextFiles={{
            inContext: [{
              fullPath: 'D:/repo/src/app.ts',
              fileName: 'app.ts',
              kind: 'in-context',
              attached: false,
              firstMessageIndex: 1,
              loadedLines: '5',
              totalLines: '10',
              loadedRanges: [{ start: 1, end: 5 }],
              messageIndexes: [1],
            }],
            referenced: [{
              fullPath: 'D:/repo/README.md',
              fileName: 'README.md',
              kind: 'referenced',
              loadedLines: '3',
              totalLines: '3',
              loadedRanges: [],
              messageIndexes: [2],
              attached: true,
              firstMessageIndex: 2,
            }],
          }}
        />
      </>,
    );

    expect(screen.getByText('Token usage')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Window' }));
    expect(screen.getByText('current prompt')).toBeInTheDocument();
    expect(screen.getByText('575 total')).toBeInTheDocument();
    expect(screen.getAllByText('Cache read').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('app.ts'));
    fireEvent.click(screen.getByText('Copy all'));
    expect(openDiff).toHaveBeenCalledWith('D:/repo/src/app.ts');
    expect(copyPath).toHaveBeenCalled();
  });

  it('renders diff tabs, file list, hunk rows, and empty diff state', () => {
    const select = vi.fn();
    const copy = vi.fn();
    const jump = vi.fn();

    renderWithProviders(
      <>
        <SessionViewTabs
          view="changes"
          onChange={select}
          conversationCount={3}
          diffSummary={diffSummary}
          diffMode="net"
          onDiffModeChange={select}
          copiedPatchKey={null}
          onCopyPatch={copy}
        />
        <ChangesView
          summary={diffSummary}
          selectedPath="src/app.ts"
          mode="net"
          copiedPatchKey={null}
          onSelectPath={select}
          onCopyPatch={copy}
          onJumpToMessage={jump}
          projectRoot="D:/repo"
        />
        <FileDiffViewer
          file={undefined}
          mode="net"
          copiedPatchKey={null}
          onCopyPatch={copy}
          onJumpToMessage={jump}
        />
      </>,
    );

    expect(normalizeDiffPathKey('./SRC/App.ts')).toBe('src/app.ts');
    expect(screen.getByTestId('session-changes-view')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /copy patch/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /jump to message/i }));
    expect(copy).toHaveBeenCalled();
    expect(jump).toHaveBeenCalledWith(2);
    expect(screen.getByText('No file changes found in this session.')).toBeInTheDocument();
  });

  it('renders minimap and jumps to clicked or keyboard-selected targets', () => {
    const segments: MinimapSegment[] = [
      { type: 'user', targetId: 'message-1', topPct: 0, heightPct: 2 },
      { type: 'assistant', targetId: 'message-2', topPct: 50, heightPct: 3 },
      { type: 'compaction', targetId: 'compact-1', topPct: 90, heightPct: 0.7 },
    ];
    const jump = vi.fn();

    renderWithProviders(
      <>
        <SessionPill value="exit 0" tone="good" mono />
        <Minimap segments={segments} viewport={{ topPct: 10, heightPct: 25 }} onJump={jump} />
      </>,
    );

    expect(findSegmentForRatio(segments, 0.51)?.targetId).toBe('message-2');
    fireEvent.click(screen.getAllByTestId('session-minimap-segment')[1]);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Session timeline' }), { key: 'End' });
    expect(jump).toHaveBeenCalledWith('message-2');
    expect(jump).toHaveBeenCalledWith('compact-1');
    expect(screen.getByText('exit 0')).toBeInTheDocument();
  });

  it('covers additional transcript branch states for fallback summaries and compact outputs', () => {
    const readTool = toolCall({
      name: 'Read',
      id: 'read-1',
      summary: 'src/branch.ts',
      details: [
        { key: 'file_path', label: 'File', value: 'D:/repo/src/branch.ts' },
        { key: 'startLine', label: 'Start', value: '12' },
      ],
    });
    const grepTool = toolCall({
      name: 'Grep',
      id: 'grep-1',
      summary: 'needle',
      details: [
        { key: 'query', label: 'Query', value: 'needle' },
        { key: 'includePattern', label: 'Include', value: '*.ts' },
        { key: 'extraOne', label: 'Extra one', value: 'one' },
        { key: 'extraTwo', label: 'Extra two', value: 'two' },
        { key: 'extraThree', label: 'Extra three', value: 'three' },
      ],
    });
    const commandTool = toolCall({
      name: 'Bash',
      id: 'bash-branch',
      summary: 'npm test',
      details: [
        { key: 'command', label: 'Command', value: 'npm test '.repeat(30) },
        { key: 'goal', label: 'Goal', value: 'verify' },
        { key: 'mode', label: 'Mode', value: 'safe' },
      ],
    });

    renderWithProviders(
      <>
        <ToolCallInline tool={grepTool} />
        <ToolCallInline tool={commandTool} />
        <ToolResultInline msg={{ role: 'tool-result', content: 'ok\nexit code: 0', timestamp: 'bad-date' }} />
        <ToolResultInline msg={{ role: 'tool-result', content: 'short neutral output', timestamp: 'bad-date' }} />
        <AssistantCard
          index={8}
          msg={{
            role: 'assistant',
            content: '',
            timestamp: 'bad-date',
            toolCalls: [readTool, grepTool, commandTool],
          }}
          toolPairs={[]}
        />
        <AssistantCard
          index={9}
          msg={{
            role: 'assistant',
            content: '',
            timestamp: '2026-05-08T12:00:00.000Z',
            blocks: [{ type: 'thinking', title: 'Thinking', summary: 'silent reasoning', details: [] }],
          }}
          toolPairs={[]}
          toolTimeline={[
            { type: 'compaction', index: 1, timestamp: 'invalid', targetId: 'compact-invalid' },
            { type: 'tool-pair', pair: { toolUse: { message: { role: 'tool-use', content: '', timestamp: '2026-05-08T12:00:01.000Z', toolCalls: [readTool] }, index: 10 } } },
          ]}
        />
        <BlockCard block={{
          type: 'event',
          title: 'Search',
          summary: 'needle',
          details: [{ key: 'query', label: 'Query', value: 'needle' }],
          content: 'search content',
        }}
        />
        <BlockCard block={{
          type: 'event',
          title: 'File',
          summary: 'D:/repo/src/branch.ts',
          details: [{ key: 'file_path', label: 'File', value: 'D:/repo/src/branch.ts' }],
        }}
        />
        <SystemGroup
          messages={[
            { index: 11, message: { role: 'system', content: 'meta event', timestamp: 'bad-date', isMeta: true } },
          ]}
        />
      </>,
    );

    expect(screen.getByText('3 tool calls - Read, Grep, Bash')).toBeInTheDocument();
    expect(screen.getAllByText('silent reasoning').length).toBeGreaterThan(0);
    expect(screen.getByText('Context Window Compaction')).toBeInTheDocument();
    expect(screen.getAllByText('L12-?').length).toBeGreaterThan(0);
    expect(screen.getAllByText('in *.ts').length).toBeGreaterThan(0);
    expect(screen.getAllByText('verify').length).toBeGreaterThan(0);
    expect(screen.getAllByText('safe').length).toBeGreaterThan(0);
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('short neutral output')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /1 system event/i }));
    expect(screen.getByText('meta event')).toBeInTheDocument();
  });
});
