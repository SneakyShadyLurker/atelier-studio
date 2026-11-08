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
        modelId: 'gpt-image-2.6-sunburst',
        modelLabel: 'GPT Image 2.6 Sunburst',
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
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.6-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    const btn = screen.getByLabelText('Cancel generation');
    expect(btn).toBeDefined();
    expect(btn.getAttribute('data-tip')).toBe('Cancel generation');
    expect(btn.tagName).toBe('BUTTON');
  });

  // The exit is the Batch tile boundary's (motion.css .tile-exit), driven by
  // useCancel's optimistic removal, so the DELETE goes out at once: no
  // animation delay, nothing pending, in either motion mode.
  for (const reduced of [false, true]) {
    test(`click sends exactly one DELETE at once (reduced motion: ${String(reduced)})`, async () => {
      setReducedMotion(reduced);
      render(
        <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.6-sunburst" startedAt={Date.now()} />,
        { wrapper },
      );
      fireEvent.click(screen.getByLabelText('Cancel generation'));
      // Microtasks only (useCancel awaits cancelQueries before the request):
      // no timer has to run for the cancel to leave.
      await act(async () => {
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      });
      expect(calls).toEqual([{ url: '/api/history/b1/t1', method: 'DELETE' }]);
    });
  }

  test('unmount right after the click still sends the cancel once', async () => {
    // A virtualized scroll-out or a view switch can unmount the tile at once;
    // the cancel already left with the click.
    const { unmount } = render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.6-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    fireEvent.click(screen.getByLabelText('Cancel generation'));

    unmount();

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(calls).toEqual([{ url: '/api/history/b1/t1', method: 'DELETE' }]);
  });

  test('a tile already terminal in cache skips the DELETE', async () => {
    // The feed renders a deferred snapshot, so a tile can still show its
    // Cancel button after the cache recorded it done.
    const client = createClient();
    seedTile(client, 'done');
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.6-sunburst" startedAt={Date.now()} />,
      { wrapper: wrapperFor(client) },
    );

    fireEvent.click(screen.getByLabelText('Cancel generation'));

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls).toEqual([]);
  });

  test('Esc key on the tile cancels', async () => {
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.6-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    const btn = screen.getByLabelText('Cancel generation');
    act(() => { fireEvent.keyDown(btn, { key: 'Escape' }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls).toEqual([{ url: '/api/history/b1/t1', method: 'DELETE' }]);
  });

  test('double-click does not fire cancelTile twice', async () => {
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.6-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    const btn = screen.getByLabelText('Cancel generation');
    act(() => { fireEvent.click(btn); });
    act(() => { fireEvent.click(btn); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls).toEqual([{ url: '/api/history/b1/t1', method: 'DELETE' }]);
  });

  test('button is keyboard-focusable', () => {
    render(
      <TilePlaceholder tileId="t1" batchId="b1" batchStatus="running" aspectRatio="1 / 1" modelName="gpt-image-2.6-sunburst" startedAt={Date.now()} />,
      { wrapper },
    );
    const btn = screen.getByLabelText('Cancel generation');
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });
});
