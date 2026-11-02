import type { Batch, HistoryPage } from '@atelier/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { historyKeys, historyOpts } from '../api/history';
import {
  removeBatchFromCache,
  removeTileFromCache,
  updateBatchTile,
  updateBatchStatus,
  upsertNewBatch,
  type HistoryData,
} from './historyCache';

const key = historyKeys.list();

function batch(id: string, tiles: Batch['tiles']): Batch {
  return {
    id,
    prompt: 'test',
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst',
    modelLabel: 'GPT Image 2.5 Sunburst',
    createdAt: 1,
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles,
  };
}

function historyData(batches: readonly Batch[]): InfiniteData<HistoryPage<Batch>> {
  return { pages: [{ items: [...batches], nextCursor: null }], pageParams: [null] };
}

test('a fetched page owns a delayed optimistic batch without duplicates or skipped intervening rows', () => {
  const structuralSharing = historyOpts().structuralSharing;
  if (typeof structuralSharing !== 'function') throw new Error('history structural sharing missing');
  const client = new QueryClient({ defaultOptions: { queries: { structuralSharing } } });
  const b2 = { ...batch('b2', []), createdAt: 3 };
  const b1 = { ...batch('b1', []), createdAt: 2 };
  const older = { ...batch('older', []), createdAt: 0 };
  const optimistic = { ...batch('a', [{ id: 'a-tile', seed: 1, status: 'loading' }]), status: 'running' as const };
  client.setQueryData(key, { pages: [{ items: [b2], nextCursor: 'cursor-b2' }], pageParams: [null] });
  upsertNewBatch(client, key, optimistic);
  const server = {
    ...optimistic, prompt: 'server prompt', status: 'done' as const, pinned: true,
    tiles: [{ id: 'a-tile', seed: 1, status: 'done' as const, url: '/api/img/a-tile', ext: 'png' as const, mime: 'image/png' as const, completedAt: 10 }],
  };
  client.setQueryData<HistoryData>(key, (current) => {
    if (!current) throw new Error('missing cache');
    return {
      ...current,
      pages: [...current.pages, { items: [b1, server, older], nextCursor: 'cursor-older' }],
      pageParams: [null, 'cursor-b2'],
    };
  });
  const cached = client.getQueryData<HistoryData>(key);
  expect(cached?.pages.map((page) => page.items.map((item) => item.id))).toEqual([['b2'], ['b1', 'a', 'older']]);
  expect(cached?.pages.map((page) => page.nextCursor)).toEqual(['cursor-b2', 'cursor-older']);
  expect(cached?.pageParams).toEqual([null, 'cursor-b2']);
  expect(cached?.pages[1]?.items[1]).toEqual(server);
  expect(cached?.loadingTileCount).toBe(0);
  expect(cached?.activeByModel).toEqual({});
  expect(cached?.pages.every((page) => page.loadingTileCount === 0)).toBe(true);

  updateBatchTile(client, key, 'a', { id: 'a-tile', seed: 1, status: 'failed', error: 'interrupted', completedAt: 11 });
  const updated = client.getQueryData<HistoryData>(key);
  expect(updated?.pages.flatMap((page) => page.items).filter((item) => item.id === 'a')).toHaveLength(1);
  expect(updated?.pages[1]?.items[1]?.tiles[0]?.status).toBe('failed');
  client.setQueryData<HistoryData>(key, updated);
  expect(client.getQueryData<HistoryData>(key)).toBe(updated);
});

test('a delayed loading page keeps newer terminal SSE tiles while using server page placement and membership', () => {
  const structuralSharing = historyOpts().structuralSharing;
  if (typeof structuralSharing !== 'function') throw new Error('history structural sharing missing');
  const client = new QueryClient({ defaultOptions: { queries: { structuralSharing } } });
  const b2 = { ...batch('b2', []), createdAt: 3 };
  const b1 = { ...batch('b1', []), createdAt: 2 };
  const loading = { ...batch('a', [
    { id: 'a-tile', seed: 1, status: 'loading' },
    { id: 'removed-tile', seed: 2, status: 'loading' },
  ]), status: 'running' as const };
  client.setQueryData(key, { pages: [{ items: [b2], nextCursor: 'cursor-b2' }], pageParams: [null] });
  upsertNewBatch(client, key, loading);
  const beforeSse = client.getQueryData<HistoryData>(key);
  if (!beforeSse) throw new Error('missing cache snapshot');
  const done = { id: 'a-tile', seed: 1, status: 'done' as const, url: '/api/img/a-tile', ext: 'png' as const, mime: 'image/png' as const, completedAt: 10 };
  updateBatchTile(client, key, 'a', done);
  updateBatchTile(client, key, 'a', { ...done, id: 'removed-tile', seed: 2, completedAt: 11 });
  updateBatchStatus(client, key, 'a', { status: 'done' });
  // Both incoming copies were captured before the terminal SSE. The server
  // page owns placement and omits a deleted tile that must not be resurrected.
  client.setQueryData(key, {
    ...beforeSse,
    pages: [...beforeSse.pages, { items: [b1, { ...loading, tiles: loading.tiles.slice(0, 1) }], nextCursor: null }],
    pageParams: [null, 'cursor-b2'],
  });
  const cached = client.getQueryData<HistoryData>(key);
  expect(cached?.pages.map((page) => page.items.map((item) => item.id))).toEqual([['b2'], ['b1', 'a']]);
  expect(cached?.pages[1]?.items[1]?.tiles).toEqual([done]);
  expect(cached?.pages[1]?.items[1]?.status).toBe('done');
  expect(cached?.pages.map((page) => page.nextCursor)).toEqual(['cursor-b2', null]);
  expect(cached?.loadingTileCount).toBe(0);
  expect(cached?.activeByModel).toEqual({});
});

describe('historyCache loadingTileCount', () => {
  test('upsertNewBatch tags the cache with the number of loading tiles', () => {
    const client = new QueryClient();
    client.setQueryData(key, historyData([]));

    upsertNewBatch(client, key, batch('batch-1', [
      { id: 'loading-1', seed: 1, status: 'loading' },
      { id: 'loading-2', seed: 2, status: 'loading' },
    ]));

    expect(client.getQueryData<HistoryData>(key)?.loadingTileCount).toBe(2);
  });

  test('upsertNewBatch drops stale loadingBatches metadata when page items change', () => {
    const client = new QueryClient();
    client.setQueryData(key, {
      pages: [{
        items: [],
        nextCursor: null,
        loadingTileCount: 1,
        hasLoadingTiles: true,
        loadingBatches: [{ batchId: 'old-loading', startedAt: 1 }],
      }],
      pageParams: [null],
      loadingTileCount: 1,
    });

    upsertNewBatch(client, key, batch('new-loading', [
      { id: 'loading-1', seed: 1, status: 'loading' },
    ]));

    expect(client.getQueryData<HistoryData>(key)?.pages[0]).not.toHaveProperty('loadingBatches');
  });

  test('updateBatchTile decrements the tag when a loading tile becomes terminal', () => {
    const client = new QueryClient();
    client.setQueryData(key, historyData([
      batch('batch-1', [
        { id: 'loading-1', seed: 1, status: 'loading' },
        { id: 'loading-2', seed: 2, status: 'loading' },
      ]),
    ]));
    upsertNewBatch(client, key, batch('batch-2', []));

    updateBatchTile(client, key, 'batch-1', {
      id: 'loading-1',
      seed: 1,
      status: 'done',
      url: '/api/img/loading-1',
      ext: 'png',
      mime: 'image/png',
      completedAt: 1,
    });

    expect(client.getQueryData<HistoryData>(key)?.loadingTileCount).toBe(1);
  });

  test('upsertNewBatch inserts at canonical createdAt-DESC position even when SSE arrival order is scrambled', () => {
    // Regression: 15-roll multi-burst would visibly reorder when a refetch
    // landed mid-burst, because optimistic cache stored SSE-arrival order
    // while the server returned `created_at DESC`. The fix sorts on insert
    // so refetch is order-stable.
    const client = new QueryClient();
    client.setQueryData(key, historyData([]));
    const mkBatch = (id: string, createdAt: number): Batch => ({
      ...batch(id, [{ id: `${id}-t1`, seed: 1, status: 'loading' }]),
      createdAt,
    });

    // SSE arrivals deliberately out of canonical order.
    upsertNewBatch(client, key, mkBatch('B7', 1007));
    upsertNewBatch(client, key, mkBatch('B1', 1001));  // oldest, arrives later
    upsertNewBatch(client, key, mkBatch('B9', 1009));  // newest, arrives mid
    upsertNewBatch(client, key, mkBatch('B5', 1005));

    const ids = client.getQueryData<HistoryData>(key)?.pages[0]?.items.map((b) => b.id);
    // Canonical order: newest first (created_at DESC).
    expect(ids).toEqual(['B9', 'B7', 'B5', 'B1']);
  });

  test('upsertNewBatch ties on createdAt break by id DESC (matches server ORDER BY created_at DESC, id DESC)', () => {
    const client = new QueryClient();
    client.setQueryData(key, historyData([]));
    const mkBatch = (id: string): Batch => ({
      ...batch(id, [{ id: `${id}-t1`, seed: 1, status: 'loading' }]),
      createdAt: 1000,
    });
    upsertNewBatch(client, key, mkBatch('aaaa'));
    upsertNewBatch(client, key, mkBatch('zzzz'));
    upsertNewBatch(client, key, mkBatch('mmmm'));

    const ids = client.getQueryData<HistoryData>(key)?.pages[0]?.items.map((b) => b.id);
    expect(ids).toEqual(['zzzz', 'mmmm', 'aaaa']);
  });

  test('removeTileFromCache and removeBatchFromCache decrement the tag', () => {
    const client = new QueryClient();
    client.setQueryData(key, historyData([]));
    upsertNewBatch(client, key, batch('batch-1', [
      { id: 'loading-1', seed: 1, status: 'loading' },
      { id: 'loading-2', seed: 2, status: 'loading' },
    ]));

    removeTileFromCache(client, key, 'batch-1', 'loading-1');
    expect(client.getQueryData<HistoryData>(key)?.loadingTileCount).toBe(1);

    removeBatchFromCache(client, key, 'batch-1');
    expect(client.getQueryData<HistoryData>(key)?.loadingTileCount).toBe(0);
  });
});

describe('upsertNewBatch ordering across pages', () => {
  test('a late event for an older batch lands on the page its creation time belongs to', () => {
    const at = (id: string, createdAt: number): Batch => ({ ...batch(id, []), createdAt });
    const client = new QueryClient();
    client.setQueryData(key, {
      pages: [
        { items: [at('p0-a', 50), at('p0-b', 40)], nextCursor: 'c1' },
        { items: [at('p1-a', 30), at('p1-b', 10)], nextCursor: null },
      ],
      pageParams: [null, 'c1'],
    });

    upsertNewBatch(client, key, at('late', 20));

    const pages = client.getQueryData<HistoryData>(key)?.pages.map((page) => page.items.map((item) => item.id));
    expect(pages).toEqual([['p0-a', 'p0-b'], ['p1-a', 'late', 'p1-b']]);
  });
});
