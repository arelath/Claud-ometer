import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    use: (usable: unknown) => usable,
  };
});

vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'geist-sans' }),
  Geist_Mono: () => ({ variable: 'geist-mono' }),
}));

vi.mock('@/components/providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <div data-testid="providers">{children}</div>,
}));

vi.mock('@/components/layout/app-shell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main data-testid="app-shell">{children}</main>,
}));

vi.mock('@/components/session/managed-pty-console', () => ({
  ManagedPtyConsole: ({ sessionId }: { sessionId: string }) => <div>Console {sessionId}</div>,
}));

describe('root layout and console page', () => {
  it('wraps children in providers and app shell with metadata exported', async () => {
    const { default: RootLayout, metadata } = await import('@/app/layout');

    render(
      <RootLayout>
        <div>Layout child</div>
      </RootLayout>,
    );

    expect(metadata).toMatchObject({
      title: 'AgentScope',
      description: 'Local-first analytics dashboard for code agent sessions',
    });
    expect(screen.getByTestId('providers')).toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).toHaveTextContent('Layout child');
  });

  it('renders the managed pty console for a session route', async () => {
    const { default: SessionConsolePage } = await import('@/app/sessions/[id]/console/page');

    render(<SessionConsolePage params={{ id: 'session-1' } as unknown as Promise<{ id: string }>} />);

    expect(screen.getByText('Console session-1')).toBeInTheDocument();
    expect(screen.getByText('Console session-1').parentElement).toHaveClass('bg-black');
  });
});
