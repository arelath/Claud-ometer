import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CostModeProvider, useCostMode } from '@/lib/cost-mode-context';

function CostModeProbe() {
  const { costMode, label, pickCost, setCostMode } = useCostMode();
  const picked = pickCost({ api: 9, conservative: 5, subscription: 2 }, 99);
  const fallback = pickCost(undefined, 12);

  return (
    <div>
      <div data-testid="mode">{costMode}</div>
      <div data-testid="label">{label.name}</div>
      <div data-testid="picked">{picked}</div>
      <div data-testid="fallback">{fallback}</div>
      <button type="button" onClick={() => setCostMode('api')}>api</button>
    </div>
  );
}

describe('CostModeProvider', () => {
  it('uses the default mode and picks matching cost estimates', () => {
    localStorage.clear();

    render(
      <CostModeProvider>
        <CostModeProbe />
      </CostModeProvider>,
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('subscription');
    expect(screen.getByTestId('label')).toHaveTextContent('Subscription');
    expect(screen.getByTestId('picked')).toHaveTextContent('2');
    expect(screen.getByTestId('fallback')).toHaveTextContent('12');
  });

  it('loads, updates, and persists the selected mode', async () => {
    localStorage.setItem('claud-ometer-cost-mode', 'conservative');

    render(
      <CostModeProvider>
        <CostModeProbe />
      </CostModeProvider>,
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('conservative');
    expect(screen.getByTestId('picked')).toHaveTextContent('5');

    fireEvent.click(screen.getByRole('button', { name: 'api' }));

    expect(screen.getByTestId('mode')).toHaveTextContent('api');
    expect(screen.getByTestId('picked')).toHaveTextContent('9');
    expect(localStorage.getItem('claud-ometer-cost-mode')).toBe('api');
  });

  it('rejects use outside the provider', () => {
    expect(() => render(<CostModeProbe />)).toThrow('useCostMode must be used within CostModeProvider');
  });
});
