import type { Batch, HistoryPage } from '@atelier/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { historyKeys } from '../src/api/history';
import { resetBroadcastForTests } from '../src/hooks/broadcastHistory';
import { registerBatch, resetInFlightForTests } from '../src/hooks/inFlightBatches';
import { useDeleteBatch } from '../src/hooks/useDeleteBatch';
import { useDeleteTile } from '../src/hooks/useDeleteTile';
import { APP_VIEW_UNSORTED, collectionView, useAtelierStore } from '../src/store/atelier';

const originalBroadcastChannel = window.BroadcastChannel;

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

function makeBatch(tiles: Batch['tiles']): Batch {
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

function clientWithBatch(batch: Batch): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const data: InfiniteData<HistoryPage<Batch>> = { pages: [{ items: [batch], nextCursor: null }], pageParams: [null] };
  client.setQueryData(historyKeys.list(), data);
  return client;
}

function historyData(batches: readonly Batch[]): InfiniteData<HistoryPage<Batch>> {
  return { pages: [{ items: [...batches], nextCursor: null }], pageParams: [null] };
}

function firstBatch(client: QueryClient, key: ReturnType<typeof historyKeys.list>): Batch | undefined {
  return client.getQueryData<InfiniteData<HistoryPage<Batch>>>(key)?.pages[0]?.items[0];
}

function okDeleteMock(calls: { url: string; method: string }[]): typeof fetch {
  return mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push({ url, method });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
}

async function mutateAndFlush(mutation: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await mutation();
    // Mutation onSettled invalidations notify observers on the next task.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  cleanup();
  mock.restore();
  resetBroadcastForTests();
  resetInFlightForTests();
  setBroadcastChannel(originalBroadcastChannel);
  useAtelierStore.setState({ activeBatchId: null, lightbox: null, toasts: [], previews: new Map(), view: APP_VIEW_UNSORTED, q: '' });
});

describe('delete hooks loading-row cancel delegation', () => {
  test('useDeleteTile removes a done tile optimistically and rolls back on failure', async () => {
    let rejectDelete!: (error: Error) => void;
    globalThis.fetch = mock(() =>
      new Promise<Response>((_resolve, reject) => { rejectDelete = reject; })
    ) as unknown as typeof fetch;
    const tile: Batch['tiles'][number] = {
      id: 'tile-done',
      seed: 2,
      status: 'done',
      url: '/api/img/tile-done',
      ext: 'png',
      mime: 'image/png',
      completedAt: 2,
    };
    const client = clientWithBatch(makeBatch([tile]));
    const { result } = renderHook(() => useDeleteTile(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ batchId: 'batch-1', tileId: 'tile-done', intent: 'archive' });
    });

    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(data?.pages[0]?.items).toEqual([]);
    });

    await act(async () => {
      rejectDelete(new Error('server refused delete'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(data?.pages[0]?.items[0]?.tiles).toEqual([tile]);
      expect(useAtelierStore.getState().toasts[0]?.tone).toBe('error');
    });
  });

  test('useDeleteBatch removes a done batch optimistically and rolls back on failure', async () => {
    let rejectDelete!: (error: Error) => void;
    globalThis.fetch = mock(() =>
      new Promise<Response>((_resolve, reject) => { rejectDelete = reject; })
    ) as unknown as typeof fetch;
    const batch = makeBatch([
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ]);
    const client = clientWithBatch(batch);
    const { result } = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ batchId: 'batch-1', intent: 'archive' });
    });

    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(data?.pages[0]?.items).toEqual([]);
    });

    await act(async () => {
      rejectDelete(new Error('server refused delete'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(data?.pages[0]?.items).toEqual([batch]);
      expect(useAtelierStore.getState().toasts[0]?.tone).toBe('error');
    });
  });

  test('useDeleteTile mirrors optimistic removal into Unsorted when active scope is a collection', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const tileDone: Batch['tiles'][number] = {
      id: 'tile-done',
      seed: 2,
      status: 'done',
      url: '/api/img/tile-done',
      ext: 'png',
      mime: 'image/png',
      completedAt: 2,
    };
    const sourceBatch = makeBatch([
      { id: 'tile-keep', seed: 1, status: 'failed', error: 'interrupted', completedAt: 1 },
      tileDone,
    ]);
    const client = clientWithBatch(sourceBatch);
    const activeView = collectionView('collection-1');
    const activeKey = historyKeys.scoped(activeView, '');
    client.setQueryData(activeKey, historyData([sourceBatch]));
    const { result } = renderHook(() => useDeleteTile({ activeView, q: '' }), { wrapper: wrapper(client) });

    await mutateAndFlush(() => result.current.mutateAsync({ batchId: 'batch-1', tileId: 'tile-done', intent: 'archive' }));

    expect(firstBatch(client, activeKey)?.tiles.map((tile) => tile.id)).toEqual(['tile-keep']);
    expect(firstBatch(client, historyKeys.list())?.tiles.map((tile) => tile.id)).toEqual(['tile-keep']);
  });

  test('useDeleteBatch mirrors optimistic removal into Unsorted when active scope is a collection', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const sourceBatch = makeBatch([
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ]);
    const client = clientWithBatch(sourceBatch);
    const activeView = collectionView('collection-1');
    const activeKey = historyKeys.scoped(activeView, '');
    client.setQueryData(activeKey, historyData([sourceBatch]));
    const { result } = renderHook(() => useDeleteBatch({ activeView, q: '' }), { wrapper: wrapper(client) });

    await mutateAndFlush(() => result.current.mutateAsync({ batchId: 'batch-1', intent: 'archive' }));

    expect(client.getQueryData<InfiniteData<HistoryPage<Batch>>>(activeKey)?.pages[0]?.items).toEqual([]);
    expect(client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items).toEqual([]);
  });

  test('useDeleteTile does not create an empty Unsorted cache when only the active scope is loaded', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const sourceBatch = makeBatch([
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const activeView = collectionView('collection-1');
    const activeKey = historyKeys.scoped(activeView, '');
    client.setQueryData(activeKey, historyData([sourceBatch]));
    const { result } = renderHook(() => useDeleteTile({ activeView, q: '' }), { wrapper: wrapper(client) });

    await mutateAndFlush(() => result.current.mutateAsync({ batchId: 'batch-1', tileId: 'tile-done', intent: 'archive' }));

    const unsortedCacheAfterTile = client.getQueryData(historyKeys.list());
    expect(unsortedCacheAfterTile).toBeUndefined();
  });

  test('useDeleteBatch does not create an empty Unsorted cache when only the active scope is loaded', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const sourceBatch = makeBatch([
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const activeView = collectionView('collection-1');
    const activeKey = historyKeys.scoped(activeView, '');
    client.setQueryData(activeKey, historyData([sourceBatch]));
    const { result } = renderHook(() => useDeleteBatch({ activeView, q: '' }), { wrapper: wrapper(client) });

    await mutateAndFlush(() => result.current.mutateAsync({ batchId: 'batch-1', intent: 'archive' }));

    const unsortedCacheAfterBatch = client.getQueryData(historyKeys.list());
    expect(unsortedCacheAfterBatch).toBeUndefined();
  });

  test('useDeleteTile on a loading tile toasts Canceled and aborts the local controller after DELETE', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const controller = new AbortController();
    registerBatch('batch-1', controller);
    const client = clientWithBatch(makeBatch([{ id: 'tile-loading', seed: 1, status: 'loading' }]));
    const { result } = renderHook(() => useDeleteTile(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ batchId: 'batch-1', tileId: 'tile-loading' });
    });
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts[0]?.text).toBe('Image canceled');
    });

    expect(calls).toEqual([{ url: '/api/history/batch-1/tile-loading', method: 'DELETE' }]);
    expect(controller.signal.aborted).toBe(true);
  });

  test('useDeleteTile on a done tile with archive intent keeps Archived toast', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const client = clientWithBatch(makeBatch([
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ]));
    const { result } = renderHook(() => useDeleteTile(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ batchId: 'batch-1', tileId: 'tile-done', intent: 'archive' });
    });
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts[0]?.text).toBe('Archived');
    });

    expect(calls).toEqual([{ url: '/api/history/batch-1/tile-done', method: 'DELETE' }]);
  });

  test('useDeleteTile on a failed tile with dismiss intent keeps Dismissed toast', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const client = clientWithBatch(makeBatch([
      { id: 'tile-failed', seed: 3, status: 'failed', error: 'interrupted', completedAt: 3 },
    ]));
    const { result } = renderHook(() => useDeleteTile(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ batchId: 'batch-1', tileId: 'tile-failed', intent: 'dismiss' });
    });
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts[0]?.text).toBe('Dismissed');
    });

    expect(calls).toEqual([{ url: '/api/history/batch-1/tile-failed', method: 'DELETE' }]);
  });

  test('useDeleteBatch on an all-loading batch toasts Batch canceled', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const client = clientWithBatch(makeBatch([{ id: 'tile-loading', seed: 1, status: 'loading' }]));
    const { result } = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ batchId: 'batch-1' });
    });
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts[0]?.text).toBe('Batch canceled');
    });

    expect(calls).toEqual([{ url: '/api/history/batch-1', method: 'DELETE' }]);
  });

  test('useDeleteBatch on a mixed loading and done batch keeps Archived toast', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const client = clientWithBatch(makeBatch([
      { id: 'tile-loading', seed: 1, status: 'loading' },
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ]));
    const { result } = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ batchId: 'batch-1' });
    });
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts[0]?.text).toBe('Archived');
    });

    expect(calls).toEqual([{ url: '/api/history/batch-1', method: 'DELETE' }]);
  });

  test('useDeleteBatch on a done-only batch keeps Archived toast', async () => {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = okDeleteMock(calls);
    const client = clientWithBatch(makeBatch([
      { id: 'tile-done', seed: 2, status: 'done', url: '/api/img/tile-done', ext: 'png', mime: 'image/png', completedAt: 2 },
    ]));
    const { result } = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate({ batchId: 'batch-1' });
    });
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts[0]?.text).toBe('Archived');
    });

    expect(calls).toEqual([{ url: '/api/history/batch-1', method: 'DELETE' }]);
  });
});
