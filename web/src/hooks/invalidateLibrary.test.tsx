import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { archiveKeys } from '../api/archive';
import { collectionKeys } from '../api/collections';
import { historyKeys } from '../api/history';
import { APP_VIEW_PINNED } from '../store/atelier';
import { invalidateLibrary } from './invalidateLibrary';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

describe('invalidateLibrary', () => {
  test('invalidates the canonical library query set', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const historyKey = historyKeys.scoped(APP_VIEW_PINNED, '');

    queryClient.setQueryData(historyKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(archiveKeys.list(), { pages: [], pageParams: [] });
    queryClient.setQueryData(collectionKeys.list(), { items: [], summary: {} });

    await invalidateLibrary(queryClient);

    expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(archiveKeys.list())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(collectionKeys.list())?.isInvalidated).toBe(true);
  });

  test('a settle re-read only marks history while another history write is still pending', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const key = historyKeys.list();
    let reads = 0;
    const observer = new (await import('@tanstack/react-query')).QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => { reads += 1; return Promise.resolve({ pages: [], pageParams: [] }); },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(reads).toBe(1);

    const other = Promise.withResolvers<null>();
    const otherWrite = queryClient.getMutationCache()
      .build(queryClient, { mutationKey: HISTORY_WRITE_MUTATION_KEY, mutationFn: () => other.promise })
      .execute(undefined);
    const settling = Promise.withResolvers<null>();
    const settlingWrite = queryClient.getMutationCache()
      .build(queryClient, {
        mutationKey: HISTORY_WRITE_MUTATION_KEY,
        mutationFn: () => settling.promise,
        onSettled: () => invalidateLibrary(queryClient),
      })
      .execute(undefined);
    settling.resolve(null);
    await settlingWrite;
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    expect(reads).toBe(1);

    // The deferred read runs by itself once the last write has settled.
    other.resolve(null);
    await otherWrite;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(reads).toBe(2);
    unsubscribe();
  });

  test('two writes whose settle windows overlap still produce exactly one trailing history refetch', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const key = historyKeys.list();
    let reads = 0;
    const observer = new (await import('@tanstack/react-query')).QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => { reads += 1; return Promise.resolve({ pages: [], pageParams: [] }); },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(reads).toBe(1);

    // Both writes resolve together; each onSettled sees the other still pending.
    const gate = Promise.withResolvers<null>();
    const settle = (): Promise<unknown> => queryClient.getMutationCache()
      .build(queryClient, {
        mutationKey: HISTORY_WRITE_MUTATION_KEY,
        mutationFn: () => gate.promise,
        onSettled: async () => { await new Promise((resolve) => { setTimeout(resolve, 5); }); await invalidateLibrary(queryClient); },
      })
      .execute(undefined);
    const a = settle();
    const b = settle();
    gate.resolve(null);
    await Promise.all([a, b]);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(reads).toBe(2);
    unsubscribe();
  });

  test('can mark history stale without refetching active observers', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const activeKey = historyKeys.list();
    const otherKey = historyKeys.scoped(APP_VIEW_PINNED, '');

    queryClient.setQueryData(activeKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(otherKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(archiveKeys.list(), { pages: [], pageParams: [] });
    queryClient.setQueryData(collectionKeys.list(), { items: [], summary: {} });

    await invalidateLibrary(queryClient, { historyRefetchType: 'none' });

    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(archiveKeys.list())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(collectionKeys.list())?.isInvalidated).toBe(true);
  });
});
