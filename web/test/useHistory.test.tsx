import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { historyKeys } from '../src/api/history';
import { useHistory } from '../src/hooks/useHistory';
import { APP_VIEW_PINNED, APP_VIEW_UNSORTED, collectionView, type AppView } from '../src/store/atelier';

afterEach(() => {
  cleanup();
  mock.restore();
});

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useHistory', () => {
  test('historyKeys.list() resolves to the unsorted scope so streaming writes land where Canvas reads', () => {
    // Regression: Canvas subscribes to historyKeys.scoped(view, q). The
    // streaming generation path writes via historyKeys.list() (the home
    // cache). If list() resolved to a different scope than the home view,
    // new generations would update an invisible cache and never appear in
    // the visible feed.
    expect(historyKeys.list()).toEqual(historyKeys.scoped(APP_VIEW_UNSORTED, ''));
  });

  // The wire stays newest-first and the cursor paginates backwards through it;
  // `useHistory` is the single boundary that flips the list into FEED order —
  // oldest first, newest against the composer. Both halves are asserted here so
  // a change to either side has to face this test.
  test('fetches newest-first pages, hands off the opaque cursor, and exposes them oldest-first', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      seenUrls.push(url);
      if (url.endsWith('/history?limit=30&collectionId=null')) {
        return Response.json({
          items: [{
            id: 'batch-new',
            prompt: 'new',
            ratio: '1:1',
            modelId: 'm',
            modelLabel: 'M',
            createdAt: 2,
            collectionId: null,
              pinned: false,
              status: 'done',
            tiles: [{
              id: 'tile-new',
              seed: 1,
              status: 'done',
              url: '/api/img/tile-new',
              thumbUrl: '/api/img/tile-new/thumb',
              ext: 'png',
              mime: 'image/png',
              completedAt: 2,
            }],
          }],
          nextCursor: 'cursor-1',
        });
      }
      return Response.json({ items: [{ id: 'batch-old', prompt: 'old', ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt: 1, collectionId: null, pinned: false, status: 'done', tiles: [] }], nextCursor: null });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHistory(), { wrapper: wrapper(client) });

    await waitFor(() => { expect(result.current.batches.map((batch) => batch.id)).toEqual(['batch-new']); });
    await act(async () => {
      await result.current.fetchNextPage();
    });
    // Page 2 is OLDER, so in feed order it lands ABOVE the first page.
    await waitFor(() => { expect(result.current.batches.map((batch) => batch.id)).toEqual(['batch-old', 'batch-new']); });

    expect(seenUrls).toEqual(['/api/history?limit=30&collectionId=null', '/api/history?limit=30&cursor=cursor-1&collectionId=null']);
    const firstTile = result.current.batches.at(-1)?.tiles[0];
    expect(firstTile).toMatchObject({
      status: 'done',
      url: '/api/img/tile-new?media=2',
      thumbUrl: '/api/img/tile-new/thumb?media=2',
    });
  });
  test('loads until the first data exists: a collection scope awaiting its list is loading, a scope switch is not', async () => {
    const collections = Promise.withResolvers<Response>();
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/collections')) return collections.promise;
      const inCollection = url.includes('collectionId=c1');
      return Promise.resolve(Response.json({ items: [{ id: inCollection ? 'batch-c1' : 'batch-pinned', prompt: 'p', ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt: 1, collectionId: inCollection ? 'c1' : null, pinned: !inCollection, status: 'done', tiles: [] }], nextCursor: null }));
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(({ view }: { view: AppView }) => useHistory(view), {
      wrapper: wrapper(client),
      initialProps: { view: collectionView('c1') },
    });
    // The query is disabled (pending, idle) until the list validates c1.
    expect(result.current.isLoading).toBe(true);
    await act(async () => {
      collections.resolve(Response.json({ items: [{ id: 'c1', name: 'One', count: 1, archivedCount: 0, createdAt: 1 }], summary: { totalCount: 1, pinnedCount: 1, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }));
      await Promise.resolve();
    });
    await waitFor(() => { expect(result.current.batches.length).toBe(1); });
    expect(result.current.isLoading).toBe(false);

    // A scope switch keeps the previous rows as placeholder data, no plate.
    rerender({ view: APP_VIEW_PINNED });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.isLoading).toBe(false);
    await waitFor(() => { expect(result.current.isPlaceholderData).toBe(false); });
  });

  test('a collection id the list does not hold never loads, so it is not loading', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/collections')) return Promise.resolve(Response.json({ items: [], summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }));
      return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useHistory(collectionView('gone')), { wrapper: wrapper(client) });
    await waitFor(() => { expect(result.current.isLoading).toBe(false); });
  });
});
