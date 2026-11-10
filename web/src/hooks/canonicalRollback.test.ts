import type { Batch, Tile } from '@atelier/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { historyKeys, historyOpts } from '../api/history';
import { APP_VIEW_PINNED } from '../store/atelier';
import { removeBatchFromCache, removeTileFromCache, upsertNewBatch, type HistoryData } from './historyCache';
import { beginCanonicalMirror, rollbackCanonicalMirror, updateBatchInActiveScope } from './scopedHistoryMutation';

// R2: a failed write undoes only what it changed, against each scope's current data.

const unsorted = historyKeys.list();
const pinnedKey = historyKeys.scoped(APP_VIEW_PINNED, '');

function sharingClient(): QueryClient {
  const structuralSharing = historyOpts().structuralSharing;
  if (typeof structuralSharing !== 'function') throw new Error('history structural sharing missing');
  return new QueryClient({ defaultOptions: { queries: { structuralSharing } } });
}

const done = (id: string): Tile => ({ id, seed: 1, status: 'done', url: `/api/img/${id}`, ext: 'png', mime: 'image/png', completedAt: 1 });

function row(id: string, createdAt: number, overrides: Partial<Batch> = {}): Batch {
  return {
    id, prompt: id, ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt,
    collectionId: null, pinned: false, status: 'done', tiles: [done(`${id}-1`)], ...overrides,
  };
}

function seed(client: QueryClient, key: readonly unknown[], pages: readonly (readonly Batch[])[]): void {
  client.setQueryData<HistoryData>(key, {
    pages: pages.map((items, index) => ({ items: [...items], nextCursor: index === pages.length - 1 ? null : `c${String(index)}` })),
    pageParams: pages.map((_, index) => (index === 0 ? null : `c${String(index - 1)}`)),
  });
}

const ids = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryData<HistoryData>(key)?.pages.map((page) => page.items.map((item) => item.id));

describe('batch removal rollback', () => {
  test('re-inserts the batch and keeps a concurrent insert, another row\'s removal and a page append', async () => {
    const client = sharingClient();
    seed(client, unsorted, [[row('c', 30), row('b', 20), row('a', 10)]]);
    const mirror = await beginCanonicalMirror(client, unsorted, 'b', { kind: 'removeBatch' });
    removeBatchFromCache(client, unsorted, 'b');
    // Other writers since the snapshot.
    upsertNewBatch(client, unsorted, row('d', 40));
    removeBatchFromCache(client, unsorted, 'a');
    client.setQueryData<HistoryData>(unsorted, (current) => current && ({
      ...current,
      pages: [...current.pages, { items: [row('z', 5)], nextCursor: null }],
      pageParams: [...current.pageParams, 'c0'],
    }));
    rollbackCanonicalMirror(client, mirror);
    expect(ids(client, unsorted)?.flat()).toEqual(['d', 'c', 'b', 'z']);
    expect(ids(client, unsorted)).toHaveLength(2);
    expect(client.getQueryData<HistoryData>(unsorted)?.pageParams).toEqual([null, 'c0']);
  });

  test('does not duplicate a batch another writer already put back', async () => {
    const client = sharingClient();
    seed(client, unsorted, [[row('b', 20), row('a', 10)]]);
    const mirror = await beginCanonicalMirror(client, unsorted, 'b', { kind: 'removeBatch' });
    removeBatchFromCache(client, unsorted, 'b');
    upsertNewBatch(client, unsorted, row('b', 20, { prompt: 'server copy' }));
    rollbackCanonicalMirror(client, mirror);
    expect(ids(client, unsorted)).toEqual([['b', 'a']]);
    expect(client.getQueryData<HistoryData>(unsorted)?.pages[0]?.items[0]?.prompt).toBe('server copy');
  });
});

describe('tile removal rollback', () => {
  const three = row('b', 20, { tiles: [done('t1'), done('t2'), done('t3')] });

  test('re-inserts the tile at its relative position while another tile of the batch stays deleted', async () => {
    const client = sharingClient();
    seed(client, unsorted, [[three]]);
    const mirror = await beginCanonicalMirror(client, unsorted, 'b', { kind: 'removeTile', tileId: 't2' });
    removeTileFromCache(client, unsorted, 'b', 't2');
    // A concurrent archive of t1 succeeds meanwhile.
    removeTileFromCache(client, unsorted, 'b', 't1');
    rollbackCanonicalMirror(client, mirror);
    expect(client.getQueryData<HistoryData>(unsorted)?.pages[0]?.items[0]?.tiles.map((tile) => tile.id)).toEqual(['t2', 't3']);
  });

  test('leaves a batch another writer removed, but restores a batch this write emptied', async () => {
    const client = sharingClient();
    seed(client, unsorted, [[three, row('solo', 10)]]);
    const tileMirror = await beginCanonicalMirror(client, unsorted, 'b', { kind: 'removeTile', tileId: 't2' });
    removeTileFromCache(client, unsorted, 'b', 't2');
    removeBatchFromCache(client, unsorted, 'b');
    rollbackCanonicalMirror(client, tileMirror);
    expect(ids(client, unsorted)).toEqual([['solo']]);

    const soloMirror = await beginCanonicalMirror(client, unsorted, 'solo', { kind: 'removeTile', tileId: 'solo-1' });
    removeTileFromCache(client, unsorted, 'solo', 'solo-1');
    expect(ids(client, unsorted)).toEqual([[]]);
    rollbackCanonicalMirror(client, soloMirror);
    expect(ids(client, unsorted)).toEqual([['solo']]);
  });
});

describe('field patch rollback', () => {
  test('a failed pin restores only the pin while a concurrent move keeps its collection', async () => {
    const client = sharingClient();
    seed(client, unsorted, [[row('b', 20), row('a', 10)]]);
    const mirror = await beginCanonicalMirror(client, unsorted, 'b', { kind: 'patch', patch: { pinned: true } });
    updateBatchInActiveScope(client, unsorted, 'b', { pinned: true });
    // A move to a collection lands meanwhile; the row leaves Unsorted.
    updateBatchInActiveScope(client, unsorted, 'b', { collectionId: 'c1' });
    rollbackCanonicalMirror(client, mirror);
    // The pin write never dropped the row from Unsorted, so it does not bring it back.
    expect(ids(client, unsorted)).toEqual([['a']]);
  });

  test('restores the field only where the row still holds this write\'s optimistic value', async () => {
    const client = sharingClient();
    seed(client, unsorted, [[row('b', 20), row('a', 10)]]);
    const mirror = await beginCanonicalMirror(client, unsorted, 'b', { kind: 'patch', patch: { pinned: true } });
    updateBatchInActiveScope(client, unsorted, 'b', { pinned: true });
    rollbackCanonicalMirror(client, mirror);
    expect(client.getQueryData<HistoryData>(unsorted)?.pages[0]?.items[0]?.pinned).toBe(false);
  });

  test('leaves a field another writer changed after this write\'s patch', async () => {
    const client = sharingClient();
    seed(client, pinnedKey, [[row('b', 20, { pinned: true })]]);
    const mirror = await beginCanonicalMirror(client, pinnedKey, 'b', { kind: 'patch', patch: { collectionId: 'c1' } });
    updateBatchInActiveScope(client, pinnedKey, 'b', { collectionId: 'c1' });
    updateBatchInActiveScope(client, pinnedKey, 'b', { collectionId: 'c2' });
    rollbackCanonicalMirror(client, mirror);
    expect(client.getQueryData<HistoryData>(pinnedKey)?.pages[0]?.items[0]?.collectionId).toBe('c2');
  });

  test('a failed unpin re-inserts the row into the Pinned scope it dropped from, beside new rows', async () => {
    const client = sharingClient();
    seed(client, pinnedKey, [[row('b', 20, { pinned: true }), row('a', 10, { pinned: true })]]);
    const mirror = await beginCanonicalMirror(client, pinnedKey, 'b', { kind: 'patch', patch: { pinned: false } });
    updateBatchInActiveScope(client, pinnedKey, 'b', { pinned: false });
    expect(ids(client, pinnedKey)).toEqual([['a']]);
    upsertNewBatch(client, pinnedKey, row('c', 30, { pinned: true }));
    rollbackCanonicalMirror(client, mirror);
    expect(ids(client, pinnedKey)).toEqual([['c', 'b', 'a']]);
  });
});
