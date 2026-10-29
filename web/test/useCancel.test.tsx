import type { Batch, HistoryPage } from '@atelier/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { archiveKeys } from '../src/api/archive';
import { collectionKeys } from '../src/api/collections';
import { historyKeys } from '../src/api/history';
import { resetBroadcastForTests } from '../src/hooks/broadcastHistory';
import { registerBatch, resetInFlightForTests } from '../src/hooks/inFlightBatches';
import { useCancel } from '../src/hooks/useCancel';
import { APP_VIEW_UNSORTED, collectionView, useAtelierStore } from '../src/store/atelier';

const originalBroadcastChannel = window.BroadcastChannel;

class MockChannel {
  static messages: unknown[] = [];

  postMessage(message: unknown): void {
    MockChannel.messages.push(message);
  }

  addEventListener(_type: 'message', _listener: (event: MessageEvent) => void): void {
    return undefined;
  }

  removeEventListener(_type: 'message', _listener: (event: MessageEvent) => void): void {
    return undefined;
  }

  close(): void {
    return undefined;
  }
}

function setBroadcastChannel(value: typeof BroadcastChannel | undefined): void {
  Object.defineProperty(window, 'BroadcastChannel', {
    configurable: true,
    writable: true,
    value,
  });
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function batch(tiles: Batch['tiles']): Batch {
  return {
    id: 'batch-1',
    prompt: 'a brass lamp',
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst',
    modelLabel: 'GPT Image 2.5 Sunburst',
    createdAt: 1,
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles,
  };
}

function historyData(batches: readonly Batch[]): InfiniteData<HistoryPage<Batch>> {
  return { pages: [{ items: [...batches], nextCursor: null }], pageParams: [null] };
}

function clientWithHistory(batches: readonly Batch[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(historyKeys.list(), historyData(batches));
  client.setQueryData(archiveKeys.list(), { items: [], nextCursor: null });
  client.setQueryData(collectionKeys.list(), { items: [], summary: { totalCount: 1, pinnedCount: 0, unsortedCount: 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
  return client;
}

function tileIdsInCache(client: QueryClient, key: ReturnType<typeof historyKeys.list>): readonly string[] | undefined {
  return client.getQueryData<InfiniteData<HistoryPage<Batch>>>(key)?.pages[0]?.items[0]?.tiles.map((tile) => tile.id);
}

function okDeleteMock(calls: { url: string; method: string }[]): typeof fetch {
  return mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push({ url, method });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
}

function deferredDeleteMock(calls: { url: string; method: string }[]): {
  readonly fetch: typeof fetch;
  readonly resolveDelete: () => void;
} {
  let resolveDelete: (() => void) | undefined;
  return {
    fetch: mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      calls.push({ url, method });
      return new Promise<Response>((resolve) => {
        resolveDelete = () => { resolve(new Response(null, { status: 204 })); };
      });
    }) as unknown as typeof fetch,
    resolveDelete: () => {
      if (!resolveDelete) throw new Error('DELETE was not started');
      resolveDelete();
    },
  };
}

afterEach(() => {
  cleanup();
  mock.restore();
  resetBroadcastForTests();
  resetInFlightForTests();
  MockChannel.messages = [];
  setBroadcastChannel(originalBroadcastChannel);
  useAtelierStore.setState({ activeBatchId: null, lightbox: null, toasts: [], previews: new Map(), view: APP_VIEW_UNSORTED, q: '' });
});

describe('useCancel', () => {
  test('cancelTile deletes the tile and optimistically removes it from history cache', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const client = clientWithHistory([batch([
      { id: 'tile-loading', seed: 1, status: 'loading' },
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ])]);
    const { result } = renderHook(() => useCancel(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.cancelTile('batch-1', 'tile-loading');
    });

    expect(calls).toEqual([{ url: '/api/history/batch-1/tile-loading', method: 'DELETE' }]);
    const items = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items;
    expect(items?.[0]?.tiles.map((tile) => tile.id)).toEqual(['tile-done']);
  });

  test('cancelTile aborts the local controller only after DELETE returns', async () => {
    const calls: { url: string; method: string }[] = [];
    const deferred = deferredDeleteMock(calls);
    globalThis.fetch = deferred.fetch;
    const controller = new AbortController();
    registerBatch('batch-1', controller);
    const client = clientWithHistory([batch([{ id: 'tile-loading', seed: 1, status: 'loading' }])]);
    const { result } = renderHook(() => useCancel(), { wrapper: wrapper(client) });

    const cancelPromise = result.current.cancelTile('batch-1', 'tile-loading');
    await waitFor(() => { expect(calls).toEqual([{ url: '/api/history/batch-1/tile-loading', method: 'DELETE' }]); });

    expect(controller.signal.aborted).toBe(false);
    deferred.resolveDelete();
    await act(async () => {
      await cancelPromise;
    });
    expect(controller.signal.aborted).toBe(true);
  });

  test('cancelBatch deletes the batch and optimistically removes it from history cache', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const client = clientWithHistory([batch([{ id: 'tile-loading', seed: 1, status: 'loading' }])]);
    const { result } = renderHook(() => useCancel(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.cancelBatch('batch-1');
    });

    expect(calls).toEqual([{ url: '/api/history/batch-1', method: 'DELETE' }]);
    expect(client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items).toEqual([]);
  });

  test('cancelBatch aborts the local controller only after DELETE returns', async () => {
    const calls: { url: string; method: string }[] = [];
    const deferred = deferredDeleteMock(calls);
    globalThis.fetch = deferred.fetch;
    const controller = new AbortController();
    registerBatch('batch-1', controller);
    const client = clientWithHistory([batch([{ id: 'tile-loading', seed: 1, status: 'loading' }])]);
    const { result } = renderHook(() => useCancel(), { wrapper: wrapper(client) });

    const cancelPromise = result.current.cancelBatch('batch-1');
    await waitFor(() => { expect(calls).toEqual([{ url: '/api/history/batch-1', method: 'DELETE' }]); });

    expect(controller.signal.aborted).toBe(false);
    deferred.resolveDelete();
    await act(async () => {
      await cancelPromise;
    });
    expect(controller.signal.aborted).toBe(true);
  });

  test('cancelTile does NOT roll back on DELETE failure, but tells the user', async () => {
    // Audit 01-concurrency #12: the server-side cancel fires BEFORE its DB
    // transaction, so on a flaky DELETE the rows are very likely already
    // gone server-side. Restoring the pre-cancel snapshot would reintroduce
    // a stale `loading` tile that fights server truth. The optimistic
    // removal must PERSIST; onSettled's invalidate reconciles on the next
    // successful refetch. No rollback — but a toast, so the failure is not
    // silent while the refetch may bring a still-running tile back.
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ error: 'upstream still running' }), { status: 500 }))) as unknown as typeof fetch;
    const client = clientWithHistory([batch([
      { id: 'tile-loading', seed: 1, status: 'loading' },
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ])]);
    const { result } = renderHook(() => useCancel(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.cancelTile('batch-1', 'tile-loading').catch(() => undefined);
    });

    const items = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items;
    expect(items?.[0]?.tiles.map((tile) => tile.id)).toEqual(['tile-done']);
    expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toEqual([
      "Couldn't cancel — the generation may still finish.",
    ]);
  });

  test('cancelTile posts a cross-tab history invalidation', async () => {
    setBroadcastChannel(MockChannel as never);
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const client = clientWithHistory([batch([{ id: 'tile-loading', seed: 1, status: 'loading' }])]);
    const { result } = renderHook(() => useCancel(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.cancelTile('batch-1', 'tile-loading');
    });

    expect(MockChannel.messages[0]).toEqual({ type: 'invalidate', batchId: 'batch-1' });
    expect(MockChannel.messages[1]).toMatchObject({ type: 'cancel', batchId: 'batch-1' });
    expect(typeof (MockChannel.messages[1] as { originTabId?: unknown }).originTabId).toBe('string');
  });

  test('cancelTile mirrors optimistic removal into Unsorted when active scope is a collection', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const activeView = collectionView('collection-1');
    const activeKey = historyKeys.scoped(activeView, '');
    const sourceBatch = batch([
      { id: 'tile-loading', seed: 1, status: 'loading' },
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ]);
    const client = clientWithHistory([sourceBatch]);
    client.setQueryData(activeKey, historyData([sourceBatch]));
    const { result } = renderHook(() => useCancel({ activeView, q: '' }), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.cancelTile('batch-1', 'tile-loading');
    });

    expect(tileIdsInCache(client, activeKey)).toEqual(['tile-done']);
    expect(tileIdsInCache(client, historyKeys.list())).toEqual(['tile-done']);
  });

  test('cancelTile does not create an empty Unsorted cache when only the active scope is loaded', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const activeView = collectionView('collection-1');
    const activeKey = historyKeys.scoped(activeView, '');
    const sourceBatch = batch([{ id: 'tile-loading', seed: 1, status: 'loading' }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(activeKey, historyData([sourceBatch]));
    const { result } = renderHook(() => useCancel({ activeView, q: '' }), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.cancelTile('batch-1', 'tile-loading');
    });

    const unsortedCache = client.getQueryData(historyKeys.list());
    expect(unsortedCache).toBeUndefined();
  });

  test('cancelTile invalidates history queries after settling', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const client = clientWithHistory([batch([{ id: 'tile-loading', seed: 1, status: 'loading' }])]);
    const { result } = renderHook(() => useCancel(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.cancelTile('batch-1', 'tile-loading');
    });

    await waitFor(() => {
      expect(client.getQueryState(historyKeys.list())?.isInvalidated).toBe(true);
    });
  });
});
