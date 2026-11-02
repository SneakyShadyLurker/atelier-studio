import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import TilePlaceholder from './index';
import { initialAtelierState, useAtelierStore, type TileProgress } from '../../../store/atelier';

const originalMatchMedia = window.matchMedia.bind(window);
const originalSetInterval = window.setInterval.bind(window);
const originalClearInterval = window.clearInterval.bind(window);

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  cleanup();
  useAtelierStore.setState(initialAtelierState, true);
  window.matchMedia = originalMatchMedia;
  window.setInterval = originalSetInterval;
  window.clearInterval = originalClearInterval;
});

describe('TilePlaceholder elapsed timer', () => {
  test('two loading tiles share one now tick interval', () => {
    window.matchMedia = mock(() => ({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }));
    const delays: number[] = [];
    window.setInterval = mock((handler: TimerHandler, delay?: number) => {
      delays.push(delay ?? 0);
      return originalSetInterval(handler, delay);
    }) as unknown as typeof window.setInterval;
    window.clearInterval = mock((id: number | undefined) => {
      if (id !== undefined) originalClearInterval(id);
    }) as unknown as typeof window.clearInterval;

    render(
      <>
        <TilePlaceholder tileId="tile-a" batchId="batch" batchStatus="running" aspectRatio="1 / 1" modelName="GPT" startedAt={Date.now()} />
        <TilePlaceholder tileId="tile-b" batchId="batch" batchStatus="running" aspectRatio="1 / 1" modelName="GPT" startedAt={Date.now()} />
      </>,
      { wrapper: wrapper() },
    );

    expect(delays).toEqual([1000]);
  });
});

describe('TilePlaceholder queued state', () => {
  test('a queued tile runs no elapsed clock behind its queued layer', () => {
    const delays: number[] = [];
    window.setInterval = mock((handler: TimerHandler, delay?: number) => {
      delays.push(delay ?? 0);
      return originalSetInterval(handler, delay);
    }) as unknown as typeof window.setInterval;

    render(
      <TilePlaceholder tileId="tile-q" batchId="batch" batchStatus="queued" aspectRatio="1 / 1" modelName="GPT" startedAt={Date.now()} />,
      { wrapper: wrapper() },
    );

    expect(delays).toEqual([]);
  });
});

describe('TilePlaceholder video source backdrop', () => {
  test('veils the source still behind a loading video tile', () => {
    const { container } = render(
      <TilePlaceholder tileId="t-vid" batchId="b" batchStatus="running" aspectRatio="16 / 9" modelName="MiniMax H3 I2V" startedAt={Date.now()} isVideo sourceStillUrl="/api/img/up-1" />,
      { wrapper: wrapper() },
    );
    const backdrop = container.querySelector('img[data-source="true"]');
    expect(backdrop).toBeTruthy();
    expect(backdrop?.getAttribute('src')).toBe('/api/img/up-1');
  });

  test('image loading tiles render no source backdrop', () => {
    const { container } = render(
      <TilePlaceholder tileId="t-img" batchId="b" batchStatus="running" aspectRatio="1 / 1" modelName="GPT" startedAt={Date.now()} />,
      { wrapper: wrapper() },
    );
    expect(container.querySelector('img[data-source="true"]')).toBeNull();
  });
});

describe('TilePlaceholder step progress', () => {
  function renderWith(entry: Partial<TileProgress> | null, isVideo = false) {
    if (entry !== null) {
      useAtelierStore.setState({ tileProgress: { 't-step': {
        progress: 0.48, msPerUnit: 20_000, lastDelta: 0.04, observations: 1, lastAt: Date.now(), ...entry,
      } } });
    }
    const startedAt = Date.now() - 20_000;
    const view = render(
      <TilePlaceholder tileId="t-step" batchId="b" batchStatus="running" aspectRatio="1 / 1" modelName="Krea" startedAt={startedAt} isVideo={isVideo} />,
      { wrapper: wrapper() },
    );
    const text = view.container.querySelector('ul')?.textContent ?? '';
    const bar = view.container.querySelector('[role="progressbar"]');
    return { text, bar, container: view.container };
  }

  const STEPS = { step: 12, totalSteps: 25, pass: 1, passCount: 1 };

  test('sampling shows model, step readout and elapsed before the rate is reliable', () => {
    const { text, bar } = renderWith({ ...STEPS, observations: 2 });
    expect(text).toBe('Krea12/2520s');
    expect(bar?.getAttribute('aria-valuenow')).toBe('48');
    expect(bar?.getAttribute('aria-valuetext')).toBe('Step 12 of 25');
  });

  test('the ETA replaces elapsed after three observations', () => {
    // (1 − 0.48) × 20 000 ms = 10.4 s
    const { text, bar } = renderWith({ ...STEPS, observations: 3 });
    expect(text).toBe('Krea12/25~10s');
    expect(bar?.getAttribute('aria-valuetext')).toBe('Step 12 of 25, about 10 seconds left');
  });

  test('a later pass reads as Refine', () => {
    const { text, bar } = renderWith({ progress: 0.85, step: 3, totalSteps: 8, pass: 2, passCount: 2, observations: 2 });
    expect(text).toBe('KreaRefine 3/820s');
    expect(bar?.getAttribute('aria-valuetext')).toBe('Refine step 3 of 8');
  });

  test('the final step of the last pass reads Finishing over a full bar', () => {
    const { text, bar } = renderWith({ progress: 1, step: 8, totalSteps: 8, pass: 2, passCount: 2, observations: 5 });
    expect(text).toBe('KreaFinishing');
    expect(bar?.getAttribute('data-finishing')).toBe('true');
    expect(bar?.getAttribute('aria-valuenow')).toBe('100');
    expect(bar?.getAttribute('aria-valuetext')).toBe('Finishing');
  });

  test('video rows show the step readout with the video clock until the ETA is reliable', () => {
    const { text } = renderWith({ ...STEPS, observations: 1 }, true);
    expect(text).toBe('Krea12/250:20 / 12:00');
  });

  test('without step data the tile renders as before', () => {
    const indeterminate = renderWith(null);
    expect(indeterminate.text).toBe('Krea20s');
    expect(indeterminate.bar).toBeNull();
    cleanup();
    const fraction = renderWith({ progress: 0.4 });
    expect(fraction.text).toBe('Krea20s');
    expect(fraction.bar?.getAttribute('aria-valuetext')).toBe('40%');
    expect(fraction.bar?.hasAttribute('data-steps')).toBe(false);
  });
});
