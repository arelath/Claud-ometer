import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveSessionSendBox } from '@/components/session/live-session-send-box';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ToastProvider } from '@/components/ui/toast';
import type { LiveSessionStatus } from '@/lib/claude-data/types';

function renderSendBox(status?: LiveSessionStatus) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <TooltipProvider>
        <ToastProvider>
          <LiveSessionSendBox sessionId="00000000-0000-4000-8000-000000000123" liveStatus={status} />
        </ToastProvider>
      </TooltipProvider>
    </SWRConfig>,
  );
}

function mockSendBoxFetch({
  sendResponse = new Response(JSON.stringify({ ok: true }), { status: 200 }),
  terminal = null,
  transport = 'pty',
}: {
  sendResponse?: Response;
  terminal?: unknown;
  transport?: 'pty' | 'msys2-launch';
} = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/settings/live-mode') {
      return new Response(JSON.stringify({ resumeTransport: transport }), { status: 200 });
    }
    if (url.includes('/terminal')) {
      return new Response(JSON.stringify(terminal), { status: 200 });
    }
    if (init?.method === 'POST') return sendResponse;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('LiveSessionSendBox', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('allows drafting but blocks sends while the live session is busy', () => {
    mockSendBoxFetch();
    renderSendBox('busy');

    const textbox = screen.getByRole('textbox');
    expect(textbox).toBeEnabled();
    fireEvent.change(textbox, { target: { value: 'Draft for later.' } });
    expect(textbox).toHaveValue('Draft for later.');
    expect(screen.getByRole('button', { name: 'Send message to live session' })).toBeDisabled();
    expect(screen.getByPlaceholderText('Draft a message while Claude is working')).toBeInTheDocument();
  });

  it('allows sending when the live session is idle', async () => {
    const fetchMock = mockSendBoxFetch();
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
    const fetchMock = mockSendBoxFetch();
    renderSendBox('idle');

    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'First line' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    fireEvent.keyDown(textbox, { key: 'Enter' });

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    });
  });

  it('surfaces API errors', async () => {
    mockSendBoxFetch({
      sendResponse: new Response(JSON.stringify({ error: 'No managed PTY session was found.' }), { status: 409 }),
    });
    renderSendBox('idle');

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message to live session' }));

    expect(await screen.findAllByText('No managed PTY session was found.')).toHaveLength(2);
    expect(await screen.findByText('Message not sent')).toBeInTheDocument();
  });

  it('shows an icon-only PTY console button next to send when a managed PTY is running', async () => {
    const focusMock = vi.fn();
    const openMock = vi.spyOn(window, 'open').mockReturnValue({ focus: focusMock } as unknown as Window);
    mockSendBoxFetch({ terminal: { isRunning: true, transport: 'managed-pty' } });
    renderSendBox('idle');

    const button = await screen.findByRole('button', { name: 'Open PTY console' });
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent('');

    fireEvent.click(button);
    expect(openMock).toHaveBeenCalledWith(
      '/sessions/00000000-0000-4000-8000-000000000123/console',
      'agentscope-console-00000000-0000-4000-8000-000000000123',
      'popup,width=1120,height=780',
    );
    expect(focusMock).toHaveBeenCalled();
  });

  it('hides app-side input controls for MSYS2 launch mode', async () => {
    mockSendBoxFetch({ transport: 'msys2-launch' });
    renderSendBox('idle');

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send message to live session' })).not.toBeInTheDocument();
    });
  });
});
