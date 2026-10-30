import type { Batch, HistoryPage } from '@atelier/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { archiveKeys } from '../api/archive';
import { collectionKeys } from '../api/collections';
import { historyKeys, historyRefreshInterval } from '../api/history';
import { APP_VIEW_PINNED, APP_VIEW_UNSORTED, collectionView, useAtelierStore } from '../store/atelier';
import { updateBatchInActiveScope, useScopedBatchPatch, type HistoryData } from './scopedHistoryMutation';

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-1',
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

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ view: APP_VIEW_UNSORTED, q: '' });
});

describe('useScopedBatchPatch', () => {
  test('retags loading counts when a loading batch leaves the active scope', () => {
    const activeKey = historyKeys.list();
    const queryClient = new QueryClient();
    queryClient.setQueryData<HistoryData>(activeKey, {
      pages: [{
        items: [batch({ tiles: [{ id: 'tile-1', seed: 1, status: 'loading' }] })],
        nextCursor: null,
        loadingTileCount: 1,
        hasLoadingTiles: true,
      }],
      pageParams: [null],
      loadingTileCount: 1,
    });

    updateBatchInActiveScope(queryClient, activeKey, 'batch-1', { collectionId: 'collection-1' });

    const data = queryClient.getQueryData<HistoryData>(activeKey);
    expect(data?.loadingTileCount).toBe(0);
    expect(data?.pages[0]?.loadingTileCount).toBe(0);
    expect(data?.pages[0]?.hasLoadingTiles).toBe(false);

    expect(historyRefreshInterval({ state: { data, fetchFailureCount: 0 } })).toBe(false);
  });

  test('keeps the active scope hot from the returned batch and invalidates non-active scopes', async () => {
    const activeKey = historyKeys.list();
    const otherKey = historyKeys.scoped(APP_VIEW_PINNED, '');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(activeKey, page([batch()]));
    queryClient.setQueryData(otherKey, page([batch({ pinned: true })]));
    queryClient.setQueryData(archiveKeys.list(), { pages: [], pageParams: [] });
    queryClient.setQueryData(collectionKeys.list(), { items: [], summary: {} });

    globalThis.fetch = mock(() => Response.json(batch({ pinned: true }))) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useScopedBatchPatch(
        { activeView: APP_VIEW_UNSORTED, q: '' },
        {
          toPatch: (input: { batchId: string; pinned: boolean }) => ({ pinned: input.pinned }),
          toOptimistic: (input) => ({ pinned: input.pinned }),
        },
      ),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      await result.current.mutateAsync({ batchId: 'batch-1', pinned: true });
    });

    const active = queryClient.getQueryData<InfiniteData<HistoryPage<Batch>>>(activeKey);
    expect(active?.pages[0]?.items[0]?.pinned).toBe(true);
    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(archiveKeys.list())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(collectionKeys.list())?.isInvalidated).toBe(true);
  });

  test('removes a returned batch from the active scope when the patch moves it elsewhere', async () => {
    const activeKey = historyKeys.list();
    const collectionId = 'collection-1';
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(activeKey, page([batch()]));

    globalThis.fetch = mock(() => Response.json(batch({ collectionId }))) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useScopedBatchPatch(
        { activeView: APP_VIEW_UNSORTED, q: '' },
        {
          toPatch: (input: { batchId: string; collectionId: string | null }) => ({ collectionId: input.collectionId }),
          toOptimistic: (input) => ({ collectionId: input.collectionId }),
        },
      ),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      await result.current.mutateAsync({ batchId: 'batch-1', collectionId });
    });

    const active = queryClient.getQueryData<InfiniteData<HistoryPage<Batch>>>(activeKey);
    expect(active?.pages[0]?.items).toEqual([]);
    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
  });

  test('refetches the live scope when navigation changes during a scoped patch', async () => {
    const activeKey = historyKeys.list();
    const collectionId = 'collection-1';
    const liveView = collectionView(collectionId);
    const liveKey = historyKeys.scoped(liveView, '');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(activeKey, page([batch()]));
    queryClient.setQueryData(liveKey, page([]));

    let resolveFetch: ((response: Response) => void) | undefined;
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;

    const { result } = renderHook(
      () => useScopedBatchPatch(
        { activeView: APP_VIEW_UNSORTED, q: '' },
        {
          toPatch: (input: { batchId: string; collectionId: string | null }) => ({ collectionId: input.collectionId }),
          toOptimistic: (input) => ({ collectionId: input.collectionId }),
        },
      ),
      { wrapper: wrapper(queryClient) },
    );

    const mutationPromise = result.current.mutateAsync({ batchId: 'batch-1', collectionId });
    await waitFor(() => { expect(resolveFetch).toBeDefined(); });
    useAtelierStore.setState({ view: liveView, q: '' });

    await act(async () => {
      resolveFetch?.(Response.json(batch({ collectionId })));
      await mutationPromise;
    });

    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(liveKey)?.isInvalidated).toBe(true);
  });
});
