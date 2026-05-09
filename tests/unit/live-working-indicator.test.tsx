import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveWorkingIndicator } from '@/components/session/live-working-indicator';

describe('LiveWorkingIndicator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows how long Claude has been working', () => {
    const busySinceAtMs = new Date('2026-05-06T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(busySinceAtMs + 65_000);

    render(<LiveWorkingIndicator busySinceAtMs={busySinceAtMs} />);

    expect(screen.getByTitle('Claude has been working for 1m 05s')).toBeInTheDocument();
    expect(screen.getByText('1m 05s')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(screen.getByText('1m 09s')).toBeInTheDocument();
  });

  it('uses the active tool as the working status when available', () => {
    const busySinceAtMs = new Date('2026-05-06T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(busySinceAtMs + 5_000);

    render(<LiveWorkingIndicator activeToolName="Bash" busySinceAtMs={busySinceAtMs} />);

    expect(screen.getByText('Running Bash')).toBeInTheDocument();
  });
});
