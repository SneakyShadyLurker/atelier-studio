import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { collectionKeys } from '../src/api/collections';
import { useHistory } from '../src/hooks/useHistory';
import {
  APP_VIEW_ARCHIVE,
  APP_VIEW_PINNED,
  APP_VIEW_UNSORTED,
  collectionView,
  useAtelierStore,
} from '../src/store/atelier';
import { parseUrlState, serializeUrlState, useUrlState } from '../src/store/urlState';

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function installUrl(search = ''): void {
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', `http://localhost/${search}`);
}

afterEach(() => {
  cleanup();
  mock.restore();
  installUrl('');
  useAtelierStore.setState({
    view: APP_VIEW_UNSORTED,
    q: '',
    activeBatchId: null,
    lightbox: null,
    toasts: [],
  });
});

describe('URL state parsing and serialization', () => {
  test('parses every AppView shape and truncates q', () => {
    expect(parseUrlState(new URLSearchParams(''))).toEqual({ view: APP_VIEW_UNSORTED, q: '' });
    expect(parseUrlState(new URLSearchParams('?view=archive'))).toEqual({ view: APP_VIEW_ARCHIVE, q: '' });
    expect(parseUrlState(new URLSearchParams('?view=archive&archive=unsorted'))).toEqual({
      view: { kind: 'archive', scope: { kind: 'unsorted' } },
      q: '',
    });
    expect(parseUrlState(new URLSearchParams('?view=archive&archive=pinned'))).toEqual({
      view: { kind: 'archive', scope: { kind: 'pinned' } },
      q: '',
    });
    expect(parseUrlState(new URLSearchParams('?view=pinned'))).toEqual({ view: APP_VIEW_PINNED, q: '' });
    expect(parseUrlState(new URLSearchParams('?view=unsorted'))).toEqual({ view: APP_VIEW_UNSORTED, q: '' });
    // The vestigial global 'history' view was removed (URL-reachable
    // data-loss footgun): ?view=history falls through to Unsorted.
    expect(parseUrlState(new URLSearchParams('?view=history'))).toEqual({ view: APP_VIEW_UNSORTED, q: '' });
    // ?view=archive&c=<id> means archive scoped to that collection (NOT
    // an active collection view). The non-archive collection route uses
    // ?c=<id> without view=archive.
    expect(parseUrlState(new URLSearchParams('?view=archive&c=019e13e4-f168-7555-8dbe-6be97df82b17'))).toEqual({
      view: { kind: 'archive', scope: { kind: 'collection', id: '019e13e4-f168-7555-8dbe-6be97df82b17' } },
      q: '',
    });
    expect(parseUrlState(new URLSearchParams('?c=019e13e4-f168-7555-8dbe-6be97df82b17'))).toEqual({
      view: collectionView('019e13e4-f168-7555-8dbe-6be97df82b17'),
      q: '',
    });
    expect(parseUrlState(new URLSearchParams(`?q=${'x'.repeat(250)}`)).q).toHaveLength(200);
  });

  test('serializes canonical short forms', () => {
    expect(serializeUrlState(APP_VIEW_UNSORTED, '')).toBe('');
    expect(serializeUrlState(APP_VIEW_ARCHIVE, '')).toBe('?view=archive');
    expect(serializeUrlState(APP_VIEW_PINNED, '')).toBe('?view=pinned');
    expect(serializeUrlState(collectionView('019e13e4-f168-7555-8dbe-6be97df82b17'), '')).toBe('?c=019e13e4-f168-7555-8dbe-6be97df82b17');
    expect(serializeUrlState(APP_VIEW_UNSORTED, 'red chair')).toBe('?q=red+chair');
    expect(serializeUrlState(APP_VIEW_ARCHIVE, 'red chair')).toBe('?view=archive&q=red+chair');
  });
});

describe('useUrlState', () => {
  test('hydrates on mount and pushes exactly once for user changes', async () => {
    installUrl('?view=archive&q=chairs');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(collectionKeys.list(), { items: [], summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
    const pushState = mock(window.history.pushState.bind(window.history));
    window.history.pushState = pushState;

    renderHook(() => { useUrlState(); }, { wrapper: wrapper(client) });

    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_ARCHIVE);
    expect(useAtelierStore.getState().q).toBe('chairs');
    expect(pushState).not.toHaveBeenCalled();

    act(() => {
      useAtelierStore.getState().setView(APP_VIEW_PINNED);
    });

    await waitFor(() => {
      expect(pushState).toHaveBeenCalledTimes(1);
    });
    expect(pushState.mock.calls[0]?.[2]).toBe('/?view=pinned&q=chairs');
  });

  test('q-only changes replaceState (filter), never pushState per keystroke', async () => {
    installUrl('?view=pinned');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(collectionKeys.list(), { items: [], summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
    const pushState = mock(window.history.pushState.bind(window.history));
    const replaceState = mock(window.history.replaceState.bind(window.history));
    window.history.pushState = pushState;
    window.history.replaceState = replaceState;

    renderHook(() => { useUrlState(); }, { wrapper: wrapper(client) });

    act(() => { useAtelierStore.getState().setQ('r'); });
    act(() => { useAtelierStore.getState().setQ('re'); });
    act(() => { useAtelierStore.getState().setQ('red'); });

    await waitFor(() => {
      expect(replaceState.mock.calls.at(-1)?.[2]).toBe('/?view=pinned&q=red');
    });
    // The regression: per-keystroke search must not flood the history stack.
    expect(pushState).not.toHaveBeenCalled();
  });

  test('popstate reconciles without echoing pushState', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(collectionKeys.list(), { items: [], summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
    const pushState = mock(window.history.pushState.bind(window.history));
    window.history.pushState = pushState;
    renderHook(() => { useUrlState(); }, { wrapper: wrapper(client) });

    act(() => {
      window.history.replaceState({}, '', 'http://localhost/?view=pinned&q=abc');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_PINNED);
    expect(useAtelierStore.getState().q).toBe('abc');
    expect(pushState).not.toHaveBeenCalled();
  });

  test('invalid collection deep link falls back without fetching the bad collection scope', async () => {
    const collectionId = '019e13e4-f168-7555-8dbe-6be97df82b17';
    installUrl(`?c=${collectionId}`);
    const seenUrls: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seenUrls.push(url);
      if (url.endsWith('/collections')) {
        return Response.json({ items: [], summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
      }
      if (url.includes('collectionId=')) return new Response('bad collection fetch', { status: 500 });
      return Response.json({ items: [], nextCursor: null });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => {
      useUrlState();
      const view = useAtelierStore((state) => state.view);
      const q = useAtelierStore((state) => state.q);
      return useHistory(view, q);
    }, { wrapper: wrapper(client) });

    await waitFor(() => {
      expect(useAtelierStore.getState().view).toEqual(APP_VIEW_UNSORTED);
    });
    expect(window.location.search).toBe('');
    expect(seenUrls.some((url) => url.includes(`collectionId=${collectionId}`))).toBe(false);
  });

  test('missing collection id in cached list is refetched before fallback', async () => {
    const collectionId = '019e13e4-f168-7555-8dbe-6be97df82b17';
    installUrl(`?c=${collectionId}`);
    const seenUrls: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seenUrls.push(url);
      if (url.endsWith('/collections')) {
        return Response.json({
          items: [{ id: collectionId, name: 'Fresh', count: 0, createdAt: 1 }],
          summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
        });
      }
      return Response.json({ items: [], nextCursor: null });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(collectionKeys.list(), { items: [], summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
    renderHook(() => {
      useUrlState();
      const view = useAtelierStore((state) => state.view);
      const q = useAtelierStore((state) => state.q);
      return useHistory(view, q);
    }, { wrapper: wrapper(client) });

    await waitFor(() => {
      expect(useAtelierStore.getState().view).toEqual(collectionView(collectionId));
    });
    expect(window.location.search).toBe(`?c=${collectionId}`);
    expect(seenUrls).toContain('/api/collections');
  });
});
