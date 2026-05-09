import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDetailClient } from '@/components/pages/project-detail-client';
import { ProjectsClient } from '@/components/pages/projects-client';
import { CostModeProvider } from '@/lib/cost-mode-context';
import type { ProjectInfo, SessionInfo } from '@/lib/claude-data/types';

vi.mock('@/lib/hooks', () => ({
  useProjects: (fallbackData?: ProjectInfo[]) => ({ data: fallbackData, isLoading: false }),
  useProjectSessions: (_projectId: string, fallbackData?: SessionInfo[]) => ({ data: fallbackData, isLoading: false }),
}));

function costs(api: number) {
  return { api, conservative: api / 2, subscription: api / 4 };
}

const codexProject: ProjectInfo = {
  id: 'codex:D-dev-Claud-ometer',
  agentKind: 'codex',
  nativeId: 'D-dev-Claud-ometer',
  routeId: 'codex:D-dev-Claud-ometer',
  name: 'Claud-ometer',
  path: 'D:/dev/research/Claud-ometer',
  sessionCount: 1,
  totalMessages: 3,
  totalTokens: 198,
  estimatedCost: 0.02,
  estimatedCosts: costs(0.08),
  lastActive: '2026-05-08T12:00:00.000Z',
  models: ['gpt-5.5'],
};

const claudeProject: ProjectInfo = {
  id: 'claude:D-dev-Claud-ometer',
  agentKind: 'claude',
  nativeId: 'D-dev-Claud-ometer',
  routeId: 'claude:D-dev-Claud-ometer',
  name: 'Claud-ometer',
  path: 'D:/dev/research/Claud-ometer',
  sessionCount: 1,
  totalMessages: 5,
  totalTokens: 800,
  estimatedCost: 0.2,
  estimatedCosts: costs(0.8),
  lastActive: '2026-05-07T12:00:00.000Z',
  models: ['Opus'],
};

const codexSession: SessionInfo = {
  id: 'codex:session-1',
  agentKind: 'codex',
  nativeId: 'session-1',
  routeId: 'codex:session-1',
  projectId: codexProject.id,
  projectName: 'Claud-ometer',
  timestamp: '2026-05-08T12:00:00.000Z',
  duration: 1000,
  messageCount: 3,
  userMessageCount: 1,
  assistantMessageCount: 2,
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
  cwd: 'D:/dev/research/Claud-ometer',
  version: '0.9.0',
  toolsUsed: { shell_command: 1, apply_patch: 1 },
  compaction: { compactions: 1, microcompactions: 0, totalTokensSaved: 0, compactionTimestamps: ['2026-05-08T12:01:00.000Z'] },
};

function renderWithCost(ui: React.ReactElement) {
  render(<CostModeProvider>{ui}</CostModeProvider>);
}

describe('projects provider UI', () => {
  it('keeps same-basename Claude and Codex projects distinct', () => {
    renderWithCost(<ProjectsClient initialProjects={[codexProject, claudeProject]} />);

    expect(screen.getAllByText('Claud-ometer')).toHaveLength(2);
    expect(screen.getByLabelText('Codex agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Claude agent')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /gpt-5.5/i })).toHaveAttribute('href', '/projects/codex%3AD-dev-Claud-ometer');
    expect(screen.getByRole('link', { name: /Opus/i })).toHaveAttribute('href', '/projects/claude%3AD-dev-Claud-ometer');
  });

  it('preserves provider-qualified session links from project detail', () => {
    renderWithCost(<ProjectDetailClient projectId={codexProject.id} initialSessions={[codexSession]} />);

    expect(screen.getByRole('heading', { name: 'Claud-ometer' })).toBeInTheDocument();
    expect(screen.getAllByLabelText('Codex agent').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /gpt-5.5/i })).toHaveAttribute('href', '/sessions/codex:session-1');
  });
});
