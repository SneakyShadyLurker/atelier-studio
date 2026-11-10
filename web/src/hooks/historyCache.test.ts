import type { Batch, HistoryPage } from '@atelier/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, test } from 'bun:test';
import { historyKeys, historyOpts } from '../api/history';
import {
  findTileInAnyScope,
  historyScopesWithBatch,
  reconcileHistoryPages,
  removeBatchFromCache,
  removeTileFromCache,
  resetCancelTombstones,
  CANCEL_TOMBSTONE_FINISHED_MS,
  forgetCanceledTiles,
  tombstoneCanceledTiles,
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
    modelId: 'gpt-image-2.6-sunburst',
    modelLabel: 'GPT Image 2.6 Sunburst',
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

describe('history order invariants', () => {
  const at = (id: string, createdAt: number): Batch => ({ ...batch(id, []), createdAt });
  const flatIds = (data: HistoryData | undefined) => data?.pages.flatMap((page) => page.items.map((item) => item.id));

  test('an emptied earlier page does not capture an older late arrival', () => {
    const client = new QueryClient();
    client.setQueryData(key, {
      pages: [
        { items: [], nextCursor: 'c1' },
        { items: [at('p1-a', 40), at('p1-b', 30)], nextCursor: null },
      ],
      pageParams: [null, 'c1'],
    });

    upsertNewBatch(client, key, at('late', 20));
    upsertNewBatch(client, key, at('newest', 50));

    expect(flatIds(client.getQueryData<HistoryData>(key))).toEqual(['newest', 'p1-a', 'p1-b', 'late']);
  });

  test('any upsert sequence keeps the cache in canonical created_at DESC, id DESC order', () => {
    // Deterministic pseudo-random permutations over pages with empty gaps,
    // ties and late arrivals; every state must flatten to the server order.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 200; run += 1) {
      const client = new QueryClient();
      const pageCount = 1 + Math.floor(next() * 4);
      client.setQueryData(key, {
        pages: Array.from({ length: pageCount }, (_, index) => ({ items: [], nextCursor: index === pageCount - 1 ? null : `c${index}` })),
        pageParams: Array.from({ length: pageCount }, (_, index) => (index === 0 ? null : `c${index - 1}`)),
      });
      const inserted: Batch[] = [];
      for (let step = 0; step < 12; step += 1) {
        const item = at(`b${run}-${step}`, Math.floor(next() * 6));
        inserted.push(item);
        upsertNewBatch(client, key, item);
        if (next() < 0.5) {
          const victim = inserted.splice(Math.floor(next() * inserted.length), 1)[0];
          if (victim) removeBatchFromCache(client, key, victim.id);
        }
      }
      const expected = inserted
        .toSorted((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .map((item) => item.id);
      expect(flatIds(client.getQueryData<HistoryData>(key))).toEqual(expected);
    }
  });

  test('a refetch read before an SSE terminal never regresses a finished tile to loading', () => {
    const structuralSharing = historyOpts().structuralSharing;
    if (typeof structuralSharing !== 'function') throw new Error('history structural sharing missing');
    const client = new QueryClient({ defaultOptions: { queries: { structuralSharing } } });
    const loading = { ...batch('a', [
      { id: 'a-1', seed: 1, status: 'loading' },
      { id: 'a-2', seed: 2, status: 'loading' },
    ]), createdAt: 5, status: 'running' as const };
    const stale = { pages: [{ items: [loading, at('older', 1)], nextCursor: null }], pageParams: [null] };
    client.setQueryData(key, stale);
    const done = { id: 'a-1', seed: 1, status: 'done' as const, url: '/api/img/a-1', ext: 'png' as const, mime: 'image/png' as const, completedAt: 10 };
    updateBatchTile(client, key, 'a', done);

    // The refetch snapshot predates the terminal event and has no duplicates.
    client.setQueryData(key, stale);

    const cached = client.getQueryData<HistoryData>(key);
    expect(cached?.pages[0]?.items[0]?.tiles).toEqual([done, { id: 'a-2', seed: 2, status: 'loading' }]);
    expect(cached?.pages[0]?.items[0]?.status).toBe('running');
    expect(cached?.loadingTileCount).toBe(1);
  });

  test('the newest terminal wins in both directions; equal times keep the incoming tile', () => {
    const structuralSharing = historyOpts().structuralSharing;
    if (typeof structuralSharing !== 'function') throw new Error('history structural sharing missing');
    const client = new QueryClient({ defaultOptions: { queries: { structuralSharing } } });
    const done = (completedAt: number) => ({ id: 'a-1', seed: 1, status: 'done' as const, url: `/api/img/a-1?${String(completedAt)}`, ext: 'png' as const, mime: 'image/png' as const, completedAt });
    const failed = (completedAt: number) => ({ id: 'a-1', seed: 1, status: 'failed' as const, error: 'interrupted' as const, completedAt });
    const put = (tile: Batch['tiles'][number]) => {
      client.setQueryData(key, { pages: [{ items: [{ ...batch('a', [tile]), createdAt: 5 }], nextCursor: null }], pageParams: [null] });
      return client.getQueryData<HistoryData>(key)?.pages[0]?.items[0]?.tiles[0];
    };

    expect(put(done(10))).toEqual(done(10));
    // An older terminal from a stale read loses.
    expect(put(failed(5))).toEqual(done(10));
    // A newer server terminal (startup reconcile marks interrupted work failed) wins.
    expect(put(failed(20))).toEqual(failed(20));
    // Equal completion times keep the incoming tile.
    expect(put(done(20))).toEqual(done(20));
  });
});

describe('history writes against a missing or invalidated cache', () => {
  const at = (id: string, createdAt: number): Batch => ({ ...batch(id, [{ id: `${id}-t1`, seed: 1, status: 'loading' }]), createdAt });
  const done = { id: 'a-t1', seed: 1, status: 'done' as const, url: '/api/img/a-t1', ext: 'png' as const, mime: 'image/png' as const, completedAt: 10 };

  test('tile, status and removal writes create nothing when the scope has no cache', () => {
    const client = new QueryClient();
    updateBatchTile(client, key, 'a', done);
    updateBatchStatus(client, key, 'a', { status: 'done' });
    removeTileFromCache(client, key, 'a', 'a-t1');
    removeBatchFromCache(client, key, 'a');
    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBeUndefined();
    // The insert is the one write that may seed a missing scope.
    upsertNewBatch(client, key, at('a', 5));
    expect(client.getQueryData<HistoryData>(key)?.pages[0]?.items.map((item) => item.id)).toEqual(['a']);
  });

  test('a stream write keeps a pending invalidation and the last server read\'s freshness clock', async () => {
    const client = new QueryClient();
    client.setQueryData(key, historyData([at('a', 5)]), { updatedAt: 1_000 });
    await client.invalidateQueries({ queryKey: key, refetchType: 'none' });
    expect(client.getQueryState(key)).toMatchObject({ isInvalidated: true, dataUpdatedAt: 1_000 });

    updateBatchTile(client, key, 'a', done);
    upsertNewBatch(client, key, at('b', 6));
    updateBatchStatus(client, key, 'a', { status: 'done' });

    expect(client.getQueryData<HistoryData>(key)?.pages[0]?.items.map((item) => item.id)).toEqual(['b', 'a']);
    expect(client.getQueryState(key)).toMatchObject({ isInvalidated: true, dataUpdatedAt: 1_000 });
    expect(client.getQueryCache().find({ queryKey: key, exact: true })?.isStale()).toBe(true);
  });

  test('historyScopesWithBatch lists every cached scope holding the batch', () => {
    const client = new QueryClient();
    const pinnedKey = historyKeys.scoped({ kind: 'pinned' }, '');
    const otherKey = historyKeys.scoped({ kind: 'collection', id: 'c1' }, '');
    client.setQueryData(key, historyData([at('a', 5)]));
    client.setQueryData(pinnedKey, historyData([{ ...at('a', 5), pinned: true }]));
    client.setQueryData(otherKey, historyData([at('z', 1)]));
    const keys = historyScopesWithBatch(client, historyKeys.all(), 'a').map((scope) => JSON.stringify(scope));
    expect(keys.toSorted()).toEqual([JSON.stringify(key), JSON.stringify(pinnedKey)].toSorted());
    expect(findTileInAnyScope(client, historyKeys.all(), 'a', 'a-t1')?.status).toBe('loading');
    expect(findTileInAnyScope(client, historyKeys.all(), 'nope', 'a-t1')).toBeUndefined();
  });
});

describe('reconcile keeps canonical order across page appends (R1)', () => {
  const at = (id: string, createdAt: number): Batch => ({ ...batch(id, []), createdAt });
  const canonical = (a: Batch, b: Batch) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const sharingClient = () => {
    const structuralSharing = historyOpts().structuralSharing;
    if (typeof structuralSharing !== 'function') throw new Error('history structural sharing missing');
    return new QueryClient({ defaultOptions: { queries: { structuralSharing } } });
  };

  test('a late arrival parked on the last page moves when a later page brings newer rows', () => {
    const client = sharingClient();
    client.setQueryData(key, { pages: [{ items: [at('p0-a', 50), at('p0-b', 40)], nextCursor: 'c0' }], pageParams: [null] });
    // Older than every loaded row: parked at the end of the last page.
    upsertNewBatch(client, key, at('late', 20));
    client.setQueryData<HistoryData>(key, (current) => current && ({
      ...current,
      pages: [...current.pages, { items: [at('p1-a', 30), at('p1-b', 10)], nextCursor: null }],
      pageParams: [...current.pageParams, 'c0'],
    }));
    const cached = client.getQueryData<HistoryData>(key);
    expect(cached?.pages.map((page) => page.items.map((item) => item.id))).toEqual([['p0-a', 'p0-b'], ['p1-a', 'late', 'p1-b']]);
    expect(cached?.pages.map((page) => page.nextCursor)).toEqual(['c0', null]);
    expect(cached?.pageParams).toEqual([null, 'c0']);
  });

  test('any interleaving of late inserts and page appends flattens to server order without duplicates', () => {
    let seed = 11;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 300; run += 1) {
      const client = sharingClient();
      const all = Array.from({ length: 6 + Math.floor(next() * 20) }, (_, index) => at(`r${run}-${index}`, Math.floor(next() * 8))).toSorted(canonical);
      const late = all.filter(() => next() < 0.3);
      const visible = new Set(all.filter((row) => !late.includes(row)).map((row) => row.id));
      const pageSize = 1 + Math.floor(next() * 4);
      const readPage = (after: Batch | undefined) => {
        const rows = all.filter((row) => visible.has(row.id) && (after === undefined || canonical(after, row) < 0));
        const items = rows.slice(0, pageSize);
        return { items, nextCursor: rows.length > pageSize ? `after-${items.at(-1)?.id ?? ''}` : null };
      };
      const first = readPage(undefined);
      client.setQueryData(key, { pages: [first], pageParams: [null] });
      let cursorRow = first.items.at(-1);
      let ended = first.nextCursor === null;
      const pendingLate = late.slice().sort(() => next() - 0.5);
      for (let step = 0; step < 40 && (!ended || pendingLate.length > 0); step += 1) {
        if (pendingLate.length > 0 && (ended || next() < 0.5)) {
          const row = pendingLate.pop();
          if (!row) continue;
          visible.add(row.id);
          upsertNewBatch(client, key, row);
        } else if (!ended) {
          const page = readPage(cursorRow);
          client.setQueryData<HistoryData>(key, (current) => current && ({
            ...current,
            pages: [...current.pages, page],
            pageParams: [...current.pageParams, `after-${cursorRow?.id ?? ''}`],
          }));
          cursorRow = page.items.at(-1) ?? cursorRow;
          ended = page.nextCursor === null;
        }
      }
      const flat = client.getQueryData<HistoryData>(key)?.pages.flatMap((page) => page.items) ?? [];
      expect(flat.map((row) => row.id)).toEqual(flat.toSorted(canonical).map((row) => row.id));
      expect(new Set(flat.map((row) => row.id)).size).toBe(flat.length);
    }
  });

  test('a write with nothing to fix keeps the incoming data object', () => {
    const loading = { ...batch('a', [{ id: 'a-1', seed: 1, status: 'loading' }]), createdAt: 5, status: 'running' as const };
    const previous = { pages: [{ items: [loading, at('b', 4)], nextCursor: 'c' }, { items: [at('c', 3)], nextCursor: null }], pageParams: [null, 'c'] } as HistoryData;
    const incoming = { ...previous, pages: previous.pages.map((page) => ({ ...page })) };
    expect(reconcileHistoryPages(incoming, previous) === incoming).toBe(true);
    expect(reconcileHistoryPages(incoming) === incoming).toBe(true);
  });
});

describe('confirmed cancellation tombstones (R4)', () => {
  const sharingClient = () => {
    const structuralSharing = historyOpts().structuralSharing;
    if (typeof structuralSharing !== 'function') throw new Error('history structural sharing missing');
    return new QueryClient({ defaultOptions: { queries: { structuralSharing } } });
  };
  const loadingBatch = (id: string, tileIds: readonly string[], createdAt: number): Batch => ({
    ...batch(id, tileIds.map((tileId, index) => ({ id: tileId, seed: index, status: 'loading' as const }))),
    createdAt,
    status: 'running',
  });
  afterEach(() => { resetCancelTombstones(); });

  test('a stale read never brings back a tile whose cancel the server confirmed', () => {
    const client = sharingClient();
    const stale = { pages: [{ items: [loadingBatch('a', ['a-1', 'a-2'], 5)], nextCursor: null }], pageParams: [null] };
    tombstoneCanceledTiles(['a-2']);
    client.setQueryData(key, stale);
    const cached = client.getQueryData<HistoryData>(key);
    expect(cached?.pages[0]?.items[0]?.tiles.map((tile) => tile.id)).toEqual(['a-1']);
    expect(cached?.loadingTileCount).toBe(1);
  });

  test('a tile the server handed back (a restore) is shown again at once', () => {
    const client = sharingClient();
    tombstoneCanceledTiles(['a-1', 'a-2']);
    forgetCanceledTiles(['a-2']);
    client.setQueryData(key, { pages: [{ items: [loadingBatch('a', ['a-1', 'a-2'], 5)], nextCursor: null }], pageParams: [null] });
    expect(client.getQueryData<HistoryData>(key)?.pages[0]?.items[0]?.tiles.map((tile) => tile.id)).toEqual(['a-2']);
  });

  test('a finished copy of a cancelled tile is a stale read for a minute, then a real restore', () => {
    // The cancel raced the tile's completion: the server archived the finished
    // tile. A read that sampled it between completion and the DELETE lands
    // within the minute and must not bring it back; a restore from another
    // tab later returns it finished, and then it shows.
    const client = sharingClient();
    const restored: Batch = {
      ...loadingBatch('a', ['a-1'], 5),
      tiles: [
        { id: 'a-1', seed: 0, status: 'loading' },
        { id: 'a-2', seed: 1, status: 'done', url: '/img/a-2.png', ext: 'png', mime: 'image/png', completedAt: 9 },
      ],
    };
    tombstoneCanceledTiles(['a-2']);
    client.setQueryData(key, { pages: [{ items: [restored], nextCursor: null }], pageParams: [null] });
    expect(client.getQueryData<HistoryData>(key)?.pages[0]?.items[0]?.tiles.map((tile) => tile.id)).toEqual(['a-1']);
    // More than a minute after the confirmation.
    tombstoneCanceledTiles(['a-2'], Date.now() - CANCEL_TOMBSTONE_FINISHED_MS - 1);
    client.setQueryData(key, { pages: [{ items: [{ ...restored }], nextCursor: null }], pageParams: [null] });
    expect(client.getQueryData<HistoryData>(key)?.pages[0]?.items[0]?.tiles.map((tile) => tile.id)).toEqual(['a-1', 'a-2']);
  });

  test('a batch whose every tile was cancelled does not reappear', () => {
    const client = sharingClient();
    tombstoneCanceledTiles(['a-1', 'a-2']);
    client.setQueryData(key, { pages: [{ items: [loadingBatch('a', ['a-1', 'a-2'], 5), loadingBatch('b', ['b-1'], 4)], nextCursor: null }], pageParams: [null] });
    expect(client.getQueryData<HistoryData>(key)?.pages[0]?.items.map((item) => item.id)).toEqual(['b']);
  });

  test('a tombstone expires five minutes after the confirmation', () => {
    const client = sharingClient();
    tombstoneCanceledTiles(['a-2'], Date.now() - 5 * 60_000 - 1);
    client.setQueryData(key, { pages: [{ items: [loadingBatch('a', ['a-1', 'a-2'], 5)], nextCursor: null }], pageParams: [null] });
    expect(client.getQueryData<HistoryData>(key)?.pages[0]?.items[0]?.tiles.map((tile) => tile.id)).toEqual(['a-1', 'a-2']);
  });
});
