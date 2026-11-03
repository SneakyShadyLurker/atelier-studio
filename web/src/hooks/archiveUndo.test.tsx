import type { Batch, HistoryPage } from '@atelier/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { archiveKeys } from '../api/archive';
import { historyKeys } from '../api/history';
import { useAtelierStore } from '../store/atelier';
import { useDeleteBatch } from './useDeleteBatch';
import { useDeleteTile } from './useDeleteTile';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';
import { useRestore } from './useRestore';

const originalFetch = globalThis.fetch;

type Tile = Batch['tiles'][number];

function done(id: string): Tile {
  return { id, seed: 1, status: 'done', url: `/api/img/${id}`, ext: 'png', mime: 'image/png', completedAt: 1 };
}

function failed(id: string): Tile {
  return { id, seed: 2, status: 'failed', error: 'interrupted', completedAt: 2 };
}

function batch(id: string, tiles: Tile[]): Batch {
  return {
    id,
    prompt: 'a brass lamp',
    ratio: '1:1',
    modelId: 'm',
    modelLabel: 'M',
    createdAt: 1,
    collectionId: null,
    pinned: false,
    status: 'done',
    tiles,
  };
}

function clientWith(batches: Batch[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const data: InfiniteData<HistoryPage<Batch>> = { pages: [{ items: batches, nextCursor: null }], pageParams: [null] };
  client.setQueryData(historyKeys.list(), data);
  client.setQueryData(archiveKeys.list(), { items: [], nextCursor: null, total: 0 });
  return client;
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

interface Call { url: string; method: string }

function recordFetch(calls: Call[]): void {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push({ url, method });
    if (method === 'GET') return Promise.resolve(Response.json({ items: [], nextCursor: null, total: 0 }));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
}

function restoreCalls(calls: readonly Call[]): string[] {
  return calls.filter((call) => call.method === 'POST' && call.url.endsWith('/restore')).map((call) => call.url);
}

// The live "Archived" toast; one already fading out (leaving) is gone for the user.
function archivedToast() {
  return useAtelierStore.getState().toasts.find((toast) => toast.text === 'Archived' && !toast.leaving);
}

async function clickUndo(): Promise<void> {
  const action = archivedToast()?.action;
  expect(action?.label).toBe('Undo');
  await act(async () => {
    action?.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  for (const toast of useAtelierStore.getState().toasts) useAtelierStore.getState().removeToast(toast.id);
  useAtelierStore.setState({ toasts: [], lightbox: null, previews: new Map() });
});

describe('archive Undo', () => {
  test('single-tile archive offers Undo that restores that tile through the restore path', async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    const client = clientWith([batch('batch-1', [done('tile-a'), done('tile-b')])]);
    const { result } = renderHook(() => useDeleteTile(), { wrapper: wrapper(client) });

    act(() => { result.current.mutate({ batchId: 'batch-1', tileId: 'tile-a' }); });
    await waitFor(() => { expect(archivedToast()?.action?.label).toBe('Undo'); });

    const id = archivedToast()?.id;
    await clickUndo();
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Restored')).toBe(true); });
    expect(restoreCalls(calls)).toEqual(['/api/archive/tile-a/restore']);
    // The Undo toast fades out once used (two-phase dismiss), then unmounts
    // exactly once; restore refetches the library like the Archive view's Restore.
    expect(useAtelierStore.getState().toasts.find((toast) => toast.id === id)?.leaving).toBe(true);
    let unmounts = 0;
    const unsubscribe = useAtelierStore.subscribe((next, prev) => {
      if (prev.toasts.some((toast) => toast.id === id) && !next.toasts.some((toast) => toast.id === id)) unmounts += 1;
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    unsubscribe();
    expect(useAtelierStore.getState().toasts.some((toast) => toast.id === id)).toBe(false);
    expect(unmounts).toBe(1);
    expect(client.getQueryState(historyKeys.list())?.isInvalidated).toBe(true);
  });

  test('a dismissed failed tile gets no Undo: nothing was archived', async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    const client = clientWith([batch('batch-1', [failed('tile-f')])]);
    const { result } = renderHook(() => useDeleteTile(), { wrapper: wrapper(client) });

    act(() => { result.current.mutate({ batchId: 'batch-1', tileId: 'tile-f', intent: 'dismiss' }); });
    await waitFor(() => { expect(useAtelierStore.getState().toasts[0]?.text).toBe('Dismissed'); });
    expect(useAtelierStore.getState().toasts[0]?.action).toBeUndefined();
  });

  test('batch archive Undo restores only the tiles the archive kept (failed tiles were hard-deleted)', async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    const client = clientWith([batch('batch-1', [done('tile-a'), failed('tile-f'), done('tile-b')])]);
    const { result } = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    act(() => { result.current.mutate({ batchId: 'batch-1' }); });
    await waitFor(() => { expect(archivedToast()?.action?.label).toBe('Undo'); });

    await clickUndo();
    await waitFor(() => { expect(restoreCalls(calls)).toHaveLength(2); });
    expect(restoreCalls(calls).sort()).toEqual(['/api/archive/tile-a/restore', '/api/archive/tile-b/restore']);
  });

  test('a batch with work in flight goes through cancel and offers no Undo', async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    const client = clientWith([batch('batch-1', [{ id: 'tile-l', seed: 1, status: 'loading' }, done('tile-a')])]);
    const { result } = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    act(() => { result.current.mutate({ batchId: 'batch-1' }); });
    await waitFor(() => { expect(archivedToast()).toBeDefined(); });
    expect(archivedToast()?.action).toBeUndefined();
  });

  test('a failed archive shows no Undo toast at all', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response('nope', { status: 500 }))) as unknown as typeof fetch;
    const client = clientWith([batch('batch-1', [done('tile-a')])]);
    const { result } = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    act(() => { result.current.mutate({ batchId: 'batch-1' }); });
    await waitFor(() => { expect(useAtelierStore.getState().toasts[0]?.tone).toBe('error'); });
    expect(archivedToast()).toBeUndefined();
  });

  test('Undo fires once, and a second archive/undo restores only its own tiles', async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    const client = clientWith([batch('batch-1', [done('tile-a')]), batch('batch-2', [done('tile-c')])]);
    const { result } = renderHook(() => ({ tile: useDeleteTile(), batch: useDeleteBatch() }), { wrapper: wrapper(client) });

    act(() => { result.current.tile.mutate({ batchId: 'batch-1', tileId: 'tile-a' }); });
    await waitFor(() => { expect(archivedToast()?.action).toBeDefined(); });
    const firstAction = archivedToast()?.action;
    await clickUndo();
    // A stale reference to the first toast's action must not restore again.
    await act(async () => {
      firstAction?.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => { expect(restoreCalls(calls)).toEqual(['/api/archive/tile-a/restore']); });

    act(() => { result.current.batch.mutate({ batchId: 'batch-2' }); });
    await waitFor(() => { expect(archivedToast()?.action).toBeDefined(); });
    await clickUndo();
    await waitFor(() => { expect(restoreCalls(calls)).toHaveLength(2); });
    expect(restoreCalls(calls)).toEqual(['/api/archive/tile-a/restore', '/api/archive/tile-c/restore']);
  });

  test('a batch archive overlapping a pending tile archive from the same batch offers no Undo', async () => {
    const calls: Call[] = [];
    let releaseTile: (() => void) | undefined;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (method === 'DELETE' && url.includes('tile-a')) {
        return new Promise<Response>((resolve) => { releaseTile = () => { resolve(new Response(null, { status: 204 })); }; });
      }
      if (method === 'GET') return Promise.resolve(Response.json({ items: [], nextCursor: null, total: 0 }));
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    const client = clientWith([batch('batch-1', [done('tile-a'), done('tile-b')])]);
    const tile = renderHook(() => useDeleteTile(), { wrapper: wrapper(client) });
    const whole = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    act(() => { tile.result.current.mutate({ batchId: 'batch-1', tileId: 'tile-a' }); });
    await waitFor(() => { expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('tile-a'))).toBe(true); });
    act(() => { whole.result.current.mutate({ batchId: 'batch-1' }); });
    // The cache no longer holds tile-a, so an Undo built from it could miss a
    // tile the batch archive takes if the tile request fails: no Undo then.
    await waitFor(() => { expect(archivedToast()).toBeDefined(); });
    expect(archivedToast()?.action).toBeUndefined();
    await act(async () => { releaseTile?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  test('a restore set settles only after every request, even when one fails first', async () => {
    let releaseB: (() => void) | undefined;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/tile-a/restore')) return Promise.resolve(new Response(null, { status: 500 }));
      if (method === 'POST' && url.endsWith('/tile-b/restore')) {
        return new Promise<Response>((resolve) => { releaseB = () => { resolve(new Response(null, { status: 204 })); }; });
      }
      return Promise.resolve(Response.json({ items: [], nextCursor: null, total: 0 }));
    }) as unknown as typeof fetch;
    const client = clientWith([]);
    const { result } = renderHook(() => useRestore(), { wrapper: wrapper(client) });

    act(() => { result.current.mutate(['tile-a', 'tile-b']); });
    await waitFor(() => { expect(releaseB).toBeDefined(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    // tile-a has failed, but tile-b is still writing: the history-write fence holds.
    expect(client.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY })).toBe(1);
    await act(async () => { releaseB?.(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await waitFor(() => { expect(client.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY })).toBe(0); });
    expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true);
  });
});
