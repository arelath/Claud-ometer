import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import { ManagedTerminalPanel } from '@/components/session/managed-terminal-panel';

function renderPanel() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <ManagedTerminalPanel sessionId="00000000-0000-4000-8000-000000000123" />
    </SWRConfig>,
  );
}

describe('ManagedTerminalPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows stripped terminal output for managed sessions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sessionId: '00000000-0000-4000-8000-000000000123',
      cwd: 'D:/dev/project',
      output: '\u001b[32mClaude is ready\u001b[0m',
      isRunning: true,
      sequence: 1,
    }), { status: 200 })));

    renderPanel();

    expect(await screen.findByText('Managed Terminal')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('Claude is ready')).toBeInTheDocument();
  });

  it('stays hidden when no managed terminal exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', { status: 200 })));

    renderPanel();

    await expect(screen.findByText('Managed Terminal', {}, { timeout: 250 })).rejects.toThrow();
  });
});
