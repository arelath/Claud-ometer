import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataPage from '@/app/data/page';
import SettingsPage from '@/app/settings/page';
import { AppShell } from '@/components/layout/app-shell';
import { Providers } from '@/components/providers';
import { Sidebar } from '@/components/layout/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { LiveSessionInfo } from '@/lib/claude-data/types';

const appState = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  swrMutate: vi.fn(),
  globalMutate: vi.fn(),
  pathname: '/data',
  resolvedTheme: 'dark',
  setTheme: vi.fn(),
  liveSessions: [] as LiveSessionInfo[],
}));

vi.mock('swr', () => ({
  default: (key: string) => ({
    data: appState.data.get(key),
    mutate: appState.swrMutate,
  }),
  mutate: appState.globalMutate,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => appState.pathname,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('next-themes', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="theme-provider">{children}</div>,
  useTheme: () => ({ resolvedTheme: appState.resolvedTheme, setTheme: appState.setTheme }),
}));

vi.mock('@/lib/hooks', () => ({
  useLiveSessions: () => ({ data: appState.liveSessions }),
}));

vi.mock('@/components/session/live-working-indicator', () => ({
  LiveWorkingIndicator: ({ compact }: { compact?: boolean }) => <span>{compact ? 'Working compact' : 'Working'}</span>,
}));

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function dataSource(
  active: 'live' | 'imported' = 'imported',
  agents: Array<'claude' | 'codex' | 'copilot' | 'cursor'> = ['claude'],
  detectedAgents: Array<'claude' | 'codex' | 'copilot' | 'cursor'> = ['claude', 'codex'],
) {
  return {
    active,
    agents,
    detectedAgents,
    hasImportedData: true,
    importMeta: {
      importedAt: '2026-05-08T12:00:00.000Z',
      exportedAt: '2026-05-07T12:00:00.000Z',
      exportedFrom: 'Unit Test Laptop',
      projectCount: 2,
      sessionCount: 4,
      fileCount: 8,
      totalSize: 1536,
    },
  };
}

function liveSession(overrides: Partial<LiveSessionInfo> = {}): LiveSessionInfo {
  return {
    id: 'live-1',
    sessionId: 'live-session-1',
    metadataFilePath: 'live-session.json',
    cwd: 'D:/dev/Claudometer',
    projectName: 'Claudometer',
    version: '2.1.130',
    startedAt: '2026-05-08T11:00:00.000Z',
    lastActivityAt: '2026-05-08T12:00:00.000Z',
    updatedAtMs: new Date('2026-05-08T12:00:00.000Z').getTime(),
    cacheLastActivityAt: '2026-05-08T12:00:00.000Z',
    cacheLastActivityAtMs: new Date('2026-05-08T12:00:00.000Z').getTime(),
    cacheExpiresAt: '2026-05-08T12:05:00.000Z',
    cacheExpiresAtMs: new Date('2026-05-08T12:05:00.000Z').getTime(),
    cachePaused: true,
    status: 'busy',
    rawStatus: 'busy',
    statusReason: 'metadata status is busy',
    busySinceAt: '2026-05-08T11:59:00.000Z',
    busySinceAtMs: new Date('2026-05-08T11:59:00.000Z').getTime(),
    messageCount: 3,
    toolCallCount: 1,
    lastPreview: 'Editing docs',
    activeToolName: 'Edit',
    revision: 'metadata-rev',
    ...overrides,
  };
}

describe('data, settings, and layout surfaces', () => {
  beforeEach(() => {
    appState.data.clear();
    appState.swrMutate.mockReset();
    appState.globalMutate.mockReset();
    appState.pathname = '/data';
    appState.resolvedTheme = 'dark';
    appState.setTheme.mockReset();
    appState.liveSessions = [];
    global.fetch = vi.fn();
  });

  it('manages imported data source actions and status messages', async () => {
    appState.data.set('/api/data-source', dataSource('imported'));
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url === '/api/data-source' && method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === '/api/import' && method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === '/api/import' && method === 'POST') {
        return new Response(JSON.stringify({ meta: { projectCount: 3, sessionCount: 9 } }), { status: 200 });
      }
      return new Response('{}', { status: 500 });
    });

    const { container } = render(<DataPage />);

    expect(screen.getByText('Data Management')).toBeInTheDocument();
    expect(screen.getByText('Unit Test Laptop')).toBeInTheDocument();
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Live Data'));
    await screen.findByText('Switched to live agent data.');

    fireEvent.click(screen.getByText('Clear Imported Data'));
    await screen.findByText('Imported data cleared. Switched back to live data.');

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['zip'], 'claude-data.zip', { type: 'application/zip' })] },
    });
    await screen.findByText('Imported 3 projects, 9 sessions. Dashboard switched to imported data.');

    expect(fetchMock).toHaveBeenCalledWith('/api/data-source', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ source: 'live' }),
    }));
    expect(fetchMock).toHaveBeenCalledWith('/api/import', { method: 'DELETE' });
    expect(appState.swrMutate).toHaveBeenCalled();
    expect(appState.globalMutate).toHaveBeenCalled();
  });

  it('toggles agent sources independently and allows all sources to be disabled', async () => {
    appState.data.set('/api/data-source', dataSource(
      'live',
      ['claude', 'cursor'],
      ['claude', 'codex', 'copilot', 'cursor'],
    ));
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    render(<DataPage />);

    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle Claude data')).toBeChecked();
    expect(screen.getByLabelText('Toggle Cursor data')).toBeChecked();
    expect(screen.getByLabelText('Toggle Codex data')).not.toBeChecked();

    fireEvent.click(screen.getByLabelText('Toggle Codex data'));
    await screen.findByText('Selected Claude + Codex + Cursor data.');

    expect(fetchMock).toHaveBeenCalledWith('/api/data-source', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ source: 'live', agents: ['claude', 'codex', 'cursor'] }),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Disable all' }));
    await screen.findByText('No agent sources selected. Dashboard will show no sessions.');

    expect(fetchMock).toHaveBeenCalledWith('/api/data-source', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ source: 'live', agents: [] }),
    }));
  });

  it('downloads exports and reports export failures', async () => {
    appState.data.set('/api/data-source', dataSource('live'));
    const click = vi.fn();
    const createElement = vi.spyOn(document, 'createElement');
    createElement.mockImplementation((tagName: string) => {
      const element = document.createElementNS('http://www.w3.org/1999/xhtml', tagName);
      if (tagName === 'a') {
        Object.defineProperty(element, 'click', { configurable: true, value: click });
      }
      return element as HTMLElement;
    });
    URL.createObjectURL = vi.fn(() => 'blob:export');
    URL.revokeObjectURL = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(['zip']), {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="claude-export.zip"' },
    }));

    render(<DataPage />);

    fireEvent.click(screen.getByText('Export as ZIP'));
    await screen.findByText('Export downloaded successfully!');
    expect(click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export');

    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 500 }));
    fireEvent.click(screen.getByText('Export as ZIP'));
    await screen.findByText('Failed to export data.');
  });

  it('updates live mode settings and handles locked or failing transport updates', async () => {
    appState.data.set('/api/settings/live-mode', {
      resumeTransport: 'msys2-launch',
      resumeTransportSource: 'stored',
      msys2Launch: { available: true, root: 'C:/msys64' },
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      resumeTransport: 'pty',
      resumeTransportSource: 'stored',
      msys2Launch: { available: true, root: 'C:/msys64' },
    }), { status: 200 }));

    const { rerender } = render(<SettingsPage />);

    expect(screen.getByText('Live Session Resume')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /PTYManaged terminal and console/i }));
    await screen.findByText('Resume transport set to PTY.');
    expect(appState.swrMutate).toHaveBeenCalledWith(expect.objectContaining({ resumeTransport: 'pty' }), { revalidate: false });

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Transport unavailable' }), { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: /MSYS2 launchC:\/msys64/i }));
    await screen.findByText('Transport unavailable');

    appState.data.set('/api/settings/live-mode', {
      resumeTransport: 'pty',
      resumeTransportSource: 'env',
      msys2Launch: { available: false, error: 'MSYS2 launch not found' },
    });
    rerender(<SettingsPage />);

    expect(screen.getByText('Set by environment.')).toBeInTheDocument();
    expect(screen.getByText('MSYS2 launch not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /MSYS2 launch/i })).toBeDisabled();
  });

  it('renders sidebar navigation, live sessions, imported badge, and theme toggle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:02:00.000Z'));
    appState.pathname = '/sessions/live-session-1';
    appState.data.set('/api/data-source', dataSource('imported'));
    appState.liveSessions = [
      liveSession(),
      liveSession({
        id: 'idle-1',
        sessionId: 'idle-session',
        metadataFilePath: 'idle.json',
        projectName: 'Idle Project',
        status: 'idle',
        rawStatus: 'idle',
        cachePaused: false,
        cacheExpiresAtMs: new Date('2026-05-08T12:01:00.000Z').getTime(),
        cacheExpiresAt: '2026-05-08T12:01:00.000Z',
        lastPreview: 'Waiting',
      }),
    ];

    renderWithTooltip(<Sidebar />);

    expect(screen.getByText('Claud-ometer')).toBeInTheDocument();
    expect(screen.getByText('Live Sessions')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Claudometer')).toBeInTheDocument();
    expect(screen.getByText('Working compact')).toBeInTheDocument();
    expect(screen.getByText('Cache 5m paused')).toBeInTheDocument();
    expect(screen.getByText('Cache expired')).toBeInTheDocument();
    expect(screen.getByText('Imported')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Light Mode'));
    expect(appState.setTheme).toHaveBeenCalledWith('light');
    vi.useRealTimers();
  });

  it('renders empty live sessions and normal app shell layout', () => {
    appState.pathname = '/projects';
    appState.data.set('/api/data-source', dataSource('live'));
    appState.liveSessions = [];

    renderWithTooltip(
      <AppShell>
        <div>Shell content</div>
      </AppShell>,
    );

    expect(screen.getByText('No live sessions')).toBeInTheDocument();
    expect(screen.getByText('Reading Claude data')).toBeInTheDocument();
    expect(screen.getByText('Shell content').parentElement).toHaveClass('max-w-7xl');
  });

  it('uses focused shells for session detail and console routes', () => {
    appState.data.set('/api/data-source', dataSource('live'));
    appState.pathname = '/sessions/session-1';
    const { rerender } = renderWithTooltip(
      <AppShell>
        <div>Session content</div>
      </AppShell>,
    );
    expect(screen.getByText('Session content').parentElement).toHaveClass('max-w-[104rem]');

    appState.pathname = '/sessions/session-1/console';
    rerender(
      <TooltipProvider>
        <AppShell>
          <div>Console content</div>
        </AppShell>
      </TooltipProvider>,
    );

    expect(screen.queryByText('Claud-ometer')).not.toBeInTheDocument();
    expect(screen.getByText('Console content').closest('main')).toHaveClass('bg-black');
  });

  it('composes application providers', () => {
    render(
      <Providers>
        <div>Provided content</div>
      </Providers>,
    );

    expect(screen.getByTestId('theme-provider')).toBeInTheDocument();
    expect(screen.getByText('Provided content')).toBeInTheDocument();
  });
});
