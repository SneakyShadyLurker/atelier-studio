import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import Composer from './index';
import { useKeyboard } from '../../hooks/useKeyboard';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import { fixtureModels } from '../../../test/fixtures/models';
import type { Count } from '../../store/atelier';
import type { Ratio } from '@atelier/shared';
import type { Model } from '@atelier/shared';

const firstModel = fixtureModels[0];
if (!firstModel) throw new Error('fixtureModels must have at least one entry');

const originalMatchMedia = window.matchMedia.bind(window);

const baseProps = {
  models: fixtureModels,
  modelById: new Map<string, Model>(fixtureModels.map((m) => [m.id, m])),
  prompt: 'hello',
  modelId: firstModel.id,
  ratio: '1:1' as Ratio,
  count: 2 as Count,
  onPromptChange: mock(),
  onModelChange: mock(),
  onRatioChange: mock(),
  onDurationChange: mock(),
  onCountChange: mock(),
  onSubmit: mock(),
};

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function TestWrapper({ children }: { children: ReactNode }) {
    useKeyboard([]);
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function installMatchMedia(isPhone = false): void {
  window.matchMedia = mock((query: string) => ({
    matches: isPhone,
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });
afterEach(() => {
  cleanup();
  mock.restore();
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState(initialAtelierState, true);
});

describe('Composer roll-queue chip', () => {
  test('chip is hidden when rollQueue is empty', () => {
    render(<Composer {...baseProps} />, { wrapper: wrapper() });
    expect(screen.queryByRole('button', { name: /roll-queue/i })).toBeNull();
  });

  test('chip is visible with count when rollQueue has items', () => {
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue: [
        { id: 'a', text: 'one', seed: 1, source: 'template' as const },
        { id: 'b', text: 'two', seed: 2, source: 'template' as const },
      ]},
    }));
    render(<Composer {...baseProps} />, { wrapper: wrapper() });
    expect(screen.getByRole('button', { name: /roll-queue · 2/i })).toBeTruthy();
  });

  test('clicking the chip toggles the expanded queue list', () => {
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue: [
        { id: 'a', text: 'expanded prompt', seed: 1, source: 'template' as const },
      ]},
    }));
    render(<Composer {...baseProps} />, { wrapper: wrapper() });
    expect(screen.queryByText('expanded prompt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /roll-queue · 1/i }));
    expect(screen.getByText('expanded prompt')).toBeTruthy();
  });

  test('expanded queue shows target context, current prompt, row seeds, and keyboard reorder', () => {
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue: [
        { id: 'a', text: 'first queued prompt', seed: 11, source: 'template' as const },
        { id: 'b', text: 'second queued prompt', seed: 22, source: 'template' as const },
      ]},
    }));
    render(<Composer {...baseProps} />, { wrapper: wrapper() });
    fireEvent.click(screen.getByRole('button', { name: /roll-queue · 2/i }));

    const region = screen.getByRole('region', { name: /composer roll-queue/i });
    expect(within(region).getByText(/will run on/i).textContent).toContain(firstModel.name);
    expect(within(region).getByText(/1:1/)).toBeTruthy();
    expect(within(region).getByText(/×2/)).toBeTruthy();
    expect(within(region).getByText(/0 refs/)).toBeTruthy();
    expect(within(region).getByText('Current prompt')).toBeTruthy();
    expect(within(region).getByText('hello')).toBeTruthy();
    expect(within(region).getByText('Seed 11')).toBeTruthy();
    expect(within(region).getByText('Seed 22')).toBeTruthy();

    const rows = within(region).getAllByRole('listitem');
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    if (!firstRow) return;
    act(() => { firstRow.focus(); });
    fireEvent.keyDown(firstRow, { key: 'ArrowDown', altKey: true });
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['b', 'a']);
  });

  test('phone collapsed bar shows queued count and expands the queue directly', async () => {
    installMatchMedia(true);
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue: [
        { id: 'a', text: 'phone prompt one', seed: 1, source: 'template' as const },
        { id: 'b', text: 'phone prompt two', seed: 2, source: 'template' as const },
      ]},
      view: { ...state.view, composerExpanded: false },
    }));
    render(<Composer {...baseProps} />, { wrapper: wrapper() });

    expect(screen.getByText('· 2 queued')).toBeTruthy();
    // Expanding focuses the prompt in a microtask; flush it inside act.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /expand composer/i })); await Promise.resolve(); });
    expect(screen.getByRole('region', { name: /composer roll-queue/i })).toBeTruthy();
    expect(screen.getByText('phone prompt one')).toBeTruthy();
  });

  test('Generate button label adapts: "Generate 3" when queue has 2 + active prompt', () => {
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue: [
        { id: 'a', text: 'one', seed: 1, source: 'template' as const },
        { id: 'b', text: 'two', seed: 2, source: 'template' as const },
      ]},
    }));
    render(<Composer {...baseProps} />, { wrapper: wrapper() });
    // The Generate button currently reads "Generate" + arrow icon.
    // Use a substring matcher so the trailing space + icon don't interfere.
    expect(screen.getByRole('button', { name: /generate 3/i })).toBeTruthy();
  });

  test('Generate button label stays "Generate" when queue is empty', () => {
    render(<Composer {...baseProps} />, { wrapper: wrapper() });
    expect(screen.getByRole('button', { name: /^generate$/i })).toBeTruthy();
  });
});
