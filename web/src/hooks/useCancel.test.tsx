import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Batch } from '@atelier/shared';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { InfiniteQueryObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { historyKeys, historyOpts } from '../api/history';
import { flushQueryNotifications } from '../../test/fixtures/queryNotifications';
import { createHistoryBroadcastMutationCache, resetBroadcastForTests } from './broadcastHistory';
import { resetCancelTombstones, type HistoryData } from './historyCache';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';
import { useCancel } from './useCancel';

const originalFetch = globalThis.fetch;
const originalBroadcastChannel = window.BroadcastChannel;

afterEach(() => {
  cleanup();
  resetBroadcastForTests();
  globalThis.fetch = originalFetch;
  window.BroadcastChannel = originalBroadcastChannel;
});

describe('cross-tab cancel settlement', () => {
  for (const status of [204, 500]) {
    test(`broadcasts committed history after a delayed DELETE settles with ${status}`, async () => {
      const response = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<undefined>();
      let settled = false;
      const messages: { type: string; batchId: string; afterSettlement: boolean }[] = [];
      class Channel {
        postMessage(message: { type: string; batchId: string }) {
          messages.push({ type: message.type, batchId: message.batchId, afterSettlement: settled });
        }
        addEventListener() { /* no local receiver */ }
        removeEventListener() { /* no local receiver */ }
        close() { /* no host resources */ }
      }
      window.BroadcastChannel = Channel as unknown as typeof BroadcastChannel;
      globalThis.fetch = mock(() => {
        started.resolve(undefined);
        return response.promise;
      }) as unknown as typeof fetch;
      // The app's MutationCache owns the settle broadcast (main.tsx).
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        mutationCache: createHistoryBroadcastMutationCache(),
      });
      const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      const { result } = renderHook(() => useCancel(), { wrapper });
      let cancellation: Promise<void> | undefined;
      try {
        await act(async () => {
          cancellation = result.current.cancelTile('batch-1', 'tile-1').catch(() => undefined);
          await started.promise;
        });
        // A sibling's early refetch can still see the terminal pre-delete row.
        // A tile cancel never asks the owning tab to abort its stream.
        expect(messages).toEqual([
          { type: 'invalidate', batchId: 'batch-1', afterSettlement: false },
        ]);
        await act(async () => {
          settled = true;
          response.resolve(new Response(status === 204 ? null : 'failed', { status }));
          await cancellation;
        });
        expect(messages.at(-1)).toEqual({ type: 'invalidate', batchId: 'batch-1', afterSettlement: true });
        expect(messages.filter((message) => message.type === 'invalidate')).toHaveLength(2);
      } finally {
        await act(async () => {
          response.resolve(new Response(status === 204 ? null : 'failed', { status }));
          await cancellation;
        });
        client.clear();
      }
    });
  }
});

describe('cancel convergence', () => {
  const batchRow = (tiles: readonly string[]): Batch => ({
    id: 'batch-1', prompt: 'p', ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt: 5,
    collectionId: null, pinned: false, status: 'running',
    tiles: tiles.map((id, index) => ({ id, seed: index, status: 'loading' as const })),
  });
  const pageOf = (batches: readonly Batch[]) => ({ pages: [{ items: [...batches], nextCursor: null }], pageParams: [null] });

  function setup(deleteStatus: number) {
    const reads: string[] = [];
    let serverRows: readonly Batch[] = [batchRow(['tile-1', 'tile-2'])];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
      if (init?.method === 'DELETE') return Promise.resolve(new Response(deleteStatus === 204 ? null : 'failed', { status: deleteStatus }));
      if (url.pathname === '/api/history') {
        reads.push(url.search);
        return Promise.resolve(Response.json({ items: serverRows, nextCursor: null }));
      }
      return Promise.resolve(Response.json({ items: [], summary: {} }));
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { reads, client, wrapper, setServerRows: (rows: readonly Batch[]) => { serverRows = rows; } };
  }

  afterEach(() => { resetCancelTombstones(); });

  const historySharing = () => {
    const structuralSharing = historyOpts().structuralSharing;
    if (typeof structuralSharing !== 'function') throw new Error('history structural sharing missing');
    return structuralSharing;
  };

  test('a cancel settling while another history write is pending reads history once, after that write', async () => {
    const { reads, client, wrapper } = setup(204);
    await client.infiniteQuery(historyOpts());
    const observer = new InfiniteQueryObserver(client, historyOpts());
    const unsubscribe = observer.subscribe(() => undefined);
    const readsBefore = reads.length;
    const write = Promise.withResolvers<null>();
    const other = client.getMutationCache()
      .build(client, { mutationKey: HISTORY_WRITE_MUTATION_KEY, mutationFn: () => write.promise })
      .execute(undefined);
    const { result } = renderHook(() => useCancel(), { wrapper });
    await act(async () => { await result.current.cancelTile('batch-1', 'tile-1'); await flushQueryNotifications(); });
    expect(reads.length).toBe(readsBefore);
    expect(client.getQueryState(historyKeys.list())?.isInvalidated).toBe(true);
    await act(async () => { write.resolve(null); await other; await flushQueryNotifications(); });
    await waitFor(() => { expect(reads.length).toBe(readsBefore + 1); });
    unsubscribe();
    client.clear();
  });

  test('a confirmed tile cancel keeps the tile out of a stale read; a failed one leaves no tombstone', async () => {
    const structuralSharing = historySharing();
    for (const status of [204, 500]) {
      const { client, wrapper } = setup(status);
      client.setDefaultOptions({ queries: { retry: false, structuralSharing } });
      client.setQueryData(historyKeys.list(), pageOf([batchRow(['tile-1', 'tile-2'])]));
      const { result } = renderHook(() => useCancel(), { wrapper });
      await act(async () => { await result.current.cancelTile('batch-1', 'tile-1').catch(() => undefined); });
      // A read sent before the DELETE committed lands now.
      client.setQueryData(historyKeys.list(), pageOf([batchRow(['tile-1', 'tile-2'])]));
      const tiles = client.getQueryData<HistoryData>(historyKeys.list())?.pages[0]?.items[0]?.tiles.map((tile) => tile.id);
      expect(tiles).toEqual(status === 204 ? ['tile-2'] : ['tile-1', 'tile-2']);
      cleanup();
      client.clear();
      resetCancelTombstones();
    }
  });

  test('a confirmed batch cancel tombstones every loading tile so the batch stays gone', async () => {
    const structuralSharing = historySharing();
    const { client, wrapper } = setup(204);
    client.setDefaultOptions({ queries: { retry: false, structuralSharing } });
    client.setQueryData(historyKeys.list(), pageOf([batchRow(['tile-1', 'tile-2'])]));
    const { result } = renderHook(() => useCancel(), { wrapper });
    await act(async () => { await result.current.cancelBatch('batch-1'); });
    client.setQueryData(historyKeys.list(), pageOf([batchRow(['tile-1', 'tile-2'])]));
    expect(client.getQueryData<HistoryData>(historyKeys.list())?.pages[0]?.items).toEqual([]);
    client.clear();
  });
});
