import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveSessionSendBox } from '@/components/session/live-session-send-box';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { LiveSessionStatus } from '@/lib/claude-data/types';

function renderSendBox(status?: LiveSessionStatus) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <TooltipProvider>
        <LiveSessionSendBox sessionId="00000000-0000-4000-8000-000000000123" liveStatus={status} />
      </TooltipProvider>
    </SWRConfig>,
  );
}

describe('LiveSessionSendBox', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks sends while the live session is busy', () => {
    renderSendBox('busy');

    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send message to live session' })).toBeDisabled();
    expect(screen.getByPlaceholderText('Claude is busy')).toBeInTheDocument();
  });

  it('allows sending when the live session is idle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderSendBox('idle');

    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'Continue from here.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message to live session' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/live-sessions/00000000-0000-4000-8000-000000000123/send',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ text: 'Continue from here.' }),
        }),
      );
    });
    expect(textbox).toHaveValue('');
  });

  it('submits with Enter and preserves Shift+Enter for multiline input', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderSendBox('idle');

    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'First line' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });

    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(textbox, { key: 'Enter' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('surfaces API errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'tmux is not available on PATH.' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    renderSendBox('idle');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message to live session' }));

    expect(await screen.findByText('tmux is not available on PATH.')).toBeInTheDocument();
  });
});
