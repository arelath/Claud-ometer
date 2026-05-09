/* eslint-disable react-hooks/refs */
import React, { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionViewState } from '@/hooks/use-session-view-state';
import type { SessionMessageDisplay } from '@/lib/claude-data/types';
import type { SessionDiffSummary } from '@/lib/session-diff';

const navState = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParams: '',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navState.replace }),
  useSearchParams: () => new URLSearchParams(navState.searchParams),
}));

class TestResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

function toolCall(id: string, name = 'Read') {
  return {
    id,
    name,
    summary: `${name} src/app.ts`,
    details: [{ key: 'file_path', label: 'File', value: 'src/app.ts' }],
  };
}

function message(role: SessionMessageDisplay['role'], index: number, content: string): SessionMessageDisplay {
  return {
    role,
    content,
    timestamp: `2026-05-08T12:00:0${index}.000Z`,
    messageId: `${role}-${index}`,
  };
}

const baseMessages: SessionMessageDisplay[] = [
  message('user', 0, 'Please inspect this file.'),
  {
    ...message('assistant', 1, 'I will read the file.'),
    toolCalls: [toolCall('tool-1')],
  },
  {
    ...message('tool-result', 2, ''),
    blocks: [{
      type: 'tool-result',
      title: 'Text',
      summary: 'file contents',
      content: 'file contents',
      details: [{ key: 'tool_use_id', label: 'Tool call', value: 'tool-1' }],
    }],
  },
  message('system', 3, 'A hook completed.'),
];

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
      toolId: 'tool-2',
      messageIndex: 1,
      timestamp: '2026-05-08T12:00:01.000Z',
      oldStartLine: 1,
      newStartLine: 1,
      oldLineCount: 1,
      newLineCount: 1,
      addedLines: 1,
      removedLines: 1,
      rows: [
        { type: 'remove', oldLineNumber: 1, newLineNumber: null, text: 'old' },
        { type: 'add', oldLineNumber: null, newLineNumber: 1, text: 'new' },
      ],
    }],
    editHunks: [],
  }],
};

const compactionTimestamps = ['2026-05-08T12:00:01.500Z'];

function defineScrollMetrics(element: HTMLElement, metrics: { scrollTop?: number; scrollHeight?: number; clientHeight?: number }) {
  const values = {
    scrollTop: metrics.scrollTop ?? 0,
    scrollHeight: metrics.scrollHeight ?? 1000,
    clientHeight: metrics.clientHeight ?? 200,
  };

  Object.defineProperties(element, {
    scrollTop: {
      configurable: true,
      get: () => values.scrollTop,
      set: value => { values.scrollTop = Number(value); },
    },
    scrollHeight: { configurable: true, get: () => values.scrollHeight },
    clientHeight: { configurable: true, get: () => values.clientHeight },
  });

  element.scrollTo = vi.fn((options?: ScrollToOptions) => {
    if (typeof options?.top === 'number') values.scrollTop = options.top;
  });
}

function Harness({
  messages = baseMessages,
  isLive = false,
  liveRevision,
}: {
  messages?: SessionMessageDisplay[];
  isLive?: boolean;
  liveRevision?: string;
}) {
  const view = useSessionViewState({
    sessionId: 'session-1',
    messages,
    compactionTimestamps,
    diffSummary,
    isLive,
    liveRevision,
  });
  const conversationRef = view.refs.conversationRef;
  const bottomRef = view.refs.bottomRef;

  const setConversationRef = (node: HTMLDivElement | null) => {
    conversationRef.current = node;
    if (!node) return;
    defineScrollMetrics(node, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
  };
  const setBottomRef = (node: HTMLDivElement | null) => {
    bottomRef.current = node;
    if (node) node.scrollIntoView = vi.fn();
  };

  useEffect(() => {
    const container = conversationRef.current;
    if (!container) return;
    defineScrollMetrics(container, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    Array.from(container.children).forEach((child, index) => {
      Object.defineProperty(child, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
        top: index * 120,
        bottom: index * 120 + 80,
        left: 0,
        right: 400,
        width: 400,
        height: 80,
        x: 0,
        y: index * 120,
        toJSON: () => ({}),
        }),
      });
    });
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 200,
        left: 0,
        right: 400,
        width: 400,
        height: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
  });

  return (
    <div>
      <output data-testid="state">
        {[
          view.state.mainView,
          view.state.diffMode,
          view.state.toolFilter || 'no-filter',
          view.state.preset,
          view.state.effectiveSelectedDiffPath || 'no-diff',
          view.state.copiedContextPath || 'no-copied-context',
          view.state.copiedPatchKey || 'no-copied-patch',
          view.state.showScrollToBottom ? 'show-bottom' : 'hide-bottom',
          view.state.unseenMessageCount,
          view.state.groupedMessages.length,
          view.state.minimapSegments.length,
          view.state.minimapViewport.heightPct.toFixed(0),
          view.actions.hasDiffForPath('SRC\\APP.ts') ? 'has-diff' : 'no-has-diff',
        ].join('|')}
      </output>
      <button type="button" onClick={() => view.actions.setMainView('changes')}>changes</button>
      <button type="button" onClick={() => view.actions.setMainView('conversation')}>conversation</button>
      <button type="button" onClick={() => view.actions.setDiffMode('edits')}>edits</button>
      <button type="button" onClick={() => view.actions.setDiffMode('net')}>net</button>
      <button type="button" onClick={() => view.actions.setToolFilter('Read')}>filter read</button>
      <button type="button" onClick={() => view.actions.setToolFilter(null)}>clear filter</button>
      <button type="button" onClick={() => view.actions.handlePresetChange('all')}>preset all</button>
      <button type="button" onClick={() => view.actions.handleOpenDiffForPath('SRC\\APP.ts')}>open diff</button>
      <button type="button" onClick={() => view.actions.handleJumpToMessage([0, 1])}>jump message</button>
      <button type="button" onClick={() => view.actions.handleJumpToDiffMessage(1)}>jump diff</button>
      <button type="button" onClick={() => view.actions.handleCopyContextPath('src/app.ts')}>copy context</button>
      <button type="button" onClick={() => view.actions.handleCopyPatch('patch text', 'patch-1')}>copy patch</button>
      <button type="button" onClick={() => view.actions.scrollToConversationBottom('smooth')}>bottom</button>
      <button type="button" onClick={() => view.actions.setArtifactViewer({ kind: 'text', title: 'Note', content: 'artifact' })}>artifact</button>
      <button type="button" onClick={() => view.actions.scrollElementIntoConversation('missing')}>missing</button>
      <div ref={setConversationRef} data-testid="conversation">
        {view.state.groupedMessages.map((item) => {
          const index = item.type === 'system-group' ? item.messages[0].index : item.index;
          const id = item.type === 'compaction' ? item.targetId : `conversation-message-${index}`;
          return <div id={id} key={`${item.type}-${id}`}>{item.type}</div>;
        })}
        <div ref={setBottomRef} data-testid="bottom" />
      </div>
    </div>
  );
}

describe('useSessionViewState', () => {
  beforeEach(() => {
    navState.replace.mockReset();
    navState.searchParams = '';
    localStorage.clear();
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TestResizeObserver,
    });
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(1);
      return 1;
    });
    window.cancelAnimationFrame = vi.fn();
  });

  it('derives state from search params and writes navigation changes', () => {
    localStorage.setItem('claud-ometer-session-filter-preset', 'tools');
    navState.searchParams = 'view=changes&diff=edits&filter=Read';

    render(<Harness />);

    expect(screen.getByTestId('state')).toHaveTextContent('changes|edits|Read|tools|src/app.ts');
    expect(screen.getByTestId('state')).toHaveTextContent('has-diff');

    fireEvent.click(screen.getByText('conversation'));
    fireEvent.click(screen.getByText('net'));
    fireEvent.click(screen.getByText('clear filter'));
    fireEvent.click(screen.getByText('changes'));
    fireEvent.click(screen.getByText('edits'));
    fireEvent.click(screen.getByText('filter read'));

    expect(navState.replace).toHaveBeenCalledWith('/sessions/session-1?diff=edits&filter=Read', { scroll: false });
    expect(navState.replace).toHaveBeenCalledWith('/sessions/session-1?view=changes&diff=edits&filter=Read', { scroll: false });

    fireEvent.click(screen.getByText('preset all'));
    expect(localStorage.getItem('claud-ometer-session-filter-preset')).toBe('all');
    expect(screen.getByTestId('state')).toHaveTextContent('all');
  });

  it('copies paths and patches, opens matching diffs, and scrolls to targets', async () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.click(screen.getByText('open diff'));
    expect(screen.getByTestId('state')).toHaveTextContent('src/app.ts');
    expect(navState.replace).toHaveBeenCalledWith('/sessions/session-1?view=changes', { scroll: false });

    fireEvent.click(screen.getByText('copy context'));
    fireEvent.click(screen.getByText('copy patch'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('src/app.ts');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('patch text');
    expect(screen.getByTestId('state')).toHaveTextContent('src/app.ts|patch-1');

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.getByTestId('state')).toHaveTextContent('no-copied-context|no-copied-patch');

    fireEvent.click(screen.getByText('jump message'));
    fireEvent.click(screen.getByText('jump diff'));
    fireEvent.click(screen.getByText('bottom'));
    fireEvent.click(screen.getByText('missing'));

    expect(screen.getByTestId('conversation').scrollTo).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('tracks live updates when the conversation is not at the bottom', async () => {
    const { rerender } = render(<Harness messages={baseMessages.slice(0, 2)} isLive liveRevision="a" />);
    const container = screen.getByTestId('conversation');
    defineScrollMetrics(container, { scrollTop: 0, scrollHeight: 1200, clientHeight: 200 });

    fireEvent.scroll(container);
    rerender(<Harness messages={baseMessages} isLive liveRevision="b" />);

    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('show-bottom|2');
    });

    fireEvent.click(screen.getByText('bottom'));
    expect(screen.getByTestId('state')).toHaveTextContent('hide-bottom|0');
  });
});
