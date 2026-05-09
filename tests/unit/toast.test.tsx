import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToastProvider, useToast } from '@/components/ui/toast';

function ToastTrigger() {
  const toast = useToast();

  return (
    <button type="button" onClick={() => toast.error('Could not launch Claude', 'Install MSYS2 or choose PTY in Settings.')}>
      Show toast
    </button>
  );
}

describe('ToastProvider', () => {
  it('renders and dismisses app-wide toast messages', () => {
    render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Could not launch Claude')).toBeInTheDocument();
    expect(screen.getByText('Install MSYS2 or choose PTY in Settings.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));

    expect(screen.queryByText('Could not launch Claude')).not.toBeInTheDocument();
  });
});
