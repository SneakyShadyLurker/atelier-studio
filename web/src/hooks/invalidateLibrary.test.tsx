import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { archiveKeys } from '../api/archive';
import { collectionKeys } from '../api/collections';
import { historyKeys } from '../api/history';
import { APP_VIEW_PINNED } from '../store/atelier';
import { invalidateLibrary } from './invalidateLibrary';

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
