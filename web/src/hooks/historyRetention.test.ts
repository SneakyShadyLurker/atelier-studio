import type { Batch } from '@atelier/shared';
import { InfiniteQueryObserver, QueryClient, type QueryKey } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { historyKeys } from '../api/history';
import { APP_VIEW_PINNED } from '../store/atelier';
import type { HistoryData } from './historyCache';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';
import { installHistoryRetention, trimHistoryPages } from './historyRetention';

const key = historyKeys.list();

function row(id: string, createdAt: number): Batch {
  return { id, prompt: id, ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt, collectionId: null, pinned: false, status: 'done', tiles: [] };
}

// `sizes[i]` rows on page i, newest first; every page but the last has a cursor.
function seed(client: QueryClient, sizes: readonly number[], queryKey: QueryKey = key): void {
  let createdAt = 100_000;
  client.setQueryData<HistoryData>(queryKey, {
    pages: sizes.map((size, page) => ({
      items: Array.from({ length: size }, (_, index) => row(`p${String(page)}-${String(index)}`, (createdAt -= 1))),
      nextCursor: page === sizes.length - 1 ? null : `c${String(page)}`,
    })),
    pageParams: sizes.map((_, page) => (page === 0 ? null : `c${String(page - 1)}`)),
  }, { updatedAt: 1_000 });
}

const pageSizes = (client: QueryClient, queryKey: QueryKey = key) =>
  client.getQueryData<HistoryData>(queryKey)?.pages.map((page) => page.items.length);

function pendingWrite(client: QueryClient) {
  const write = Promise.withResolvers<null>();
  const done = client.getMutationCache()
    .build(client, { mutationKey: HISTORY_WRITE_MUTATION_KEY, mutationFn: () => write.promise })
    .execute(undefined);
  return { settle: async () => { write.resolve(null); await done; } };
}

// A refetch of the cached pages, held until `settle`; it returns the same pages.
function holdFetch(client: QueryClient, queryKey: QueryKey = key) {
  const cached = client.getQueryData<HistoryData>(queryKey);
  const gate = Promise.withResolvers<null>();
  const readPage = async ({ pageParam }: { pageParam: string | null }) => {
    await gate.promise;
    const index = cached?.pageParams.indexOf(pageParam) ?? 0;
    return cached?.pages[index] ?? { items: [], nextCursor: null };
  };
  const done = client.infiniteQuery({
    queryKey,
    queryFn: readPage,
    initialPageParam: null as string | null,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
  }).catch(() => undefined);
  return { settle: async () => { gate.resolve(null); await done; } };
}

describe('trimHistoryPages', () => {
  test('keeps the newest pages with their cursors and the last server read\'s clock', () => {
    const client = new QueryClient();
    seed(client, [30, 30, 30, 30, 30]);
    expect(trimHistoryPages(client, key, 3)).toBe('trimmed');
    const data = client.getQueryData<HistoryData>(key);
    expect(pageSizes(client)).toEqual([30, 30, 30]);
    expect(data?.pageParams).toEqual([null, 'c0', 'c1']);
    expect(data?.pages.at(-1)?.nextCursor).toBe('c2');
    expect(data?.pages[0]?.items[0]?.id).toBe('p0-0');
    expect(client.getQueryState(key)?.dataUpdatedAt).toBe(1_000);
  });

  test('is a no-op within the bounds or without a cache', () => {
    const client = new QueryClient();
    seed(client, [30, 30, 30]);
    const before = client.getQueryData(key);
    expect(trimHistoryPages(client, key, 3)).toBe('noop');
    expect(client.getQueryData(key) === before).toBe(true);
    expect(trimHistoryPages(client, historyKeys.scoped(APP_VIEW_PINNED, ''), 3)).toBe('noop');
  });

  test('is blocked while the scope fetches or a history write is pending', async () => {
    const client = new QueryClient();
    seed(client, [30, 30, 30, 30]);
    const fetch = holdFetch(client);
    expect(trimHistoryPages(client, key, 3)).toBe('blocked');
    await fetch.settle();
    seed(client, [30, 30, 30, 30]);
    const write = pendingWrite(client);
    expect(trimHistoryPages(client, key, 3)).toBe('blocked');
    expect(pageSizes(client)).toEqual([30, 30, 30, 30]);
    await write.settle();
    expect(trimHistoryPages(client, key, 3)).toBe('trimmed');
  });

  test('kept pages grown past 240 rows invalidate the scope once for a repacking read', () => {
    const client = new QueryClient();
    seed(client, [130, 120, 30, 30]);
    expect(trimHistoryPages(client, key, 3)).toBe('trimmed');
    expect(pageSizes(client)).toEqual([130, 120, 30]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(trimHistoryPages(client, key, 3)).toBe('noop');
  });
});

describe('installHistoryRetention', () => {
  test('trims a scope when it loses its last observer', () => {
    const client = new QueryClient();
    installHistoryRetention(client);
    seed(client, [30, 30, 30, 30, 30]);
    const observer = new InfiniteQueryObserver(client, { queryKey: key, queryFn: () => Promise.resolve({ items: [], nextCursor: null }), initialPageParam: null, getNextPageParam: () => undefined, enabled: false });
    const first = observer.subscribe(() => undefined);
    const other = new InfiniteQueryObserver(client, { queryKey: key, queryFn: () => Promise.resolve({ items: [], nextCursor: null }), initialPageParam: null, getNextPageParam: () => undefined, enabled: false });
    const second = other.subscribe(() => undefined);
    first();
    expect(pageSizes(client)).toEqual([30, 30, 30, 30, 30]);
    second();
    expect(pageSizes(client)).toEqual([30, 30, 30]);
  });

  test('retries a blocked trim once the write settles, and drops it if an observer came back', async () => {
    const client = new QueryClient();
    installHistoryRetention(client);
    installHistoryRetention(client);
    const options = { queryKey: key, queryFn: () => Promise.resolve({ items: [], nextCursor: null }), initialPageParam: null, getNextPageParam: () => undefined, enabled: false };
    seed(client, [30, 30, 30, 30]);
    let write = pendingWrite(client);
    new InfiniteQueryObserver(client, options).subscribe(() => undefined)();
    expect(pageSizes(client)).toEqual([30, 30, 30, 30]);
    await write.settle();
    expect(pageSizes(client)).toEqual([30, 30, 30]);

    seed(client, [30, 30, 30, 30]);
    write = pendingWrite(client);
    new InfiniteQueryObserver(client, options).subscribe(() => undefined)();
    const back = new InfiniteQueryObserver(client, options).subscribe(() => undefined);
    await write.settle();
    expect(pageSizes(client)).toEqual([30, 30, 30, 30]);
    back();
  });

  test('retries a trim blocked by a fetch when that fetch settles', async () => {
    const client = new QueryClient();
    installHistoryRetention(client);
    seed(client, [30, 30, 30, 30]);
    const fetch = holdFetch(client);
    const options = { queryKey: key, queryFn: () => Promise.resolve({ items: [], nextCursor: null }), initialPageParam: null, getNextPageParam: () => undefined, enabled: false };
    new InfiniteQueryObserver(client, options).subscribe(() => undefined)();
    expect(client.getQueryState(key)?.fetchStatus).toBe('fetching');
    expect(pageSizes(client)).toEqual([30, 30, 30, 30]);
    await fetch.settle();
    expect(pageSizes(client)).toEqual([30, 30, 30]);
  });
});
