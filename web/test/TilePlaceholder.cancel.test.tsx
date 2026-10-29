import type { Batch, HistoryPage, Tile } from '@atelier/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { historyKeys } from '../src/api/history';

interface FetchCall {
  readonly url: string;
  readonly method: string;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

const noop = () => undefined;

function okDeleteMock(): typeof fetch {
  return mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push({ url, method });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
}

function setReducedMotion(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('reduce') ? matches : false,
      media: query,
      onchange: null,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
      removeListener: noop,
      dispatchEvent: () => false,
    }),
  });
}

import TilePlaceholder from '../src/components/tile/TilePlaceholder';

function createClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function seedTile(client: QueryClient, status: 'loading' | 'done' = 'loading'): void {
  const tile: Tile = status === 'loading'
    ? { id: 't1', seed: 1, status }
    : { id: 't1', seed: 1, status, url: '/api/img/t1', ext: 'png', mime: 'image/png', completedAt: 1 };
  client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), {
    pages: [{
      items: [{
        id: 'b1',
        prompt: 'prompt',
        ratio: '1:1',
        modelId: 'gpt-image-2.5-sunburst',
        modelLabel: 'GPT Image 2.5 Sunburst',
        createdAt: 1,
        collectionId: null,
          pinned: false,
          status: 'done',
        tiles: [tile],
      }],
      nextCursor: null,
    }],
    pageParams: [null],
  });
}

function wrapperFor(client: QueryClient) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = createClient();
  seedTile(client);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = okDeleteMock();
  setReducedMotion(false);
});

afterEach(() => {
  cleanup();
  mock.restore();
  globalThis.fetch = originalFetch;
});

describe('TilePlaceholder Cancel button', () => {
  test('renders Cancel button with aria-label, data-tip, and close icon', () => {
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.5-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    const btn = screen.getByLabelText('Cancel generation');
    expect(btn).toBeDefined();
    expect(btn.getAttribute('data-tip')).toBe('Cancel generation');
    expect(btn.tagName).toBe('BUTTON');
  });

  test('click fires cancelTile after the --dur-sheet animation delay (non-reduced-motion)', async () => {
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.5-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    const btn = screen.getByLabelText('Cancel generation');
    act(() => { fireEvent.click(btn); });
    const tile = btn.closest('[data-canceling="true"]');
    expect(tile).not.toBeNull();
    expect(calls).toEqual([]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 280)); });
    expect(calls).toEqual([{ url: '/api/history/b1/t1', method: 'DELETE' }]);
  });

  test('unmount during the animation window still sends the cancel', async () => {
    // A virtualized scroll-out or a view switch unmounts the tile mid-animation;
    // dropping the pending send silently let the generation finish.
    const { unmount } = render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.5-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    fireEvent.click(screen.getByLabelText('Cancel generation'));

    unmount();

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(calls).toEqual([{ url: '/api/history/b1/t1', method: 'DELETE' }]);
  });

  test('tile completing during the animation window suppresses cancelTile', async () => {
    const client = createClient();
    seedTile(client, 'loading');
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.5-sunburst" startedAt={Date.now()} />,
      { wrapper: wrapperFor(client) },
    );

    fireEvent.click(screen.getByLabelText('Cancel generation'));
    seedTile(client, 'done');

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 280)); });
    expect(calls).toEqual([]);
  });

  test('click fires cancelTile after the short reduced-motion fade when prefers-reduced-motion is reduce', async () => {
    setReducedMotion(true);
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.5-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    act(() => { fireEvent.click(screen.getByLabelText('Cancel generation')); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect(calls).toEqual([{ url: '/api/history/b1/t1', method: 'DELETE' }]);
  });

  test('Esc key on the tile cancels', async () => {
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.5-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    const btn = screen.getByLabelText('Cancel generation');
    act(() => { fireEvent.keyDown(btn, { key: 'Escape' }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 280)); });
    expect(calls).toEqual([{ url: '/api/history/b1/t1', method: 'DELETE' }]);
  });

  test('double-click does not fire cancelTile twice', async () => {
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.5-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    const btn = screen.getByLabelText('Cancel generation');
    act(() => { fireEvent.click(btn); });
    act(() => { fireEvent.click(btn); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 280)); });
    expect(calls).toEqual([{ url: '/api/history/b1/t1', method: 'DELETE' }]);
  });

  test('button is keyboard-focusable', () => {
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.5-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    const btn = screen.getByLabelText('Cancel generation');
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });
});
