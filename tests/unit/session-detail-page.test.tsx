import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail, SessionMessageDisplay } from '@/lib/claude-data/types';
import type { TranscriptItem } from '@/lib/session-transcript';
import { TooltipProvider } from '@/components/ui/tooltip';

const detailState = vi.hoisted(() => ({
  session: undefined as SessionDetail | undefined | null,
  isLoading: false,
  error: null as unknown,
  sourceInfo: { active: 'live', hasImportedData: false, importMeta: null },
  mainView: 'conversation' as 'conversation' | 'changes',
  setMainView: vi.fn(),
  setDiffMode: vi.fn(),
  setToolFilter: vi.fn(),
  setSelectedDiffPath: vi.fn(),
  setArtifactViewer: vi.fn(),
  handleCopyContextPath: vi.fn(),
  handleCopyPatch: vi.fn(),
  handleJumpToDiffMessage: vi.fn(),
  handleJumpToMessage: vi.fn(),
  handleOpenDiffForPath: vi.fn(),
  scrollElementIntoConversation: vi.fn(),
  scrollToConversationBottom: vi.fn(),
}));
const fetchMock = vi.hoisted(() => vi.fn());
const createObjectUrlMock = vi.hoisted(() => vi.fn(() => 'blob:session-export'));
const revokeObjectUrlMock = vi.hoisted(() => vi.fn());

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    use: (usable: unknown) => usable,
  };
});

vi.mock('@/lib/hooks', () => ({
  useDataSourceInfo: () => ({ data: detailState.sourceInfo }),
  useSessionDetail: () => ({
    data: detailState.session,
    isLoading: detailState.isLoading,
    error: detailState.error,
  }),
  useSessionSummary: () => ({ data: detailState.session || undefined }),
}));

vi.mock('@/lib/cost-mode-context', () => ({
  useCostMode: () => ({ pickCost: (costs: { subscription?: number } | undefined, fallback: number) => costs?.subscription ?? fallback }),
}));

vi.mock('@/hooks/use-session-view-state', () => ({
  useSessionViewState: () => ({
    state: {
      artifactViewer: null,
      copiedContextPath: null,
      copiedPatchKey: null,
      diffMode: 'net',
      effectiveSelectedDiffPath: 'src/app.ts',
      groupedMessages: transcriptItems,
      mainView: detailState.mainView,
      minimapSegments: [],
      minimapViewport: { topPct: 0, heightPct: 25 },
      preset: 'narrative',
      presetCounts: { narrative: 2, tools: 4, all: 5 },
      showScrollToBottom: false,
      toolFilter: null,
      unseenMessageCount: 0,
    },
    refs: {
      bottomRef: { current: null },
      conversationRef: { current: null },
    },
    actions: {
      handleCopyContextPath: detailState.handleCopyContextPath,
      handleCopyPatch: detailState.handleCopyPatch,
      handleJumpToDiffMessage: detailState.handleJumpToDiffMessage,
      handleJumpToMessage: detailState.handleJumpToMessage,
      handleOpenDiffForPath: detailState.handleOpenDiffForPath,
      handlePresetChange: vi.fn(),
      hasDiffForPath: () => true,
      scrollElementIntoConversation: detailState.scrollElementIntoConversation,
      scrollToConversationBottom: detailState.scrollToConversationBottom,
      setArtifactViewer: detailState.setArtifactViewer,
      setDiffMode: detailState.setDiffMode,
      setMainView: detailState.setMainView,
      setSelectedDiffPath: detailState.setSelectedDiffPath,
      setToolFilter: detailState.setToolFilter,
    },
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@/components/session/artifact-viewer', () => ({
  ArtifactFullscreenViewer: ({ artifact }: { artifact: unknown }) => <div data-testid="artifact-viewer">{artifact ? 'artifact' : 'no artifact'}</div>,
}));

vi.mock('@/components/session/context-panel', () => ({
  ContextFilesPanel: ({ contextFiles }: { contextFiles: unknown[] }) => <div data-testid="context-files">context files {contextFiles.length}</div>,
  ContextWindowMeter: () => <div data-testid="context-meter">context meter</div>,
}));

vi.mock('@/components/session/diff-viewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/session/diff-viewer')>();
  return {
    ...actual,
    ChangesView: ({ selectedPath }: { selectedPath: string | null }) => <div data-testid="changes-view">changes {selectedPath}</div>,
    SessionViewTabs: ({ view, conversationCount }: { view: string; conversationCount: number }) => (
      <div data-testid="view-tabs">{view} {conversationCount}</div>
    ),
  };
});

vi.mock('@/components/session/minimap', () => ({
  Minimap: () => <div data-testid="minimap">minimap</div>,
}));

vi.mock('@/components/session/live-session-send-box', () => ({
  LiveSessionSendBox: ({ sessionId }: { sessionId: string }) => <div data-testid="send-box">send {sessionId}</div>,
}));

vi.mock('@/components/session/live-working-indicator', () => ({
  LiveWorkingIndicator: () => <span>Working</span>,
}));

vi.mock('@/components/session/resume-session-button', () => ({
  ResumeSessionButton: ({ sessionId }: { sessionId: string }) => <button>Resume {sessionId}</button>,
}));

vi.mock('@/components/session/session-pill', () => ({
  SessionPill: ({ value }: { value: string }) => <span>{value}</span>,
}));

vi.mock('@/components/session/transcript', () => ({
  AssistantCard: ({ index }: { index: number }) => <div data-testid="assistant-card">assistant {index}</div>,
  CompactionDivider: ({ targetId }: { targetId: string }) => <div data-testid="compaction">{targetId}</div>,
  SystemGroup: ({ messages }: { messages: unknown[] }) => <div data-testid="system-group">system {messages.length}</div>,
  UserMessage: ({ index }: { index: number }) => <div data-testid="user-message">user {index}</div>,
}));

function costs(api: number) {
  return { api, conservative: api / 2, subscription: api / 4 };
}

function displayMessage(role: SessionMessageDisplay['role'], index: number, content: string): SessionMessageDisplay {
  return {
    role,
    content,
    timestamp: `2026-05-08T12:00:0${index}.000Z`,
    messageId: `${role}-${index}`,
  };
}

const editMessage: SessionMessageDisplay = {
  ...displayMessage('assistant', 1, 'I edited the file.'),
  model: 'claude-opus-4',
  toolCalls: [{
    id: 'edit-1',
    name: 'Edit',
    summary: 'Edit src/app.ts',
    details: [{ key: 'file_path', label: 'File', value: 'src/app.ts' }],
    artifact: {
      kind: 'diff',
      title: 'src/app.ts',
      oldText: 'old',
      newText: 'new',
      location: 'line 1',
    },
  }],
};

const transcriptItems: TranscriptItem[] = [
  { type: 'user', index: 0, message: displayMessage('user', 0, 'Hello') },
  { type: 'assistant', index: 1, message: editMessage, toolPairs: [] },
  { type: 'system-group', messages: [{ index: 2, message: displayMessage('system', 2, 'Hook ran') }] },
  { type: 'compaction', index: 0, timestamp: '2026-05-08T12:00:03.000Z', targetId: 'conversation-compaction-0' },
];

function session(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: 'session-1',
    projectId: 'project-1',
    projectName: 'AgentScope',
    sourceFilePath: 'D:/dev/AgentScope/session-1.jsonl',
    sourceFilePaths: ['D:/dev/AgentScope/session-1.jsonl'],
    timestamp: '2026-05-08T12:00:00.000Z',
    duration: 90_000,
    messageCount: 5,
    userMessageCount: 2,
    assistantMessageCount: 2,
    toolCallCount: 3,
    totalInputTokens: 1000,
    totalOutputTokens: 200,
    totalCacheReadTokens: 300,
    totalCacheWriteTokens: 50,
    estimatedCost: 2,
    estimatedCosts: costs(8),
    model: 'claude-opus-4',
    models: ['Opus', 'Sonnet'],
    gitBranch: 'main',
    cwd: 'D:/dev/AgentScope',
    version: '2.1.130',
    toolsUsed: { Read: 3, Edit: 1 },
    compaction: {
      compactions: 1,
      microcompactions: 1,
      totalTokensSaved: 2048,
      compactionTimestamps: ['2026-05-08T12:00:03.000Z'],
    },
    messages: [
      displayMessage('user', 0, 'Hello'),
      editMessage,
      displayMessage('system', 2, 'Hook ran'),
    ],
    ...overrides,
  };
}

function renderPage() {
  return render(
    <TooltipProvider>
      <SessionDetailPage params={{ id: 'session-1' } as unknown as Promise<{ id: string }>} />
    </TooltipProvider>,
  );
}

let SessionDetailPage: typeof import('@/app/sessions/[id]/page').default;

describe('session detail page', () => {
  beforeEach(async () => {
    detailState.session = undefined;
    detailState.isLoading = false;
    detailState.error = null;
    detailState.sourceInfo = { active: 'live', hasImportedData: false, importMeta: null };
    detailState.mainView = 'conversation';
    detailState.setMainView.mockReset();
    detailState.setDiffMode.mockReset();
    detailState.setToolFilter.mockReset();
    detailState.setSelectedDiffPath.mockReset();
    detailState.setArtifactViewer.mockReset();
    fetchMock.mockReset();
    createObjectUrlMock.mockClear();
    revokeObjectUrlMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrlMock });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrlMock });
    SessionDetailPage = (await import('@/app/sessions/[id]/page')).default;
  });

  it('renders loading and not found states', async () => {
    detailState.isLoading = true;
    renderPage();
    await screen.findByText('Loading session...');

    detailState.isLoading = false;
    detailState.error = new Error('missing');
    detailState.session = null;
    renderPage();
    await screen.findByText('Session not found.');
  });

  it('renders completed conversation details and sidebar metadata', async () => {
    detailState.session = session();

    renderPage();

    await screen.findByRole('heading', { name: 'AgentScope' });
    expect(screen.getByText('Resume session-1')).toBeInTheDocument();
    expect(screen.getByText('compacted')).toBeInTheDocument();
    expect(screen.getByTestId('view-tabs')).toHaveTextContent('conversation 3');
    expect(screen.getByTestId('user-message')).toHaveTextContent('user 0');
    expect(screen.getByTestId('assistant-card')).toHaveTextContent('assistant 1');
    expect(screen.getByTestId('system-group')).toHaveTextContent('system 1');
    expect(screen.getByTestId('compaction')).toHaveTextContent('conversation-compaction-0');
    expect(screen.getByText('Tools Used')).toBeInTheDocument();
    expect(screen.getByText('Context Compaction')).toBeInTheDocument();
    expect(screen.getByText('Metadata')).toBeInTheDocument();
    expect(screen.getByText('Raw Session File')).toBeInTheDocument();
    expect(screen.getByText('session-1.jsonl')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy raw session file path: session-1.jsonl')).toBeInTheDocument();
  });

  it('renders live changes mode and live send controls', async () => {
    detailState.mainView = 'changes';
    detailState.session = session({
      isLive: true,
      liveStatus: 'busy',
      liveActiveToolName: 'Edit',
      liveBusySinceAtMs: Date.now() - 1000,
      compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
    });

    renderPage();

    await screen.findByText('Live');
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByTestId('changes-view')).toHaveTextContent('changes src/app.ts');
    expect(screen.getByTestId('send-box')).toHaveTextContent('send session-1');
  });

  it('downloads the standardized JSON for the viewed session', async () => {
    detailState.session = session();
    fetchMock.mockResolvedValue(new Response('{"id":"session-1"}', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="agentscope-session-session-1.json"',
      },
    }));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Export standardized session JSON' }));

    await screen.findByText('Session JSON exported.');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/export');
    expect(createObjectUrlMock).toHaveBeenCalledOnce();
    expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:session-export');
    expect(clickSpy).toHaveBeenCalledOnce();
    clickSpy.mockRestore();
  });

  it('reports export failures without starting a download', async () => {
    detailState.session = session();
    fetchMock.mockResolvedValue(new Response('{"error":"Session export unavailable"}', {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }));

    renderPage();
    const exportButton = await screen.findByRole('button', { name: 'Export standardized session JSON' });
    fireEvent.click(exportButton);

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Session export unavailable');
    expect(createObjectUrlMock).not.toHaveBeenCalled();
    expect(exportButton).toBeEnabled();
  });
});
