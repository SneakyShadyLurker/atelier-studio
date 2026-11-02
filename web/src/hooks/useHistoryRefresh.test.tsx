import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { PropsWithChildren } from 'react';
import type { Batch } from '@atelier/shared';
import { historyKeys, type HistoryData } from '../api/history';
import { historyRefreshKeys, historyRefreshTargets, refreshHistory } from '../api/historyRefresh';
import { initialAtelierState, useAtelierStore } from '../store/atelier';
import { useHistory } from './useHistory';
import { mergeHistoryRefresh, useHistoryRefresh } from './useHistoryRefresh';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';
import { flushQueryNotifications } from '../../test/fixtures/queryNotifications';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; useAtelierStore.setState(initialAtelierState, true); });

function batch(overrides: Partial<Batch> = {}): Batch {
  return { id: crypto.randomUUID(), prompt: 'test', ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt: Date.now(), collectionId: null,
    pinned: false, status: 'running', tiles: [{ id: crypto.randomUUID(), seed: 1, status: 'loading' }], ...overrides };
}
function done(value: Batch): Batch {
  return { ...value, status: 'done', tiles: value.tiles.map((tile) => ({ ...tile, status: 'done', url: '/img/t.png', ext: 'png', mime: 'image/png', completedAt: Date.now() })) };
}
function wrap(client: QueryClient) {
  return ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function setup(pages: HistoryData['pages']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 }, mutations: { retry: false } } });
  const data: HistoryData = { pages, pageParams: pages.map((_, index) => index === 0 ? null : `cursor-${index}`) };
  client.setQueryData(historyKeys.list(), data);
  return { client, data };
}
const urlOf = (input: RequestInfo | URL) => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
// Callers wrap this in act; the trailing flush lets TanStack's batched observer
// notifications land inside it.
const tickRefresh = async (client: QueryClient) => {
  await client.refetchQueries({ queryKey: historyRefreshKeys.all() });
  await flushQueryNotifications();
};

describe('active history refresh', () => {
  test('surfaces active polling errors through the existing history error interface', async () => {
    const { client } = setup([{ items: [batch()], nextCursor: null }]);
    globalThis.fetch = mock(() => Promise.resolve(Response.json({ error: 'Polling unavailable' }, { status: 400 }))) as unknown as typeof fetch;
    const { result } = renderHook(() => useHistory(), { wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    await waitFor(() => { expect(client.getQueryState(historyRefreshKeys.scoped({ kind: 'unsorted' }, ''))?.status).toBe('error'); });
    await waitFor(() => { expect(result.current.isError).toBe(true); });
    expect(result.current.error?.message).toBe('Polling unavailable');
    client.clear();
  });

  test('existing Retry recovers the refresh failure and keeps its history result contract', async () => {
    const active = batch();
    const { client } = setup([{ items: [active], nextCursor: null }]);
    const requests: string[] = [];
    let refreshes = 0;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = urlOf(input);
      requests.push(url);
      if (url.startsWith('/api/history?')) return Promise.resolve(Response.json({ items: [active], nextCursor: null }));
      refreshes += 1;
      return Promise.resolve(refreshes === 1
        ? Response.json({ error: 'Polling unavailable' }, { status: 400 })
        : Response.json({ items: [done(active)], missingBatchIds: [] }));
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useHistory(), { wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    await waitFor(() => { expect(result.current.isError).toBe(true); });
    await act(async () => {
      const retried = await result.current.refetch();
      expect(retried.isSuccess).toBe(true);
      expect(retried.data?.pages).toHaveLength(1);
    });
    await waitFor(() => { expect(result.current.batches[0]?.tiles[0]?.status).toBe('done'); });
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
    expect(requests).toHaveLength(3);
    expect(requests[0]).toBe('/api/history/refresh');
    expect(requests[1]).toStartWith('/api/history?');
    expect(requests[2]).toBe('/api/history/refresh');
    client.clear();
  });

  test('Retry clears a refresh error without an idle POST when the history GET completes the work', async () => {
    const active = batch();
    const { client } = setup([{ items: [active], nextCursor: null }]);
    const requests: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = urlOf(input);
      requests.push(url);
      return Promise.resolve(url === '/api/history/refresh'
        ? Response.json({ error: 'Polling unavailable' }, { status: 400 })
        : Response.json({ items: [done(active)], nextCursor: null }));
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useHistory(), { wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    await waitFor(() => { expect(result.current.isError).toBe(true); });
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => { expect(result.current.batches[0]?.status).toBe('done'); });
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
    expect(client.getQueryState(historyRefreshKeys.scoped({ kind: 'unsorted' }, ''))?.status).toBe('success');
    await act(async () => { await tickRefresh(client); });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe('/api/history/refresh');
    expect(requests[1]).toStartWith('/api/history?');
    client.clear();
  });

  test('terminal completion clears stale errors before a later job or another scope', async () => {
    const active = batch();
    const { client } = setup([{ items: [active], nextCursor: null }]);
    const fetch = mock(() => Promise.resolve(Response.json({ error: 'Polling unavailable' }, { status: 400 })));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    client.setQueryData(historyKeys.scoped({ kind: 'pinned' }, ''), { pages: [{ items: [done(batch({ pinned: true }))], nextCursor: null }], pageParams: [null] });
    const { result, rerender } = renderHook(({ pinned }) => useHistory(pinned ? { kind: 'pinned' } : { kind: 'unsorted' }), { initialProps: { pinned: false }, wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    await waitFor(() => { expect(result.current.isError).toBe(true); });
    act(() => { client.setQueryData(historyKeys.list(), { pages: [{ items: [done(active)], nextCursor: null }], pageParams: [null] }); });
    await waitFor(() => { expect(result.current.isError).toBe(false); });
    expect(result.current.error).toBeNull();
    await act(async () => { await tickRefresh(client); });
    expect(fetch).toHaveBeenCalledTimes(1);
    // A different job must not inherit the completed job's old failure before
    // its own first poll. A fresh failure may still surface normally.
    const next = batch();
    act(() => { client.setQueryData(historyKeys.list(), { pages: [{ items: [next, done(active)], nextCursor: null }], pageParams: [null] }); });
    await waitFor(() => { expect(result.current.batches.some((item) => item.id === next.id)).toBe(true); });
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await tickRefresh(client); });
    await waitFor(() => { expect(result.current.isError).toBe(true); });
    rerender({ pinned: true });
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
    client.clear();
  });

  test('disabled refresh hides its cached error and makes no refresh requests', async () => {
    const { client, data } = setup([{ items: [batch()], nextCursor: null }]);
    const fetch = mock(() => Promise.resolve(Response.json({ error: 'Polling unavailable' }, { status: 400 })));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const { result, rerender } = renderHook(({ enabled }) => useHistoryRefresh({ kind: 'unsorted' }, '', data, enabled), { initialProps: { enabled: true }, wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    await waitFor(() => { expect(result.current.isError).toBe(true); });
    rerender({ enabled: false });
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
    await act(async () => { await tickRefresh(client); });
    expect(fetch).toHaveBeenCalledTimes(1);
    client.clear();
  });

  test.each(['transport', 'server'] as const)('%s polling errors surface after native retries are exhausted', async (failure) => {
    const { client } = setup([{ items: [batch()], nextCursor: null }]);
    const fetch = mock(() => failure === 'transport'
      ? Promise.reject(new TypeError('Network unavailable'))
      : Promise.resolve(Response.json({ error: 'Service unavailable' }, { status: 503 })));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const { result } = renderHook(() => useHistory(), { wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    await waitFor(() => { expect(result.current.isError).toBe(true); });
    expect(result.current.error?.message).toBe(failure === 'transport' ? 'Network unavailable' : 'Service unavailable');
    expect(fetch).toHaveBeenCalledTimes(3);
    client.clear();
  });

  test('twenty cached pages with one deep active job use one request and preserve pagination', async () => {
    const active = batch();
    const pages = Array.from({ length: 20 }, (_, index) => ({ items: [index === 19 ? active : done(batch())], nextCursor: index === 19 ? null : `cursor-${index + 1}` }));
    const { client, data } = setup(pages);
    const requests: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => { requests.push(urlOf(input)); return Promise.resolve(Response.json({ items: [done(active)], missingBatchIds: [] })); }) as unknown as typeof fetch;
    renderHook(() => useHistory(), { wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    expect(requests).toEqual(['/api/history/refresh']);
    const current = client.getQueryData<HistoryData>(historyKeys.list());
    expect(current?.pages[19]?.items[0]?.tiles[0]?.status).toBe('done');
    expect(current?.pages.map((page) => page.nextCursor)).toEqual(data.pages.map((page) => page.nextCursor));
    expect(current?.pageParams).toEqual(data.pageParams);
    client.clear();
  });

  test('terminal idle histories make no refresh requests', async () => {
    const { client } = setup([{ items: [done(batch())], nextCursor: null }]);
    const fetch = mock(() => Promise.resolve(Response.json({ items: [], missingBatchIds: [] })));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    renderHook(() => useHistory(), { wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    expect(fetch).not.toHaveBeenCalled();
    client.clear();
  });

  test('discovers a pending first story batch, then later segments between renders', async () => {
    const story = { id: crypto.randomUUID(), status: 'rendering' as const, segmentIndex: 0, segmentCount: 2, logline: 'arc', etaMs: 100 };
    const first = done(batch({ story, createdAt: 10 }));
    const next = batch({ story: { ...story, segmentIndex: 1 }, createdAt: 20 });
    const { client } = setup([{ items: [], nextCursor: null }]);
    useAtelierStore.getState().setPendingStory({ id: story.id, until: Date.now() + 10_000 });
    let pass = 0;
    const bodies: unknown[] = [];
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON refresh body');
      bodies.push(JSON.parse(init.body)); pass += 1;
      return Promise.resolve(Response.json({ items: pass === 1 ? [first] : [next, first], missingBatchIds: [] }));
    }) as unknown as typeof fetch;
    renderHook(() => useHistory(), { wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    expect(client.getQueryData<HistoryData>(historyKeys.list())?.pages[0]?.items.map((item) => item.id)).toEqual([first.id]);
    await act(async () => { await tickRefresh(client); });
    expect(client.getQueryData<HistoryData>(historyKeys.list())?.pages[0]?.items.map((item) => item.id)).toEqual([next.id, first.id]);
    expect(bodies[0]).toMatchObject({ batchIds: [], storyIds: [story.id] });
    expect(bodies[1]).toMatchObject({ batchIds: [first.id], storyIds: [story.id] });
    client.clear();
  });

  test('stitching is tracked until the master reaches ready', async () => {
    const value = done(batch({ sequence: { id: crypto.randomUUID(), segmentCount: 2, totalDurationFrames: 248, masterStatus: 'stitching' } }));
    const { client } = setup([{ items: [value], nextCursor: null }]);
    const fetch = mock(() => Promise.resolve(Response.json({ items: [{ ...value, sequence: { ...value.sequence, masterStatus: 'ready' } }], missingBatchIds: [] })));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    renderHook(() => useHistory(), { wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    expect(client.getQueryData<HistoryData>(historyKeys.list())?.pages[0]?.items[0]?.sequence?.masterStatus).toBe('ready');
    await act(async () => { await tickRefresh(client); });
    expect(fetch).toHaveBeenCalledTimes(1);
    client.clear();
  });

  test('chunks every tracked ID without exceeding the endpoint cap', async () => {
    const ids = Array.from({ length: 205 }, () => crypto.randomUUID());
    const sizes: number[] = [];
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON refresh body');
      const body = JSON.parse(init.body) as { batchIds: string[] };
      sizes.push(body.batchIds.length);
      return Promise.resolve(Response.json({ items: [], missingBatchIds: body.batchIds }));
    }) as unknown as typeof fetch;
    const result = await refreshHistory({ batchIds: ids, storyIds: [] }, { kind: 'unsorted' }, '', new AbortController().signal);
    expect(sizes).toEqual([100, 100, 5]);
    expect(new Set(result.missingBatchIds)).toEqual(new Set(ids));
  });

  test('inserts an older discovered story segment on its canonical later page', () => {
    const story = { id: crypto.randomUUID(), status: 'rendering' as const, segmentIndex: 0, segmentCount: 3, logline: 'arc', etaMs: 1 };
    const newer = done(batch({ createdAt: 30 }));
    const older = done(batch({ createdAt: 10 }));
    const discovered = done(batch({ createdAt: 15, story }));
    const input: HistoryData = { pages: [{ items: [newer], nextCursor: 'cursor' }, { items: [older], nextCursor: null }], pageParams: [null, 'cursor'] };
    const result = mergeHistoryRefresh(input, { items: [discovered], missingBatchIds: [] }, [story.id]);
    expect(result.pages.map((page) => page.items.map((item) => item.createdAt))).toEqual([[30], [15, 10]]);
    expect(result.pages.map((page) => page.nextCursor)).toEqual(['cursor', null]);
    expect(result.pageParams).toBe(input.pageParams);
  });

  test('keeps terminal tiles, optimistic scope and removed-tile membership', () => {
    const value = done(batch({ collectionId: 'local-collection', pinned: true }));
    const server = { ...value, collectionId: null, pinned: false, tiles: [...value.tiles.map((tile) => ({ id: tile.id, seed: tile.seed, status: 'loading' as const })), { id: 'removed', seed: 1, status: 'loading' as const }] };
    const result = mergeHistoryRefresh({ pages: [{ items: [value], nextCursor: null }], pageParams: [null] }, { items: [server], missingBatchIds: [] });
    expect(result.pages[0]?.items[0]).toMatchObject({ collectionId: 'local-collection', pinned: true, tiles: value.tiles });
  });

  test('defers out-of-window discoveries until the cursor tail is exhausted, including same-time ID order', () => {
    const story = { id: crypto.randomUUID(), status: 'rendering' as const, segmentIndex: 0, segmentCount: 3, logline: 'arc', etaMs: 1 };
    const current = done(batch({ createdAt: 20, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
    const older = done(batch({ createdAt: 20, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', story }));
    const response = { items: [older], missingBatchIds: [] };
    const open: HistoryData = { pages: [{ items: [current], nextCursor: 'more' }], pageParams: [null] };
    expect(mergeHistoryRefresh(open, response, [story.id]).pages[0]?.items.map((item) => item.id)).toEqual([current.id]);
    const exhausted = { ...open, pages: [{ items: [current], nextCursor: null }] };
    const result = mergeHistoryRefresh(exhausted, response, [story.id]);
    expect(result.pages[0]?.items.map((item) => item.id)).toEqual([current.id, older.id]);
    expect(result.pageParams).toBe(exhausted.pageParams);
    expect(result.pages[0]?.nextCursor).toBeNull();
  });

  for (const change of ['terminal SSE', 'delete batch', 'delete tile', 'move', 'clear'] as const) {
    test(`a delayed poll cannot undo ${change}`, async () => {
      const value = batch();
      const { client } = setup([{ items: [value], nextCursor: null }]);
      const response = Promise.withResolvers<Response>();
      globalThis.fetch = mock(() => response.promise) as unknown as typeof fetch;
      renderHook(() => useHistory(), { wrapper: wrap(client) });
      let polling: Promise<void> | undefined;
      await act(async () => { polling = tickRefresh(client); await Promise.resolve(); });
      act(() => {
        if (change === 'clear') client.removeQueries({ queryKey: historyKeys.all() });
        else client.setQueryData<HistoryData>(historyKeys.list(), (current) => current && ({ ...current, pages: current.pages.map((page) => ({ ...page, items: change === 'delete batch' ? [] : page.items.map((item) => change === 'terminal SSE' ? done(item) : change === 'delete tile' ? { ...item, tiles: [] } : { ...item, collectionId: 'moved' }) })) }));
      });
      const before = client.getQueryData<HistoryData>(historyKeys.list());
      await act(async () => { response.resolve(Response.json({ items: [value], missingBatchIds: [] })); await polling; });
      expect(client.getQueryData<HistoryData>(historyKeys.list())).toBe(before);
      client.clear();
    });
  }

  test('an unrelated SSE update cannot starve a deep job refresh or overwrite the newer tile', async () => {
    const deep = batch();
    const live = batch();
    const { client } = setup([{ items: [live], nextCursor: 'next' }, { items: [deep], nextCursor: null }]);
    const response = Promise.withResolvers<Response>();
    globalThis.fetch = mock(() => response.promise) as unknown as typeof fetch;
    renderHook(() => useHistory(), { wrapper: wrap(client) });
    let polling: Promise<void> | undefined;
    await act(async () => { polling = tickRefresh(client); await Promise.resolve(); });
    const terminalLive = done(live);
    act(() => { client.setQueryData<HistoryData>(historyKeys.list(), (current) => current && ({
      ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => item.id === live.id ? terminalLive : item) })),
    })); });
    await act(async () => { response.resolve(Response.json({ items: [live, done(deep)], missingBatchIds: [] })); await polling; });
    const current = client.getQueryData<HistoryData>(historyKeys.list());
    expect(current?.pages[0]?.items[0]).toEqual(terminalLive);
    expect(current?.pages[1]?.items[0]?.tiles[0]?.status).toBe('done');
    expect(current?.pages.map((page) => page.nextCursor)).toEqual(['next', null]);
    client.clear();
  });

  test('a history-write mutation pauses/cancels refresh even when cache identity did not change', async () => {
    const value = batch();
    const { client } = setup([{ items: [value], nextCursor: null }]);
    const response = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal ?? undefined; return response.promise; }) as unknown as typeof fetch;
    const write = Promise.withResolvers<undefined>();
    const { result } = renderHook(() => {
      useHistory();
      return useMutation({ mutationKey: HISTORY_WRITE_MUTATION_KEY, mutationFn: () => write.promise });
    }, { wrapper: wrap(client) });
    let polling: Promise<void> | undefined;
    await act(async () => { polling = tickRefresh(client); await Promise.resolve(); });
    act(() => { result.current.mutate(); });
    await waitFor(() => { expect(signal?.aborted).toBe(true); });
    await act(async () => { write.resolve(undefined); response.resolve(Response.json({ items: [done(value)], missingBatchIds: [] })); await polling; });
    expect(client.getQueryData<HistoryData>(historyKeys.list())?.pages[0]?.items[0]?.tiles[0]?.status).toBe('loading');
    client.clear();
  });

  test('rendering story rows remain explicit tracked batches even between segments', () => {
    const value = done(batch({ story: { id: crypto.randomUUID(), status: 'rendering', segmentIndex: 0, segmentCount: 2, logline: 'arc', etaMs: 1 } }));
    if (!value.story) throw new Error('expected story');
    expect(historyRefreshTargets([value])).toEqual({ batchIds: [value.id], storyIds: [value.story.id] });
  });

  test('missing rendering-story batches are removed instead of keeping the poll alive', async () => {
    const value = done(batch({ story: { id: crypto.randomUUID(), status: 'rendering', segmentIndex: 0, segmentCount: 2, logline: 'arc', etaMs: 1 } }));
    const { client } = setup([{ items: [value], nextCursor: null }]);
    const fetch = mock(() => Promise.resolve(Response.json({ items: [], missingBatchIds: [value.id] })));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    renderHook(() => useHistory(), { wrapper: wrap(client) });
    await act(async () => { await tickRefresh(client); });
    expect(client.getQueryData<HistoryData>(historyKeys.list())?.pages[0]?.items).toEqual([]);
    await act(async () => { await tickRefresh(client); });
    expect(fetch).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
