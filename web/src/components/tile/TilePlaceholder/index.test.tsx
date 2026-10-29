import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import TilePlaceholder from './index';

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
