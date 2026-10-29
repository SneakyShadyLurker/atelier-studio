import type { Batch, CollectionsResponse, HistoryPage } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { historyKeys } from '../src/api/history';
import { collectionKeys } from '../src/api/collections';
import { useHistory } from '../src/hooks/useHistory';
import { useMoveBatch } from '../src/hooks/useMoveBatch';
import { useTogglePin } from '../src/hooks/useTogglePin';
import {
  APP_VIEW_PINNED,
  APP_VIEW_UNSORTED,
  collectionView,
  useAtelierStore,
} from '../src/store/atelier';

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: '019e13e4-f168-7555-8dbe-6be97df82b17',
    prompt: 'red chair',
    ratio: '1:1',
    modelId: 'm',
    modelLabel: 'M',
    createdAt: 1,
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles: [],
    ...overrides,
  };
}

function page(items: readonly Batch[]): InfiniteData<HistoryPage<Batch>> {
  return { pages: [{ items, nextCursor: null }], pageParams: [null] };
}

const collections: CollectionsResponse = {
  items: [{ id: '019e13e4-f168-7555-8dbe-6be97df82b17', name: 'Logos', count: 1, archivedCount: 0, createdAt: 1 }],
  summary: { totalCount: 1, pinnedCount: 1, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
};

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ view: APP_VIEW_UNSORTED, q: '', activeBatchId: null, toasts: [] });
});

describe('useHistory scoped query keys', () => {
  test('fetches unsorted, pinned, and collection scopes with canonical params', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seenUrls.push(url);
      if (url.endsWith('/collections')) return Response.json(collections);
      return Response.json({ items: [], nextCursor: null });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderHook(({ view, q }) => useHistory(view, q), {
      initialProps: { view: APP_VIEW_UNSORTED, q: '' },
      wrapper: wrapper(client),
    });
    await waitFor(() => { expect(seenUrls).toContain('/api/history?limit=30&collectionId=null'); });

    rerender({ view: APP_VIEW_PINNED, q: 'red chair' });
    await waitFor(() => { expect(seenUrls).toContain('/api/history?limit=30&pinned=true&q=red+chair'); });

    rerender({ view: APP_VIEW_UNSORTED, q: 'loose' });
    await waitFor(() => { expect(seenUrls).toContain('/api/history?limit=30&collectionId=null&q=loose'); });

    rerender({ view: collectionView('019e13e4-f168-7555-8dbe-6be97df82b17'), q: 'logo' });
    await waitFor(() => {
      expect(seenUrls).toContain('/api/history?limit=30&collectionId=019e13e4-f168-7555-8dbe-6be97df82b17&q=logo');
    });

    expect(historyKeys.scoped(APP_VIEW_PINNED, 'red chair')).toEqual(['history', { view: APP_VIEW_PINNED, q: 'red chair' }]);
  });
});

describe('collection mutations', () => {
  test('useMoveBatch optimistically removes from the active collection scope and rolls back on error', async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const collectionId = '019e13e4-f168-7555-8dbe-6be97df82b17';
    const activeView = collectionView(collectionId);
    const activeKey = historyKeys.scoped(activeView, '');
    client.setQueryData(activeKey, page([batch({ collectionId })]));

    const { result } = renderHook(() => useMoveBatch({ activeView, q: '' }), { wrapper: wrapper(client) });
    const mutationPromise = result.current.mutateAsync({
        batchId: '019e13e4-f168-7555-8dbe-6be97df82b17',
        collectionId: '019e13e4-f168-7555-8dbe-6be97df82b18',
      }).catch(() => undefined);

    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(activeKey);
      expect(data?.pages[0]?.items).toEqual([]);
    });
    await act(async () => {
      resolveFetch(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
      await mutationPromise;
    });
    const restored = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(activeKey);
    expect(restored?.pages[0]?.items[0]?.collectionId).toBe(collectionId);
  });

  test('useTogglePin removes from pinned scope and invalidates history plus collections on success', async () => {
    globalThis.fetch = mock(() => Response.json(batch({ pinned: false }))) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const activeKey = historyKeys.scoped(APP_VIEW_PINNED, '');
    client.setQueryData(activeKey, page([batch({ pinned: true })]));
    client.setQueryData(collectionKeys.list(), collections);

    const { result } = renderHook(() => useTogglePin({ activeView: APP_VIEW_PINNED, q: '' }), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({
        batchId: '019e13e4-f168-7555-8dbe-6be97df82b17',
        pinned: false,
      });
    });

    const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(activeKey);
    expect(data?.pages[0]?.items).toEqual([]);
    expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(collectionKeys.list())?.isInvalidated).toBe(true);
  });

  test('useReorderCollections optimistically rearranges cache and rolls back on error', async () => {
    const { useReorderCollections } = await import('../src/hooks/useReorderCollections');

    const idA = '019e13e4-f168-7555-8dbe-6be97df82b17';
    const idB = '019e13e4-f168-7555-8dbe-6be97df82b18';
    const idC = '019e13e4-f168-7555-8dbe-6be97df82b19';
    const seed: CollectionsResponse = {
      items: [
        { id: idA, name: 'Alpha', count: 0, archivedCount: 0, createdAt: 1 },
        { id: idB, name: 'Bravo', count: 0, archivedCount: 0, createdAt: 2 },
        { id: idC, name: 'Charlie', count: 0, archivedCount: 0, createdAt: 3 },
      ],
      summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
    };

    let resolveFetch: (response: Response) => void = () => undefined;
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(collectionKeys.list(), seed);

    const { result } = renderHook(() => useReorderCollections(), { wrapper: wrapper(client) });
    const mutationPromise = result.current.mutateAsync({ orderedIds: [idC, idA, idB] }).catch(() => undefined);

    await waitFor(() => {
      const data = client.getQueryData<CollectionsResponse>(collectionKeys.list());
      expect(data?.items.map((item) => item.id)).toEqual([idC, idA, idB]);
    });

    await act(async () => {
      resolveFetch(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
      await mutationPromise;
    });

    const rolledBack = client.getQueryData<CollectionsResponse>(collectionKeys.list());
    expect(rolledBack?.items.map((item) => item.id)).toEqual([idA, idB, idC]);
    expect(client.getQueryState(collectionKeys.list())?.isInvalidated).toBe(true);
  });

  test('useReorderCollections preserves the prior server response when a later burst mutation fails', async () => {
    const { useReorderCollections } = await import('../src/hooks/useReorderCollections');

    const idA = '019e13e4-f168-7555-8dbe-6be97df82b17';
    const idB = '019e13e4-f168-7555-8dbe-6be97df82b18';
    const idC = '019e13e4-f168-7555-8dbe-6be97df82b19';
    const itemA = { id: idA, name: 'Alpha', count: 0, archivedCount: 0, createdAt: 1 };
    const itemB = { id: idB, name: 'Bravo', count: 0, archivedCount: 0, createdAt: 2 };
    const itemC = { id: idC, name: 'Charlie', count: 0, archivedCount: 0, createdAt: 3 };
    const seed: CollectionsResponse = {
      items: [itemA, itemB, itemC],
      summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
    };
    const serverAfterA: CollectionsResponse = {
      items: [itemB, itemA, itemC],
      summary: { ...seed.summary, totalCount: 7 },
    };

    // First call resolves with server-A truth; second call rejects (500).
    let call = 0;
    let resolveA: ((response: Response) => void) | null = null;
    let rejectB: ((response: Response) => void) | null = null;
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
      call += 1;
      if (call === 1) resolveA = resolve;
      else rejectB = resolve;
    })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(collectionKeys.list(), seed);

    const { result } = renderHook(() => useReorderCollections(), { wrapper: wrapper(client) });

    // Fire two reorders back-to-back. Scope serialization queues B behind A.
    const promiseA = result.current.mutateAsync({ orderedIds: [idB, idA, idC] }).catch(() => undefined);
    const promiseB = result.current.mutateAsync({ orderedIds: [idC, idB, idA] }).catch(() => undefined);

    await waitFor(() => { expect(resolveA).not.toBeNull(); });

    // A succeeds with server-truth payload (carries the totalCount: 7 the
    // optimistic cache could not know about).
    await act(async () => {
      resolveA?.(new Response(JSON.stringify(serverAfterA), { status: 200 }));
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => { expect(rejectB).not.toBeNull(); });

    await act(async () => {
      rejectB?.(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
      await Promise.all([promiseA, promiseB]);
    });

    const final = client.getQueryData<CollectionsResponse>(collectionKeys.list());
    // The successful A response must NOT have been rolled back by B's failure.
    expect(final?.summary.totalCount).toBe(7);
    expect(final?.items.map((item) => item.id)).toEqual([idB, idA, idC]);
  });
});
