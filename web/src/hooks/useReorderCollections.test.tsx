import type { CollectionsResponse } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { collectionKeys } from '../api/collections';
import { useReorderCollections } from './useReorderCollections';

const originalFetch = globalThis.fetch;

function collections(ids: readonly string[]): CollectionsResponse {
  return {
    items: ids.map((id, index) => ({ id, name: id.toUpperCase(), count: 0, archivedCount: 0, createdAt: index })),
    summary: {
      totalCount: 0,
      pinnedCount: 0,
      unsortedCount: 0,
      archivedTotalCount: 0,
      archivedPinnedCount: 0,
      archivedUnsortedCount: 0,
    },
  };
}

interface PendingRequest {
  readonly orderedIds: readonly string[];
  readonly resolve: (response: Response) => void;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  mock.restore();
});

describe('useReorderCollections', () => {
  test('an earlier response landing between keyboard moves does not rewind the newest optimistic order', async () => {
    const requests: PendingRequest[] = [];
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return Promise.resolve(Response.json(collections(['a', 'b', 'c', 'd'])));
      if (typeof init.body !== 'string') throw new Error('expected a JSON string reorder body');
      const { orderedIds } = JSON.parse(init.body) as { orderedIds: string[] };
      return new Promise<Response>((resolve) => { requests.push({ orderedIds, resolve }); });
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(collectionKeys.list(), collections(['a', 'b', 'c', 'd']));
    const announced: string[] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useReorderCollections({ onAnnounce: (message) => announced.push(message) }),
      { wrapper },
    );
    const cachedOrder = () => client.getQueryData<CollectionsResponse>(collectionKeys.list())?.items.map((item) => item.id);
    const settled: Promise<CollectionsResponse>[] = [];
    // Alt+ArrowDown on "a": the keyboard handler derives the next order from the cache.
    const moveADown = async (label: string) => {
      const order = [...(cachedOrder() ?? [])];
      const index = order.indexOf('a');
      [order[index], order[index + 1]] = [order[index + 1] ?? 'a', 'a'];
      await act(async () => {
        settled.push(result.current.mutateAsync({ orderedIds: order, announce: { success: label, revert: `${label} reverted` } }));
        await Promise.resolve();
      });
      await waitFor(() => { expect(cachedOrder()).toEqual(order); });
    };
    // Answer the index-th serialized PUT and flush until that mutation settles.
    const respond = async (index: number, ids: readonly string[]) => {
      const request = requests[index];
      const done = settled[index];
      if (!request || !done) throw new Error(`reorder request ${index} was not issued`);
      await act(async () => {
        request.resolve(Response.json(collections(ids)));
        await done;
      });
    };

    await moveADown('first');
    await moveADown('second');
    await waitFor(() => { expect(requests).toHaveLength(1); });
    await respond(0, ['b', 'a', 'c', 'd']);
    await waitFor(() => { expect(announced).toEqual(['first']); });
    expect(cachedOrder()).toEqual(['b', 'c', 'a', 'd']);

    await moveADown('third');
    expect(cachedOrder()).toEqual(['b', 'c', 'd', 'a']);
    await waitFor(() => { expect(requests).toHaveLength(2); });
    await respond(1, ['b', 'c', 'a', 'd']);
    await waitFor(() => { expect(announced).toEqual(['first', 'second']); });
    expect(cachedOrder()).toEqual(['b', 'c', 'd', 'a']);

    await waitFor(() => { expect(requests).toHaveLength(3); });
    expect(requests[2]?.orderedIds).toEqual(['b', 'c', 'd', 'a']);
    await respond(2, ['b', 'c', 'd', 'a']);
    await waitFor(() => { expect(announced).toEqual(['first', 'second', 'third']); });
    expect(cachedOrder()).toEqual(['b', 'c', 'd', 'a']);
  });
});
