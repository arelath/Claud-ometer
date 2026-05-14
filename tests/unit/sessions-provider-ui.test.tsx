import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionsClient } from '@/components/pages/sessions-client';
import { CostModeProvider } from '@/lib/cost-mode-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SessionInfo } from '@/lib/claude-data/types';

const navState = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParams: '',
}));

const hookCalls = vi.hoisted(() => ({
  sessions: [] as Array<{ limit: number; offset: number; query: string }>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navState.replace }),
  useSearchParams: () => new URLSearchParams(navState.searchParams),
}));

vi.mock('@/lib/hooks', () => ({
  useCacheStatus: () => ({ data: { status: 'fresh' } }),
  useDataSourceInfo: () => ({ data: { active: 'live', agents: ['claude', 'codex'], detectedAgents: ['claude', 'codex'], hasImportedData: false, importMeta: null } }),
  useLiveSessions: () => ({ data: [] }),
  useSessions: (limit = 50, offset = 0, query = '', fallbackData?: SessionInfo[]) => {
    hookCalls.sessions.push({ limit, offset, query });
    return {
      data: fallbackData ? { sessions: fallbackData.slice(offset, offset + limit), total: fallbackData.length, limit, offset } : undefined,
      isLoading: false,
      mutate: vi.fn(),
    };
  },
}));

vi.mock('@/components/session/resume-session-button', () => ({
  ResumeSessionButton: ({ sessionId }: { sessionId: string }) => <button>Resume {sessionId}</button>,
}));

function costs(api: number) {
  return { api, conservative: api / 2, subscription: api / 4 };
}

function session(id: string, agentKind: 'claude' | 'codex'): SessionInfo {
  return {
    id,
    agentKind,
    nativeId: id.replace(/^codex:/, ''),
    routeId: id,
    projectId: `${agentKind}:project`,
    projectName: agentKind === 'codex' ? 'Codex Project' : 'Claude Project',
    timestamp: agentKind === 'codex' ? '2026-05-08T12:00:00.000Z' : '2026-05-07T12:00:00.000Z',
    duration: 1000,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    toolCallCount: 1,
    totalInputTokens: 100,
    totalOutputTokens: 25,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    estimatedCost: 0.01,
    estimatedCosts: costs(0.04),
    model: agentKind === 'codex' ? 'gpt-5.5' : 'claude-opus-4',
    models: agentKind === 'codex' ? ['gpt-5.5'] : ['Opus'],
    gitBranch: 'main',
    cwd: 'D:/dev/project',
    version: 'test',
    toolsUsed: { Read: 1 },
    compaction: { compactions: 0, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: [] },
  };
}

function renderSessions(sessions: SessionInfo[]) {
  render(
    <CostModeProvider>
      <TooltipProvider>
        <SessionsClient initialSessions={sessions} initialQuery="" />
      </TooltipProvider>
    </CostModeProvider>,
  );
}

describe('sessions provider UI', () => {
  it('shows provider badges, qualified links, and hides Codex resume controls', () => {
    navState.searchParams = '';
    hookCalls.sessions = [];
    renderSessions([
      session('claude-session', 'claude'),
      session('codex:codex-session', 'codex'),
    ]);

    expect(screen.getByLabelText('Claude agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Codex agent')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Codex Project/i })).toHaveAttribute('href', '/sessions/codex:codex-session');
    expect(screen.getByText('Resume claude-session')).toBeInTheDocument();
    expect(screen.queryByText('Resume codex:codex-session')).not.toBeInTheDocument();
  });

  it('requests the second 50-session page from the sessions API', () => {
    navState.searchParams = 'page=2';
    hookCalls.sessions = [];

    renderSessions([session('second-page-session', 'claude')]);

    expect(hookCalls.sessions.at(-1)).toMatchObject({ limit: 50, offset: 50, query: '' });
  });

  it('renders 50-session pagination controls and links to the next page', () => {
    navState.searchParams = '';
    navState.replace.mockClear();
    hookCalls.sessions = [];

    renderSessions(Array.from({ length: 51 }, (_, index) => session(`session-${index + 1}`, 'claude')));

    expect(screen.getByText('Showing 1-50 of 51')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Next/i }));

    expect(navState.replace).toHaveBeenCalledWith('/sessions?page=2', { scroll: false });
  });
});
