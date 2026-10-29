import type { Batch, HistoryPage } from '@atelier/shared';
import type { InfiniteData, QueryKey } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { archiveKeys } from '../api/archive';
import { collectionKeys } from '../api/collections';
import { historyKeys } from '../api/history';
import { useAtelierStore } from '../store/atelier';

const invalidateLibrarySpy = mock((queryClient: QueryClient) => Promise.all([
  queryClient.invalidateQueries({ queryKey: historyKeys.all() }),
  queryClient.invalidateQueries({ queryKey: archiveKeys.all() }),
  queryClient.invalidateQueries({ queryKey: collectionKeys.list() }),
]));

void mock.module('./invalidateLibrary', () => ({ invalidateLibrary: invalidateLibrarySpy }));

const { useDeleteBatch } = await import('./useDeleteBatch');
const { useDeleteTile } = await import('./useDeleteTile');
const { usePermanentDelete } = await import('./usePermanentDelete');
const { usePurgeArchive } = await import('./usePurgeArchive');
const { useRestore } = await import('./useRestore');

const originalFetch = globalThis.fetch;

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function batch(): Batch {
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
    tiles: [{
      id: 'tile-1',
      status: 'done',
      url: '/api/img/tile-1',
      ext: 'png',
      mime: 'image/png',
      seed: 1,
      completedAt: 1,
    }],
  };
}

function loadingBatch(): Batch {
  return {
    id: 'batch-loading',
    prompt: 'mid-flight',
    ratio: '1:1',
    modelId: 'm',
    modelLabel: 'M',
    createdAt: 2,
    collectionId: null,
    pinned: false,
    status: 'running',
    tiles: [{ id: 'tile-loading', status: 'loading', seed: 2 }],
  };
}

function page(items: readonly Batch[]): InfiniteData<HistoryPage<Batch>> {
  return { pages: [{ items, nextCursor: null }], pageParams: [null] };
}

function queryClientWithLibrary(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(historyKeys.list(), page([batch()]));
  queryClient.setQueryData(archiveKeys.list(), { items: [{ id: 'tile-1' }], nextCursor: null, total: 1 });
  queryClient.setQueryData(collectionKeys.list(), { items: [], summary: {} });
  return queryClient;
}

function rejectServerSide(): void {
  globalThis.fetch = mock(() => new Response('server failed', { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;
}

function acceptServerSide(): void {
  globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
}

async function mutateWith<TInput>(
  queryClient: QueryClient,
  useHook: () => { mutateAsync: (input: TInput) => Promise<unknown> },
  input: TInput,
): Promise<void> {
  const { result } = renderHook(() => useHook(), { wrapper: wrapper(queryClient) });

  await act(async () => {
    await result.current.mutateAsync(input).catch(() => undefined);
  });
}

function expectInvalidated(queryClient: QueryClient, queryKey: QueryKey): void {
  expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
}

afterEach(() => {
  cleanup();
  invalidateLibrarySpy.mockClear();
  globalThis.fetch = originalFetch;
  useAtelierStore.setState({ toasts: [], lightbox: null, previews: new Map() });
});

describe('destructive history mutations', () => {
  test('delete batch invalidates history and calls invalidateLibrary once when the server rejects', async () => {
    rejectServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => useDeleteBatch(), { batchId: 'batch-1' });

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expectInvalidated(queryClient, historyKeys.list());
  });

  test('delete batch invalidates history and calls invalidateLibrary once after success', async () => {
    acceptServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => useDeleteBatch(), { batchId: 'batch-1' });

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expectInvalidated(queryClient, historyKeys.list());
  });

  test('delete tile invalidates history and calls invalidateLibrary once when the server rejects', async () => {
    rejectServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => useDeleteTile(), { batchId: 'batch-1', tileId: 'tile-1' });

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expectInvalidated(queryClient, historyKeys.list());
  });

  test('delete tile invalidates history and calls invalidateLibrary once after success', async () => {
    acceptServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => useDeleteTile(), { batchId: 'batch-1', tileId: 'tile-1' });

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expectInvalidated(queryClient, historyKeys.list());
  });

  test('restore invalidates archive and calls invalidateLibrary once when the server rejects', async () => {
    rejectServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => useRestore(), 'tile-1');

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expectInvalidated(queryClient, archiveKeys.list());
  });

  test('restore invalidates archive and calls invalidateLibrary once after success', async () => {
    acceptServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => useRestore(), 'tile-1');

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expectInvalidated(queryClient, archiveKeys.list());
  });

  test('permanent delete invalidates archive and calls invalidateLibrary once when the server rejects', async () => {
    rejectServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => usePermanentDelete(), 'tile-1');

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expectInvalidated(queryClient, archiveKeys.list());
  });

  test('permanent delete invalidates archive and calls invalidateLibrary once after success', async () => {
    acceptServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => usePermanentDelete(), 'tile-1');

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expectInvalidated(queryClient, archiveKeys.list());
  });

  test('purge archive invalidates archive and calls invalidateLibrary once when the server rejects', async () => {
    rejectServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => usePurgeArchive(), undefined);

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expectInvalidated(queryClient, archiveKeys.list());
  });

  test('purge archive removes archive cache and calls invalidateLibrary once after success', async () => {
    acceptServerSide();
    const queryClient = queryClientWithLibrary();

    await mutateWith(queryClient, () => usePurgeArchive(), undefined);

    expect(invalidateLibrarySpy).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(archiveKeys.list())).toBeUndefined();
  });

  test('delete batch on the loading-tile branch cancels in-flight history queries', async () => {
    acceptServerSide();
    const queryClient = queryClientWithLibrary();
    queryClient.setQueryData(historyKeys.list(), page([loadingBatch()]));
    const cancelSpy = mock(queryClient.cancelQueries.bind(queryClient));
    queryClient.cancelQueries = cancelSpy;

    await mutateWith(queryClient, () => useDeleteBatch(), { batchId: 'batch-loading' });

    const matches = cancelSpy.mock.calls.filter(
      ([opts]) => JSON.stringify((opts as { queryKey?: unknown }).queryKey) === JSON.stringify(historyKeys.all()),
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  test('delete tile on the loading branch cancels in-flight history queries', async () => {
    acceptServerSide();
    const queryClient = queryClientWithLibrary();
    queryClient.setQueryData(historyKeys.list(), page([loadingBatch()]));
    const cancelSpy = mock(queryClient.cancelQueries.bind(queryClient));
    queryClient.cancelQueries = cancelSpy;

    await mutateWith(queryClient, () => useDeleteTile(), { batchId: 'batch-loading', tileId: 'tile-loading' });

    const matches = cancelSpy.mock.calls.filter(
      ([opts]) => JSON.stringify((opts as { queryKey?: unknown }).queryKey) === JSON.stringify(historyKeys.all()),
    );
    expect(matches.length).toBeGreaterThan(0);
  });
});
