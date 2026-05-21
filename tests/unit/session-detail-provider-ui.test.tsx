import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail } from '@/lib/claude-data/types';

const state = vi.hoisted(() => ({
  session: null as SessionDetail | null,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    use: (usable: unknown) => usable,
  };
});

vi.mock('@/lib/hooks', () => ({
  useDataSourceInfo: () => ({ data: { active: 'live', agents: ['claude', 'codex'], detectedAgents: ['claude', 'codex'], hasImportedData: false, importMeta: null } }),
  useSessionDetail: () => ({ data: state.session, isLoading: false, error: null }),
  useSessionSummary: () => ({ data: state.session || undefined }),
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
      effectiveSelectedDiffPath: null,
      groupedMessages: [{
        type: 'assistant',
        index: 0,
        message: { role: 'assistant', content: 'Codex answer', timestamp: '2026-05-08T12:00:00.000Z' },
        toolPairs: [],
      }],
      mainView: 'conversation',
      minimapSegments: [],
      minimapViewport: { topPct: 0, heightPct: 20 },
      preset: 'narrative',
      presetCounts: { narrative: 0, tools: 0, all: 0 },
      showScrollToBottom: false,
      toolFilter: null,
      unseenMessageCount: 0,
    },
    refs: { bottomRef: { current: null }, conversationRef: { current: null } },
    actions: {
      handleCopyContextPath: vi.fn(),
      handleCopyPatch: vi.fn(),
      handleJumpToDiffMessage: vi.fn(),
      handleJumpToMessage: vi.fn(),
      handleOpenDiffForPath: vi.fn(),
      handlePresetChange: vi.fn(),
      hasDiffForPath: () => false,
      scrollElementIntoConversation: vi.fn(),
      scrollToConversationBottom: vi.fn(),
      setArtifactViewer: vi.fn(),
      setDiffMode: vi.fn(),
      setMainView: vi.fn(),
      setSelectedDiffPath: vi.fn(),
      setToolFilter: vi.fn(),
    },
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@/components/session/artifact-viewer', () => ({
  ArtifactFullscreenViewer: () => <div data-testid="artifact-viewer" />,
}));

vi.mock('@/components/session/context-panel', () => ({
  ContextFilesPanel: () => <div data-testid="context-files" />,
  ContextWindowMeter: () => <div data-testid="context-meter" />,
}));

vi.mock('@/components/session/diff-viewer', () => ({
  ChangesView: () => <div data-testid="changes-view" />,
  SessionViewTabs: () => <div data-testid="view-tabs" />,
}));

vi.mock('@/components/session/minimap', () => ({
  Minimap: () => <div data-testid="minimap" />,
}));

vi.mock('@/components/session/live-session-send-box', () => ({
  LiveSessionSendBox: () => <div data-testid="send-box" />,
}));

vi.mock('@/components/session/live-working-indicator', () => ({
  LiveWorkingIndicator: () => <span>Working</span>,
}));

vi.mock('@/components/session/resume-session-button', () => ({
  ResumeSessionButton: ({ sessionId }: { sessionId: string }) => <button>Resume {sessionId}</button>,
}));

vi.mock('@/components/session/transcript', async () => {
  const { useSessionRenderContext } = await vi.importActual<typeof import('@/components/session/session-render-context')>('@/components/session/session-render-context');
  return {
    AssistantCard: () => <div data-testid="assistant-label">{useSessionRenderContext().assistantLabel}</div>,
    CompactionDivider: () => <div />,
    SystemGroup: () => <div />,
    UserMessage: () => <div />,
  };
});

function costs(api: number) {
  return { api, conservative: api / 2, subscription: api / 4 };
}

function codexSession(): SessionDetail {
  return {
    id: 'codex:session-1',
    agentKind: 'codex',
    nativeId: 'session-1',
    routeId: 'codex:session-1',
    projectId: 'codex:project-1',
    projectName: 'Codex Project',
    title: 'Codex fixture support plan',
    timestamp: '2026-05-08T12:00:00.000Z',
    duration: 1000,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    toolCallCount: 2,
    totalInputTokens: 150,
    totalOutputTokens: 23,
    totalCacheReadTokens: 25,
    totalCacheWriteTokens: 0,
    estimatedCost: 0.02,
    estimatedCosts: costs(0.08),
    model: 'gpt-5.5',
    models: ['gpt-5.5'],
    gitBranch: 'main',
    cwd: 'D:/dev/research/AgentScope',
    version: '0.9.0',
    toolsUsed: { shell_command: 1, apply_patch: 1 },
    compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
    messages: [],
  };
}

describe('session detail provider UI', () => {
  beforeEach(() => {
    state.session = codexSession();
  });

  it('shows Codex provider metadata and hides unsupported resume controls', async () => {
    const SessionDetailPage = (await import('@/app/sessions/[id]/page')).default;
    render(<SessionDetailPage params={{ id: 'codex:session-1' } as unknown as Promise<{ id: string }>} />);

    expect(screen.getByRole('heading', { name: 'Codex Project' })).toBeInTheDocument();
    expect(screen.getByLabelText('Codex agent')).toBeInTheDocument();
    expect(screen.getByText('Provider')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('Route ID')).toBeInTheDocument();
    expect(screen.getByText('codex:session-1')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-label')).toHaveTextContent('Codex');
    expect(screen.queryByText('Resume codex:session-1')).not.toBeInTheDocument();
  });
});
