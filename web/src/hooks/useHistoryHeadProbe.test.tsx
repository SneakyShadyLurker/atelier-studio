import type { Batch } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { PropsWithChildren } from 'react';
import { historyKeys } from '../api/history';
import { APP_VIEW_UNSORTED } from '../store/atelier';
import { flushQueryNotifications } from '../../test/fixtures/queryNotifications';
import type { HistoryData } from './historyCache';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';
import { probeHistoryHead, useHistoryHeadProbe } from './useHistoryHeadProbe';

const originalFetch = globalThis.fetch;
const key = historyKeys.list();

function row(id: string, createdAt: number, tiles: Batch['tiles'] = []): Batch {
  return { id, prompt: id, ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt, collectionId: null, pinned: false, status: 'done', tiles };
}

function seed(client: QueryClient, items: readonly Batch[], nextCursor: string | null = 'c0'): void {
  client.setQueryData<HistoryData>(key, { pages: [{ items: [...items], nextCursor }], pageParams: [null] });
}

const ids = (client: QueryClient) => client.getQueryData<HistoryData>(key)?.pages.flatMap((page) => page.items.map((item) => item.id));

function serve(server: () => readonly Batch[]) {
  const limits: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
    const limit = Number(url.searchParams.get('limit'));
    limits.push(String(limit));
    return Promise.resolve(Response.json({ items: server().slice(0, limit), nextCursor: server().length > limit ? 'next' : null }));
  }) as unknown as typeof fetch;
  return limits;
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setVisibility('visible');
});

describe('probeHistoryHead', () => {
  test('a current head costs one 1-row read and changes nothing', async () => {
    const client = new QueryClient();
    seed(client, [row('b', 20), row('a', 10)]);
    const before = client.getQueryData(key);
    const limits = serve(() => [row('b', 20), row('a', 10)]);
    expect(await probeHistoryHead(client, APP_VIEW_UNSORTED, new AbortController().signal)).toBe('current');
    expect(limits).toEqual(['1']);
    expect(client.getQueryData(key) === before).toBe(true);
  });

  test('a new head merges the unknown rows of one 30-row read in canonical order', async () => {
    const client = new QueryClient();
    seed(client, [row('b', 20), row('a', 10)]);
    const limits = serve(() => [row('d', 40), row('c', 30), row('b', 20), row('a', 10)]);
    expect(await probeHistoryHead(client, APP_VIEW_UNSORTED, new AbortController().signal)).toBe('merged');
    expect(limits).toEqual(['1', '30']);
    expect(ids(client)).toEqual(['d', 'c', 'b', 'a']);
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  });

  test('invalidates the scope only when every row of the read is unknown', async () => {
    const client = new QueryClient();
    seed(client, [row('b', 20), row('a', 10)]);
    serve(() => Array.from({ length: 31 }, (_, index) => row(`n${String(index).padStart(2, '0')}`, 100 - index)));
    expect(await probeHistoryHead(client, APP_VIEW_UNSORTED, new AbortController().signal)).toBe('invalidated');
    expect(ids(client)).toEqual(['b', 'a']);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  test('discards a response when a history write started after the request', async () => {
    const client = new QueryClient();
    seed(client, [row('b', 20)]);
    let started = false;
    globalThis.fetch = mock(() => {
      if (!started) {
        started = true;
        void client.getMutationCache()
          .build(client, { mutationKey: HISTORY_WRITE_MUTATION_KEY, mutationFn: () => Promise.resolve(null) })
          .execute(undefined);
      }
      return Promise.resolve(Response.json({ items: [row('c', 30)], nextCursor: null }));
    }) as unknown as typeof fetch;
    expect(await probeHistoryHead(client, APP_VIEW_UNSORTED, new AbortController().signal)).toBe('discarded');
    expect(ids(client)).toEqual(['b']);
  });
});

describe('probeHistoryHead read generation', () => {
  test('discards its 30-row response when the scope was re-read while it was in flight', async () => {
    const client = new QueryClient();
    seed(client, [row('c', 30), row('b', 20)]);
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls += 1;
      // The 1-row probe sees a new head; the 30-row read still lists c, which
      // another device archived. A refetch that dropped c lands first.
      if (calls === 2) seed(client, [row('b', 20)]);
      return Promise.resolve(Response.json({ items: [row('d', 40), row('c', 30), row('b', 20)], nextCursor: null }));
    }) as unknown as typeof fetch;
    expect(await probeHistoryHead(client, APP_VIEW_UNSORTED, new AbortController().signal)).toBe('discarded');
    expect(ids(client)).toEqual(['b']);
  });
});

describe('useHistoryHeadProbe', () => {
  const wrapper = (client: QueryClient) => ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const wait = async (ms: number) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); await flushQueryNotifications(); }); };

  test('shows an other-device arrival on the next probe when idle', async () => {
    const client = new QueryClient();
    seed(client, [row('b', 20)]);
    const limits = serve(() => [row('c', 30), row('b', 20)]);
    renderHook(() => { useHistoryHeadProbe(APP_VIEW_UNSORTED, '', { intervalMs: 20 }); }, { wrapper: wrapper(client) });
    // No probe on mount: the first one waits a full interval.
    expect(limits).toEqual([]);
    await wait(80);
    expect(ids(client)).toEqual(['c', 'b']);
    expect(limits.slice(0, 2)).toEqual(['1', '30']);
  });

  test('stays silent while hidden, searching, writing, loading or without a cache', async () => {
    const cases: { name: string; q?: string; arrange: (client: QueryClient) => void }[] = [
      { name: 'hidden', arrange: () => { setVisibility('hidden'); } },
      { name: 'searching', q: 'chair', arrange: () => undefined },
      { name: 'writing', arrange: (client) => { void client.getMutationCache().build(client, { mutationKey: HISTORY_WRITE_MUTATION_KEY, mutationFn: () => new Promise(() => undefined) }).execute(undefined); } },
      { name: 'loading', arrange: (client) => { seed(client, [row('b', 20, [{ id: 't', seed: 1, status: 'loading' }])]); } },
      { name: 'no cache', arrange: (client) => { client.removeQueries({ queryKey: key }); } },
    ];
    for (const { name, q = '', arrange } of cases) {
      const client = new QueryClient();
      seed(client, [row('b', 20)]);
      client.setQueryData<HistoryData>(historyKeys.scoped(APP_VIEW_UNSORTED, q), { pages: [{ items: [row('b', 20)], nextCursor: 'c0' }], pageParams: [null] });
      arrange(client);
      const limits = serve(() => [row('c', 30), row('b', 20)]);
      renderHook(() => { useHistoryHeadProbe(APP_VIEW_UNSORTED, q, { intervalMs: 20 }); }, { wrapper: wrapper(client) });
      await wait(80);
      expect({ name, limits }).toEqual({ name, limits: [] });
      cleanup();
      setVisibility('visible');
      client.clear();
    }
  });
});
