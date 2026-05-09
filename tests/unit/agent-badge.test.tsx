import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentBadge } from '@/components/agent-badge';

describe('AgentBadge', () => {
  it('renders Claude and Codex labels with accessible names', () => {
    render(
      <div>
        <AgentBadge agentKind="claude" />
        <AgentBadge agentKind="codex" />
      </div>,
    );

    expect(screen.getByLabelText('Claude agent')).toHaveTextContent('Claude');
    expect(screen.getByLabelText('Codex agent')).toHaveTextContent('Codex');
  });

  it('renders an unknown fallback', () => {
    render(<AgentBadge />);

    expect(screen.getByLabelText('Unknown agent')).toHaveTextContent('Unknown');
  });
});
