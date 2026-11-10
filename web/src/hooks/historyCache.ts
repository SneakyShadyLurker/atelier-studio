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

/** Loading tiles a cached scope holds, from its tags when present. */
export function historyLoadingTileCount(data: HistoryData): number {
  return loadingCountForData(data);
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
  return withTaggedPages(data, data.pages.map((page) => tagPage(page, page.items)));
}

/** A page with new `items`, tagged like every other write; untouched pages keep their identity. */
export function tagHistoryPageItems(page: HistoryPageWithLoading, items: readonly Batch[]): HistoryPageWithLoading {
  return tagPage(page, items);
}

/** `data` over already-tagged `pages`, with the totals recomputed. */
export function withTaggedPages(data: HistoryData, pages: HistoryPageWithLoading[]): HistoryData {
  const loadingTileCount = pages.reduce((count, page) => count + (page.loadingTileCount ?? loadingCountForBatches(page.items)), 0);
  return { ...data, pages, loadingTileCount, activeByModel: activeByModelFromPages(pages) };
}

type TerminalTile = Exclude<Tile, { status: 'loading' }>;

// Confirmed cancellations, per page session: tile id -> confirmation time. A
// history response read before the cancel committed would otherwise bring the
// cancelled tile back. Written only once the server confirmed the cancel (an
// SSE `canceled` terminal or a successful cancel DELETE).
//
// A loading copy is filtered for five minutes: a cancelled tile never loads
// again, and the entry outlives any request by far. A finished copy is
// filtered only for one minute, long enough for a read that sampled the tile
// between its completion and the cancel's DELETE to land. After that a
// finished copy is real: the cancel raced the tile's completion, the server
// archived it, and a restore (from this tab, which also forgets the entry at
// once, or from another) brought it back.
export const CANCEL_TOMBSTONE_TTL_MS = 5 * 60_000;
export const CANCEL_TOMBSTONE_FINISHED_MS = 60_000;
const cancelTombstones = new Map<string, number>();

function tombstoneLive(tile: Tile, now: number): boolean {
  const confirmedAt = cancelTombstones.get(tile.id);
  if (confirmedAt === undefined) return false;
  return now - confirmedAt < (tile.status === 'loading' ? CANCEL_TOMBSTONE_TTL_MS : CANCEL_TOMBSTONE_FINISHED_MS);
}

/** Records server-confirmed cancellations so no older history read shows those tiles again. */
export function tombstoneCanceledTiles(tileIds: Iterable<string>, confirmedAt = Date.now()): void {
  const now = Date.now();
  for (const [tileId, at] of cancelTombstones) {
    if (now - at >= CANCEL_TOMBSTONE_TTL_MS) cancelTombstones.delete(tileId);
  }
  for (const tileId of tileIds) cancelTombstones.set(tileId, confirmedAt);
}

/**
 * Forgets cancellations for tiles the server handed back. A cancel that raced
 * the tile's completion archives the finished tile instead of cancelling it;
 * restoring it from the Archive must show it again at once.
 */
export function forgetCanceledTiles(tileIds: Iterable<string>): void {
  for (const tileId of tileIds) cancelTombstones.delete(tileId);
}

export function resetCancelTombstones(): void {
  cancelTombstones.clear();
}

function hasTombstonedTile(data: HistoryData, now: number): boolean {
  if (cancelTombstones.size === 0) return false;
  for (const page of data.pages) {
    for (const batch of page.items) {
      for (const tile of batch.tiles) if (tombstoneLive(tile, now)) return true;
    }
  }
  return false;
}

// True when the flattened pages are strictly in canonical order, which also
// rules out duplicate ids (a duplicate compares equal). No allocation.
function strictlyCanonical(data: HistoryData): boolean {
  let prior: Batch | undefined;
  for (const page of data.pages) {
    for (const batch of page.items) {
      if (prior !== undefined && !sortsBefore(prior, batch)) return false;
      prior = batch;
    }
  }
  return true;
}

function terminalRegresses(incoming: Tile, known: Tile): boolean {
  return known.status !== 'loading' && (incoming.status === 'loading' || known.completedAt > incoming.completedAt);
}

// Whether any incoming tile is older than the same tile in `previous`. Both
// sides are strictly canonical here, so one merge walk pairs each batch with
// its previous copy without building an index.
function regressesAgainst(data: HistoryData, previous: HistoryData): boolean {
  let pageIndex = 0;
  let itemIndex = 0;
  const peek = (): Batch | undefined => {
    while (pageIndex < previous.pages.length) {
      const items = previous.pages[pageIndex]?.items ?? [];
      if (itemIndex < items.length) return items[itemIndex];
      pageIndex += 1;
      itemIndex = 0;
    }
    return undefined;
  };
  for (const page of data.pages) {
    for (const batch of page.items) {
      let before = peek();
      while (before !== undefined && sortsBefore(before, batch)) {
        itemIndex += 1;
        before = peek();
      }
      if (before === undefined) return false;
      if (before.id !== batch.id || before === batch) continue;
      for (const tile of batch.tiles) {
        for (const known of before.tiles) {
          if (known.id === tile.id && terminalRegresses(tile, known)) return true;
        }
      }
    }
  }
  return false;
}

// Rows outside the longest canonical run (complement of the longest
// increasing subsequence in canonical order): the fewest rows to re-place.
function misplacedRows(rows: readonly Batch[]): Set<Batch> {
  const tails: number[] = [];
  const parent = Array.from({ length: rows.length }, () => -1);
  rows.forEach((row, index) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const tail = rows[tails[mid] ?? 0];
      if (tail !== undefined && sortsBefore(tail, row)) lo = mid + 1;
      else hi = mid;
    }
    parent[index] = lo > 0 ? tails[lo - 1] ?? -1 : -1;
    tails[lo] = index;
  });
  const kept = new Set<number>();
  for (let index = tails.at(-1) ?? -1; index !== -1; index = parent[index] ?? -1) kept.add(index);
  return new Set(rows.filter((_, index) => !kept.has(index)));
}

/**
 * Normalizes every history write at Query's structural-sharing boundary, so
 * writers and readers see the same cache rather than hiding fixes in the view.
 *
 * - A delayed optimistic batch may sit beyond a fetched page's cursor. When a
 *   later page reaches it, keep the later page's row and authoritative
 *   payload; its server page also puts intervening rows back in canonical
 *   order. Cursor/pageParam coverage stays intact.
 * - Rows still out of canonical order across page boundaries (a late arrival
 *   parked on the last page before a page of newer rows was appended) move
 *   with `upsertHistoryBatch`'s placement rule: the first page whose last
 *   row they sort before, else the last page.
 * - Tiles only move loading -> terminal. A fetch read before an SSE terminal
 *   landed must not flip a finished tile back to a spinner (or to an older
 *   terminal), so the newest terminal seen for a tile wins. Tile membership
 *   and page placement still come from the incoming data.
 * - A tile whose cancellation the server confirmed stays gone (see
 *   `tombstoneCanceledTiles`); a batch left with no tiles by that goes too.
 *
 * Returns `data` itself, allocating nothing, when there is nothing to fix.
 */
export function reconcileHistoryPages(data: HistoryData, previous?: HistoryData): HistoryData {
  const now = Date.now();
  const ordered = strictlyCanonical(data);
  if (ordered && !hasTombstonedTile(data, now)) {
    if (previous === undefined) return data;
    if (strictlyCanonical(previous) && !regressesAgainst(data, previous)) return data;
  }
  return normalizeHistoryPages(data, previous, now);
}

function normalizeHistoryPages(data: HistoryData, previous: HistoryData | undefined, now: number): HistoryData {
  const latest = new Map<string, Batch>();
  for (const page of data.pages) {
    for (const batch of page.items) latest.set(batch.id, batch);
  }
  const terminals = new Map<string, Map<string, TerminalTile>>();
  const remember = (batch: Batch) => {
    for (const tile of batch.tiles) {
      if (tile.status === 'loading') continue;
      let known = terminals.get(batch.id);
      if (!known) terminals.set(batch.id, (known = new Map<string, TerminalTile>()));
      const existing = known.get(tile.id);
      if (!existing || tile.completedAt >= existing.completedAt) known.set(tile.id, tile);
    }
  };
  for (const page of previous?.pages ?? []) for (const batch of page.items) remember(batch);
  for (const page of data.pages) for (const batch of page.items) remember(batch);
  const newerTerminal = (batchId: string, tile: Tile): TerminalTile | undefined => {
    const terminal = terminals.get(batchId)?.get(tile.id);
    return terminal && terminalRegresses(tile, terminal) ? terminal : undefined;
  };
  const seen = new Set<string>();
  const deduped = data.pages.toReversed().map((page) => {
    const items = page.items.flatMap((batch) => {
      if (seen.has(batch.id)) return [];
      seen.add(batch.id);
      const incoming = latest.get(batch.id) ?? batch;
      const tiles = incoming.tiles
        .filter((tile) => !tombstoneLive(tile, now))
        .map((tile) => newerTerminal(batch.id, tile) ?? tile);
      if (tiles.length === incoming.tiles.length && tiles.every((tile, index) => tile === incoming.tiles[index])) return [incoming];
      // Every tile of the batch was a confirmed cancellation: the batch goes.
      if (tiles.length === 0 && incoming.tiles.length > 0) return [];
      const status: Batch['status'] = tiles.length > 0 && tiles.every((tile) => tile.status !== 'loading') ? 'done' : incoming.status;
      return [{ ...incoming, tiles, status }];
    });
    const same = items.length === page.items.length && items.every((batch, index) => batch === page.items[index]);
    return same ? page : { ...page, items };
  }).reverse();
  const changed = deduped.some((page, index) => page !== data.pages[index]);
  const flat = deduped.flatMap((page) => page.items);
  const misplaced = misplacedRows(flat);
  if (misplaced.size === 0) {
    return changed ? retagHistoryData({ ...data, pages: deduped }) : data;
  }
  const pages = deduped.map((page) => (page.items.some((batch) => misplaced.has(batch))
    ? { ...page, items: page.items.filter((batch) => !misplaced.has(batch)) }
    : page));
  for (const batch of flat) {
    if (!misplaced.has(batch)) continue;
    const target = pages.findIndex((page) => {
      const last = page.items.at(-1);
      return last !== undefined && sortsBefore(batch, last);
    });
    const index = target === -1 ? Math.max(0, pages.length - 1) : target;
    const page = pages[index];
    if (page) pages[index] = { ...page, items: insertCanonical(page.items, batch) };
  }
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

// Every optimistic history write goes through here. Two things a plain
// `setQueryData` would get wrong:
//   - Only the insert may create a missing cache. A tile, status or removal
//     write for a key that holds no data (collected after five minutes away
//     from the feed, or removed by Clear all) must not synthesize an empty,
//     end-of-history page that later reads as fresh.
//   - Freshness and invalidation belong to server reads. `setQueryData` marks
//     the query fresh and clears `isInvalidated`; a stream writing Unsorted
//     every few seconds would otherwise keep an inactive scope "fresh" for the
//     whole burst and swallow the invalidation a settled write left on it, so
//     the user returns to stale rows. Keep the last server read's clock and
//     re-mark the invalidation after the write.
function setHistory(
  queryClient: QueryClient,
  key: QueryKey,
  mutate: (current: HistoryData) => HistoryData,
  { create = false }: { create?: boolean } = {},
): void {
  const query = queryClient.getQueryCache().find<HistoryData>({ queryKey: key, exact: true });
  if (!query) {
    if (create) queryClient.setQueryData<HistoryData>(key, mutate(emptyHistory()));
    return;
  }
  if (!create && query.state.data === undefined) return;
  const wasInvalidated = query.state.isInvalidated;
  const updatedAt = query.state.dataUpdatedAt;
  queryClient.setQueryData<HistoryData>(
    key,
    (current) => mutate(current ?? emptyHistory()),
    updatedAt > 0 ? { updatedAt } : undefined,
  );
  if (wasInvalidated) query.invalidate();
}

/**
 * An optimistic write to one cached scope that keeps the scope's server-read
 * clock and pending invalidation (above); a no-op when the scope has no cache.
 */
export function writeHistoryScope(
  queryClient: QueryClient,
  key: QueryKey,
  mutate: (current: HistoryData) => HistoryData,
): void {
  setHistory(queryClient, key, mutate);
}

/** Every cached history scope (under `rootKey`) whose data holds `batchId`. */
export function historyScopesWithBatch(queryClient: QueryClient, rootKey: QueryKey, batchId: string): QueryKey[] {
  return queryClient.getQueryCache().findAll({ queryKey: rootKey })
    .filter((query) => {
      const data = query.state.data as HistoryData | undefined;
      return data !== undefined && findPageIndex(data, batchId) !== -1;
    })
    .map((query) => query.queryKey);
}

/** The tile as the first cached scope under `rootKey` holding its batch sees it. */
export function findTileInAnyScope(queryClient: QueryClient, rootKey: QueryKey, batchId: string, tileId: string): Tile | undefined {
  for (const key of historyScopesWithBatch(queryClient, rootKey, batchId)) {
    const tile = findTileInCache(queryClient, key, batchId, tileId);
    if (tile) return tile;
  }
  return undefined;
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
  return items.toSpliced(insertAt === -1 ? items.length : insertAt, 0, batch);
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
  setHistory(queryClient, key, (data) => upsertHistoryBatch(data, batch), { create: true });
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
  // An emptied page (every row deleted) carries no position: skip it, or an
  // older late arrival would land ahead of the newer rows on later pages.
  const target = sourcePages.findIndex((page) => {
    const last = page.items.at(-1);
    return last !== undefined && sortsBefore(nextBatch, last);
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
