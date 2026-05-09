import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import { ManagedPtyConsole } from '@/components/session/managed-pty-console';
import { ToastProvider } from '@/components/ui/toast';

const {
  fitAddonInstances,
  FitAddonMock,
  terminalInstances,
  TerminalMock,
} = vi.hoisted(() => {
  const terminalInstances: Array<{
    cols: number;
    rows: number;
    options: { disableStdin?: boolean };
    dataCallback?: (data: string) => void;
    dispose: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  }> = [];
  const fitAddonInstances: Array<{ fit: ReturnType<typeof vi.fn> }> = [];

  const TerminalMock = vi.fn(function Terminal(this: {
    cols: number;
    rows: number;
    options: { disableStdin?: boolean };
    dataCallback?: (data: string) => void;
    dispose: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  }) {
    this.cols = 120;
    this.rows = 32;
    this.options = {};
    this.dispose = vi.fn();
    this.focus = vi.fn();
    this.loadAddon = vi.fn();
    this.open = vi.fn();
    this.reset = vi.fn();
    this.write = vi.fn();
    this.onData = vi.fn((callback: (data: string) => void) => {
      this.dataCallback = callback;
      return { dispose: vi.fn() };
    });
    terminalInstances.push(this);
  });

  const FitAddonMock = vi.fn(function FitAddon(this: { fit: ReturnType<typeof vi.fn> }) {
    this.fit = vi.fn();
    fitAddonInstances.push(this);
  });

  return { fitAddonInstances, FitAddonMock, terminalInstances, TerminalMock };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: TerminalMock,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: FitAddonMock,
}));

function renderConsole() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <ToastProvider>
        <ManagedPtyConsole sessionId="00000000-0000-4000-8000-000000000123" />
      </ToastProvider>
    </SWRConfig>,
  );
}

describe('ManagedPtyConsole', () => {
  afterEach(() => {
    terminalInstances.length = 0;
    fitAddonInstances.length = 0;
    TerminalMock.mockClear();
    FitAddonMock.mockClear();
    vi.unstubAllGlobals();
  });

  it('renders raw PTY output through xterm and sends raw key data', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify({
        sessionId: '00000000-0000-4000-8000-000000000123',
        cwd: 'D:/dev/project',
        output: '\u001b[32mClaude is ready\u001b[0m',
        isRunning: true,
        sequence: 1,
        transport: 'managed-pty',
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConsole();

    expect(await screen.findByTestId('managed-pty-console')).toBeInTheDocument();
    await waitFor(() => {
      expect(terminalInstances[0]?.write).toHaveBeenCalledWith('\u001b[32mClaude is ready\u001b[0m');
    });

    terminalInstances[0].dataCallback?.('\u001b[A');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/live-sessions/00000000-0000-4000-8000-000000000123/terminal',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ data: '\u001b[A' }),
        }),
      );
    });
  });

  it('does not write input when no managed PTY session is available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sessionId: '00000000-0000-4000-8000-000000000123',
      output: '',
      isRunning: false,
      sequence: 1,
    }), { status: 200 })));

    renderConsole();

    expect(await screen.findByText('Console is available for managed PTY sessions.')).toBeInTheDocument();
    terminalInstances[0].dataCallback?.('a');

    expect(fetch).not.toHaveBeenCalledWith(
      '/api/live-sessions/00000000-0000-4000-8000-000000000123/terminal',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows running, exited, and fetch error overlays', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sessionId: '00000000-0000-4000-8000-000000000123',
      output: '',
      isRunning: true,
      sequence: 1,
      transport: 'managed-pty',
    }), { status: 200 })));

    const { unmount } = renderConsole();
    expect(await screen.findByText('Starting Claude...')).toBeInTheDocument();
    unmount();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sessionId: '00000000-0000-4000-8000-000000000123',
      output: 'done',
      isRunning: false,
      exitCode: 2,
      sequence: 2,
      transport: 'managed-pty',
    }), { status: 200 })));
    renderConsole();
    expect(await screen.findByText('Terminal exited with code 2.')).toBeInTheDocument();
    unmount();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'terminal missing' }), { status: 404 })));
    renderConsole();
    expect(await screen.findByText('Console unavailable')).toBeInTheDocument();
    expect(screen.getByText('terminal missing')).toBeInTheDocument();
  });

  it('reports input send failures without duplicating the same toast', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'write failed' }), { status: 500 });
      }

      return new Response(JSON.stringify({
        sessionId: '00000000-0000-4000-8000-000000000123',
        output: 'ready',
        isRunning: true,
        sequence: 1,
        transport: 'managed-pty',
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConsole();

    await waitFor(() => {
      expect(terminalInstances[0]?.write).toHaveBeenCalledWith('ready');
    });
    terminalInstances[0].dataCallback?.('x');
    terminalInstances[0].dataCallback?.('y');

    expect(await screen.findByText('Console input failed')).toBeInTheDocument();
    expect(screen.getByText('write failed')).toBeInTheDocument();
  });
});
