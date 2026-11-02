import type { Batch, HistoryPage, Tile } from '@atelier/shared';
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { activeByModelFromBatches, activeByModelFromPages } from '../lib/historyAggregation';
import type { ActiveModelCounts } from '../lib/historyAggregation';

// Canonical client-side augmentation of the wire HistoryPage<Batch>. Single
// definition — api/history.ts (the tagger) and scopedHistoryMutation.ts (the
// optimistic writers) import these; never redeclare them.
export interface LoadingBatchTag {
  batchId: string;
  /** Client-observed start of rendering; null while the batch is queued. */
  startedAt: number | null;
}

export type HistoryPageWithLoading = HistoryPage<Batch> & {
  hasLoadingTiles?: boolean;
  loadingTileCount?: number;
  loadingBatches?: readonly LoadingBatchTag[];
  activeByModel?: Record<string, ActiveModelCounts>;
};

export type HistoryData = InfiniteData<HistoryPageWithLoading> & {
  loadingTileCount?: number;
  activeByModel?: Record<string, ActiveModelCounts>;
};

// Mutation helpers — operate on a single page of ONE scoped history query.
// The `key` argument is the query key the caller is acting on:
//   - useGenerate passes historyKeys.list() (generation forces the Unsorted/
//     empty-q scope before streaming, so that is where the rows live)
//   - the delete/cancel hooks pass the active scope key the user is viewing,
//     so the optimistic mutation lands in the cache the user actually sees
// Cross-scope convergence is the caller's broad historyKeys.all() invalidate
// on settle — these helpers never assume a scope.
//
//   - upsertNewBatch  prepends to page 0 (matches createdAt DESC ordering)
//   - updateBatchTile finds which page holds the batch and updates that page
//   - removeBatch     finds the page and filters it (cascades to empty)
//   - removeTile      finds the page, filters the tile; if the batch is now
//                     empty, removes the batch too
//
// Transient partial-preview state is intentionally NOT here — it lives in
// the Zustand `previews` slice (store/atelier.ts). Storing partials in the
// TanStack cache caused them to vanish whenever a refetch landed (window-
// focus, reconnect, mutation invalidate), since /history's loading rows
// don't carry a preview field.

function emptyHistory(): HistoryData {
  return {
    pages: [{ items: [], nextCursor: null, hasLoadingTiles: false, loadingTileCount: 0, activeByModel: {} }],
    pageParams: [null],
    loadingTileCount: 0,
    activeByModel: {},
  };
}

function findPageIndex(data: HistoryData, batchId: string): number {
  return data.pages.findIndex((page) => page.items.some((batch) => batch.id === batchId));
}

// Read-only cache lookup used by SSE handlers to decide whether a late tile
// event still has a live target. Returns the tile if the batch + tile both
// exist in the cache, regardless of status — caller checks status. Used to
// drop partials whose tile has already been terminal'd in this stream OR
// whose batch was deleted by the user mid-stream.
export function findTileInCache(
  queryClient: QueryClient,
  key: QueryKey,
  batchId: string,
  tileId: string,
): Tile | undefined {
  const data = queryClient.getQueryData<HistoryData>(key);
  if (!data) return undefined;
  const idx = findPageIndex(data, batchId);
  if (idx === -1) return undefined;
  const batch = data.pages[idx]?.items.find((b) => b.id === batchId);
  return batch?.tiles.find((t) => t.id === tileId);
}

export function findBatchInCache(
  queryClient: QueryClient,
  key: QueryKey,
  batchId: string,
): Batch | undefined {
  const data = queryClient.getQueryData<HistoryData>(key);
  if (!data) return undefined;
  const idx = findPageIndex(data, batchId);
  if (idx === -1) return undefined;
  return data.pages[idx]?.items.find((batch) => batch.id === batchId);
}

// Snapshot all loading tile IDs in a batch before destructive mutations
// (useDeleteBatch). Lets callers clean up the corresponding preview store
// entries in the same handler that removes the batch from the cache.
export function loadingTileIdsInBatch(
  queryClient: QueryClient,
  key: QueryKey,
  batchId: string,
): readonly string[] {
  const data = queryClient.getQueryData<HistoryData>(key);
  if (!data) return [];
  const idx = findPageIndex(data, batchId);
  if (idx === -1) return [];
  const batch = data.pages[idx]?.items.find((b) => b.id === batchId);
  if (!batch) return [];
  return batch.tiles.filter((t) => t.status === 'loading').map((t) => t.id);
}

function loadingCountForTile(tile: Tile): number {
  return tile.status === 'loading' ? 1 : 0;
}

function loadingCountForBatch(batch: Batch): number {
  return batch.tiles.reduce((count, tile) => count + loadingCountForTile(tile), 0);
}

function loadingCountForBatches(batches: readonly Batch[]): number {
  return batches.reduce((count, batch) => count + loadingCountForBatch(batch), 0);
}

function loadingCountForData(data: HistoryData): number {
  if (typeof data.loadingTileCount === 'number') return data.loadingTileCount;
  if (data.pages.every((page) => typeof page.loadingTileCount === 'number')) {
    return data.pages.reduce((count, page) => count + (page.loadingTileCount ?? 0), 0);
  }
  return data.pages.reduce(
    (count, page) => count + loadingCountForBatches(page.items),
    0,
  );
}

function withLoadingCount(data: HistoryData, nextCount: number): HistoryData {
  return { ...data, loadingTileCount: Math.max(0, nextCount), activeByModel: activeByModelFromPages(data.pages) };
}

function tagPage(page: HistoryPageWithLoading, items: readonly Batch[]): HistoryPageWithLoading {
  const loadingTileCount = loadingCountForBatches(items);
  const { loadingBatches: _staleLoadingBatches, ...rest } = page;
  return { ...rest, items, loadingTileCount, hasLoadingTiles: loadingTileCount > 0, activeByModel: activeByModelFromBatches(items) };
}

export function retagHistoryData(data: HistoryData): HistoryData {
  const pages = data.pages.map((page) => tagPage(page, page.items));
  const loadingTileCount = pages.reduce((count, page) => count + (page.loadingTileCount ?? 0), 0);
  return { ...data, pages, loadingTileCount, activeByModel: activeByModelFromPages(pages) };
}

/**
 * A delayed optimistic batch may sit beyond a fetched page's cursor. When a
 * later page reaches it, keep the later page's row and authoritative payload.
 * Its server page also puts intervening rows back in canonical order.
 * Cursor/pageParam coverage stays intact.
 * Used at Query's structural-sharing boundary, so writers and readers see the
 * same normalized cache rather than hiding duplicates only in the view.
 */
export function reconcileHistoryPages(data: HistoryData, previous?: HistoryData): HistoryData {
  const latest = new Map<string, Batch>();
  const duplicateIds = new Set<string>();
  for (const page of data.pages) {
    for (const batch of page.items) {
      if (latest.has(batch.id)) duplicateIds.add(batch.id);
      latest.set(batch.id, batch);
    }
  }
  if (duplicateIds.size === 0) return data;
  // A fetched page can have been read before an SSE terminal landed. Keep its
  // page placement and tile membership, but never regress overlapping tiles
  // to loading or to an older terminal result while reconciling duplicates.
  const terminals = new Map<string, Map<string, Exclude<Tile, { status: 'loading' }>>>();
  const remember = (batch: Batch) => {
    if (!duplicateIds.has(batch.id)) return;
    const known = terminals.get(batch.id) ?? new Map<string, Exclude<Tile, { status: 'loading' }>>();
    for (const tile of batch.tiles) {
      if (tile.status === 'loading') continue;
      const existing = known.get(tile.id);
      if (!existing || tile.completedAt >= existing.completedAt) known.set(tile.id, tile);
    }
    terminals.set(batch.id, known);
  };
  for (const page of previous?.pages ?? []) for (const batch of page.items) remember(batch);
  for (const page of data.pages) for (const batch of page.items) remember(batch);
  const seen = new Set<string>();
  const pages = data.pages.toReversed().map((page) => ({
    ...page,
    items: page.items.flatMap((batch) => {
      if (seen.has(batch.id)) return [];
      seen.add(batch.id);
      const incoming = latest.get(batch.id) ?? batch;
      const known = terminals.get(batch.id);
      if (!known) return [incoming];
      const tiles = incoming.tiles.map((tile) => {
        const terminal = known.get(tile.id);
        return terminal && (tile.status === 'loading' || terminal.completedAt > tile.completedAt) ? terminal : tile;
      });
      const status: Batch['status'] = tiles.length > 0 && tiles.every((tile) => tile.status !== 'loading') ? 'done' : incoming.status;
      const changed = status !== incoming.status || tiles.some((tile, index) => tile !== incoming.tiles[index]);
      return [changed ? { ...incoming, tiles, status } : incoming];
    }),
  })).reverse();
  return retagHistoryData({ ...data, pages });
}

function setPage(data: HistoryData, index: number, items: readonly Batch[], loadingDelta = 0): HistoryData {
  const pages = data.pages.map((page, i) => (i === index ? tagPage(page, items) : page));
  return {
    ...data,
    loadingTileCount: Math.max(0, loadingCountForData(data) + loadingDelta),
    pages,
    activeByModel: activeByModelFromPages(pages),
  };
}

function setHistory(
  queryClient: QueryClient,
  key: QueryKey,
  mutate: (current: HistoryData) => HistoryData,
): void {
  queryClient.setQueryData<HistoryData>(key, (current) => mutate(current ?? emptyHistory()));
}

// The server's canonical order: `ORDER BY created_at DESC, id DESC`
// (`api/src/routes/history.ts`). True when `a` sorts before `b`.
export function sortsBefore(a: Batch, b: Batch): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}

// Insert `batch` into `items` at its canonical position. Items are assumed to
// already be in canonical order (the only insert path is this function).
function insertCanonical(items: readonly Batch[], batch: Batch): readonly Batch[] {
  const insertAt = items.findIndex((item) => sortsBefore(batch, item));
  const next = items.slice();
  next.splice(insertAt === -1 ? items.length : insertAt, 0, batch);
  return next;
}

function preserveSequenceFields(incoming: Batch, existing: Batch | undefined): Batch {
  if (!existing) return incoming;
  return {
    ...incoming,
    ...(incoming.sequenceId === undefined && existing.sequenceId !== undefined ? { sequenceId: existing.sequenceId } : {}),
    ...(incoming.sequenceIndex === undefined && existing.sequenceIndex !== undefined ? { sequenceIndex: existing.sequenceIndex } : {}),
    ...(incoming.sequence === undefined && existing.sequence !== undefined ? { sequence: existing.sequence } : {}),
  };
}

export function upsertNewBatch(queryClient: QueryClient, key: QueryKey, batch: Batch): void {
  setHistory(queryClient, key, (data) => upsertHistoryBatch(data, batch));
}

/** Canonical page placement shared by streamed and discovered story batches. */
export function upsertHistoryBatch(data: HistoryData, batch: Batch): HistoryData {
  // Place delayed arrivals on their canonical page, without encoding SSE
  // delivery order or changing cursor coverage.
  let removedLoadingCount = 0;
  let existingBatch: Batch | undefined;
  const cleaned = data.pages.map((page) => {
    const filtered = page.items.filter((existing) => {
      if (existing.id !== batch.id) return true;
      existingBatch = existing;
      removedLoadingCount += loadingCountForBatch(existing);
      return false;
    });
    if (filtered.length === page.items.length) return page;
    return tagPage(page, filtered);
  });
  const anyPageChanged = cleaned.some((page, idx) => page !== data.pages[idx]);
  const sourcePages = anyPageChanged ? cleaned : data.pages;
  const nextBatch = preserveSequenceFields(batch, existingBatch);
  const target = sourcePages.findIndex((page) => {
    const last = page.items.at(-1);
    return last === undefined || sortsBefore(nextBatch, last);
  });
  const pageIndex = target === -1 ? Math.max(0, sourcePages.length - 1) : target;
  const page = sourcePages[pageIndex] ?? { items: [], nextCursor: null };
  const pages = sourcePages.slice();
  pages[pageIndex] = tagPage(page, insertCanonical(page.items, nextBatch));
  const next = { ...data, pages };
  return withLoadingCount(next, loadingCountForData(data) - removedLoadingCount + loadingCountForBatch(nextBatch));
}

export function updateBatchTile(
  queryClient: QueryClient,
  key: QueryKey,
  batchId: string,
  tile: Tile,
): void {
  setHistory(queryClient, key, (data) => {
    const idx = findPageIndex(data, batchId);
    if (idx === -1) return data;
    const page = data.pages[idx];
    if (!page) return data;
    let loadingDelta = 0;
    const items = page.items.map((batch) =>
      batch.id !== batchId
        ? batch
        : {
            ...batch,
            tiles: batch.tiles.map((existing) =>
              {
                if (existing.id !== tile.id) return existing;
                const nextTile = { ...tile, seed: existing.seed, ...(existing.refImageIds ? { refImageIds: existing.refImageIds } : {}) };
                loadingDelta += loadingCountForTile(nextTile) - loadingCountForTile(existing);
                return nextTile;
              }),
          },
    );
    return setPage(data, idx, items, loadingDelta);
  });
}

export function updateBatchStatus(
  queryClient: QueryClient,
  key: QueryKey,
  batchId: string,
  patch: Pick<Batch, 'status'> & Partial<Pick<Batch, 'queueLengthAhead' | 'startedAt'>>,
): void {
  setHistory(queryClient, key, (data) => {
    const idx = findPageIndex(data, batchId);
    if (idx === -1) return data;
    const page = data.pages[idx];
    if (!page) return data;
    const items = page.items.map((batch) => {
      if (batch.id !== batchId) return batch;
      const { queueLengthAhead: _oldQueueLengthAhead, ...rest } = batch;
      return {
        ...rest,
        status: patch.status,
        ...(patch.queueLengthAhead === undefined ? {} : { queueLengthAhead: patch.queueLengthAhead }),
        ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
      };
    });
    return setPage(data, idx, items);
  });
}

export function removeBatchFromCache(
  queryClient: QueryClient,
  key: QueryKey,
  batchId: string,
): void {
  setHistory(queryClient, key, (data) => {
    const idx = findPageIndex(data, batchId);
    if (idx === -1) return data;
    const page = data.pages[idx];
    if (!page) return data;
    const removed = page.items.find((batch) => batch.id === batchId);
    return setPage(
      data,
      idx,
      page.items.filter((batch) => batch.id !== batchId),
      -(removed ? loadingCountForBatch(removed) : 0),
    );
  });
}

export function removeTileFromCache(
  queryClient: QueryClient,
  key: QueryKey,
  batchId: string,
  tileId: string,
): void {
  setHistory(queryClient, key, (data) => {
    const idx = findPageIndex(data, batchId);
    if (idx === -1) return data;
    const page = data.pages[idx];
    if (!page) return data;
    let removedLoadingCount = 0;
    const items = page.items.flatMap((batch) => {
      if (batch.id !== batchId) return [batch];
      const tiles = batch.tiles.filter((tile) => {
        if (tile.id !== tileId) return true;
        removedLoadingCount += loadingCountForTile(tile);
        return false;
      });
      return tiles.length > 0 ? [{ ...batch, tiles }] : [];
    });
    return setPage(data, idx, items, -removedLoadingCount);
  });
}
