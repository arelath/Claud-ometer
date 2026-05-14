import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentBadge } from '@/components/agent-badge';

describe('AgentBadge', () => {
  it('renders Claude, Codex, Copilot, and Cursor labels with accessible names', () => {
    render(
      <div>
        <AgentBadge agentKind="claude" />
        <AgentBadge agentKind="codex" />
        <AgentBadge agentKind="copilot" />
        <AgentBadge agentKind="cursor" />
      </div>,
    );

    expect(screen.getByLabelText('Claude agent')).toHaveTextContent('Claude');
    expect(screen.getByLabelText('Codex agent')).toHaveTextContent('Codex');
    expect(screen.getByLabelText('Copilot agent')).toHaveTextContent('Copilot');
    expect(screen.getByLabelText('Cursor agent')).toHaveTextContent('Cursor');
  });

  it('renders an unknown fallback', () => {
    render(<AgentBadge />);

    expect(screen.getByLabelText('Unknown agent')).toHaveTextContent('Unknown');
  });
});
