import type { Batch, HistoryPage } from '@atelier/shared';
import { infiniteQueryOptions, keepPreviousData, replaceEqualDeep, type InfiniteData } from '@tanstack/react-query';
import { ApiError, apiImageUrl, isBatchHistoryPage, requestJson, requestJsonValidated, requestNoContent } from './client';
import type { AppView } from '../store/atelier';
import { heldUploadIds, useAtelierStore } from '../store/atelier';
import { activeByModelFromBatches, activeByModelFromPages } from '../lib/historyAggregation';
import type { HistoryData, HistoryPageWithLoading, LoadingBatchTag } from '../hooks/historyCache';
import { reconcileHistoryPages } from '../hooks/historyCache';

export type { ActiveModelCounts } from '../lib/historyAggregation';

const STUCK_LOADING_POLL_CAP_MS = 30 * 60_000;
const MAX_LOADING_TRACKED_BATCHES = 500;
const firstSeenLoadingAt = new Map<string, number>();
const stuckToastBatchIds = new Set<string>();

export type { HistoryData, HistoryPageWithLoading } from '../hooks/historyCache';

function isLoadingBatchTags(value: unknown): value is readonly LoadingBatchTag[] {
  return Array.isArray(value)
    && value.every((item: unknown) => (
      typeof item === 'object'
      && item !== null
      && typeof (item as LoadingBatchTag).batchId === 'string'
      && (typeof (item as LoadingBatchTag).startedAt === 'number' || (item as LoadingBatchTag).startedAt === null)
    ));
}

function evictOldestMapEntry<TKey, TValue>(map: Map<TKey, TValue>, maxEntries: number): void {
  if (map.size <= maxEntries) return;
  const oldestKey = map.keys().next().value;
  if (oldestKey !== undefined) map.delete(oldestKey);
}

function evictOldestSetEntry<TValue>(set: Set<TValue>, maxEntries: number): void {
  if (set.size <= maxEntries) return;
  const oldestKey = set.keys().next().value;
  if (oldestKey !== undefined) set.delete(oldestKey);
}

function markFirstSeenLoading(batchId: string): number {
  const existing = firstSeenLoadingAt.get(batchId);
  if (existing !== undefined) return existing;
  const now = Date.now();
  stuckToastBatchIds.delete(batchId);
  firstSeenLoadingAt.set(batchId, now);
  evictOldestMapEntry(firstSeenLoadingAt, MAX_LOADING_TRACKED_BATCHES);
  return now;
}

function clearFirstSeenLoading(batchId: string): void {
  firstSeenLoadingAt.delete(batchId);
}

function markStuckToastShown(batchId: string): boolean {
  if (stuckToastBatchIds.has(batchId)) return false;
  stuckToastBatchIds.add(batchId);
  evictOldestSetEntry(stuckToastBatchIds, MAX_LOADING_TRACKED_BATCHES);
  return true;
}

function clearStuckToastDedupe(batchId: string): void {
  stuckToastBatchIds.delete(batchId);
}

export const __resetFirstSeenLoadingForTest = (): void => {
  firstSeenLoadingAt.clear();
};

export const __resetStuckToastDedupeForTest = (): void => {
  stuckToastBatchIds.clear();
};

export const historyKeys = {
  all: () => ['history'] as const,
  scoped: (view: AppView, q: string) => [...historyKeys.all(), { view, q }] as const,
  // The single specific scope SSE writes target and the persister whitelists:
  // default Unsorted feed, empty search. NOT broad — use all() to invalidate
  // every scoped variant.
  list: () => historyKeys.scoped({ kind: 'unsorted' }, ''),
};

// Single source of truth for "is this the persisted default scope key". The
// persister deserializes keys from IndexedDB as untyped arrays, so it cannot
// reuse the factory directly — this predicate is the one place the shape of
// historyKeys.list() is asserted structurally.
export function isDefaultHistoryScopeKey(key: readonly unknown[]): boolean {
  if (key[0] !== 'history') return false;
  const scope = key[1];
  if (typeof scope !== 'object' || scope === null) return false;
  const { view, q } = scope as { view?: unknown; q?: unknown };
  if (q !== '') return false;
  return typeof view === 'object' && view !== null && (view as { kind?: unknown }).kind === 'unsorted';
}

export const historyOpts = (view: AppView = { kind: 'unsorted' }, q = '', enabled = true) =>
  infiniteQueryOptions({
    queryKey: historyKeys.scoped(view, q),
    queryFn: ({ pageParam, signal }) => fetchHistoryPage(pageParam, 30, view, q, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: tagHistoryData,
    structuralSharing: (previous, incoming) => replaceEqualDeep(previous, reconcileHistoryPages(incoming as HistoryData, previous as HistoryData | undefined)),
    enabled,
    // Hold the previous scope's results visible while a new scope/search key
    // fetches, instead of blanking to a spinner. Display-only for the new key
    // until its first fetch resolves; the SSE optimistic-write path targets
    // the live scoped key and is unaffected. Surface via isPlaceholderData to
    // dim the stale grid.
    placeholderData: keepPreviousData,
    // Per per-query staleTime convention in `code_style.md`: list is server-
    // authoritative on mutate (surgical setQueryData updates), 30s focus
    // refetch is the right tier.
    staleTime: 30_000,
    // v3 spec: poll while any loading tile exists. SSE is the real-time
    // path; this polling is the fallback for connection drops. Stops
    // automatically once every tile is terminal. Background tabs are
    // paused by default — they converge on focus.
    //
    // Adaptive cadence: start at 3s while events are arriving, back off
    // toward 30s if no new tile event lands in the polling window. The
    // stuck-toast cap (STUCK_LOADING_POLL_CAP_MS) is a separate concern —
    // it suppresses the poll for genuinely-stuck batches.
    //
    // Side effects (pendingStory expiry, stuck toast) live here on purpose:
    // stuck detection is time-driven, and a poll returning structurally
    // identical data does not re-render, so an effect keyed on the data would
    // miss the threshold crossing. Both are idempotent (expiry flips the
    // decision to 'none'; markStuckToastShown dedupes), which matters because
    // TanStack calls this on every cache/options update, not once per poll.
    refetchInterval: (query) => {
      const data = query.state.data as HistoryData | undefined;
      const pages = data?.pages ?? [];
      const store = useAtelierStore.getState();
      const pendingStoryDecision = pendingStoryPollDecision(pages, store.pendingStory, Date.now());
      if (pendingStoryDecision === 'clear') store.setPendingStory(null);
      const pendingStory = pendingStoryDecision === 'poll';
      if (query.state.fetchFailureCount > 3 && !pendingStory) return false;
      // No page-count gate: a loading tile hydrated from cache or a later page
      // may have no live SSE subscription, so this poll is its only path to a
      // terminal state. TanStack refetches the cached pages sequentially, and
      // the stall backoff below bounds the cost of a deep cache.
      const stitching = hasStitchingSequence(pages);
      const activeStory = hasActiveStory(pages);
      const loadingState = loadingStateFromTaggedPages(pages);
      if (loadingState.loadingTileCount === 0 && !stitching && !activeStory && !pendingStory) return false;
      const now = Date.now();
      let hasFreshLoadingBatch = loadingState.loadingBatches.length === 0;
      for (const batch of loadingState.loadingBatches) {
        // A queued batch is waiting its turn, not stuck: however long the
        // queue, it keeps polling so its dispatch and completion land.
        if (batch.startedAt !== null && now - batch.startedAt > STUCK_LOADING_POLL_CAP_MS) {
          if (markStuckToastShown(batch.batchId)) {
            useAtelierStore.getState().addToast('Generation seems stuck — refresh to retry.', 'soft', 6000);
          }
        } else {
          hasFreshLoadingBatch = true;
        }
      }
      if (!hasFreshLoadingBatch && !pendingStory) return false;
      if (pendingStory) return 3_000;
      // stallMs = "time since the most recent meaningful progress on any
      // loading batch". Uses tile.completedAt (or batch.createdAt as the
      // baseline) — NOT query.state.dataUpdatedAt, which is bumped by every
      // optimistic SSE setQueryData write and would keep the clock pegged
      // at zero so the backoff tiers never fired.
      // Note: TanStack recomputes refetchInterval on every cache update and
      // every observer setOptions (each render of a useHistory consumer), not
      // once per poll; the walks are cheap at the 5-page persisted depth.
      const mostRecentProgressAt = mostRecentProgressFromPages(pages);
      const stallMs = mostRecentProgressAt > 0 ? now - mostRecentProgressAt : 0;
      if (stallMs > 60_000) return 30_000;
      if (stallMs > 20_000) return 10_000;
      return 3_000;
    },
    retry: (failureCount, error) => {
      if (error instanceof ApiError && !error.retryable) return false;
      return failureCount < 2;
    },
  });

function hasStitchingSequence(pages: readonly HistoryPage<Batch>[]): boolean {
  return pages.some((page) => page.items.some((batch) => batch.sequence?.masterStatus === 'stitching'));
}

export function hasActiveStory(pages: readonly HistoryPage<Batch>[]): boolean {
  return pages.some((page) => page.items.some((batch) => batch.story?.status === 'rendering'));
}

export function pendingStoryPollDecision(
  pages: readonly HistoryPage<Batch>[],
  pendingStory: { readonly id: string; readonly until: number } | null,
  now: number,
): 'poll' | 'clear' | 'none' {
  if (pendingStory === null) return 'none';
  if (
    now >= pendingStory.until
    || pages.some((page) => page.items.some((batch) => batch.story?.id === pendingStory.id))
  ) {
    return 'clear';
  }
  return 'poll';
}

function loadingStateFromPages(pages: readonly HistoryPage<Batch>[]): {
  loadingTileCount: number;
  loadingBatches: readonly LoadingBatchTag[];
} {
  let loadingTileCount = 0;
  const loadingBatches: LoadingBatchTag[] = [];
  for (const page of pages) {
    for (const batch of page.items) {
      const batchLoadingCount = countLoadingTilesInBatches([batch]);
      if (batchLoadingCount === 0) {
        clearFirstSeenLoading(batch.id);
        clearStuckToastDedupe(batch.id);
        continue;
      }
      loadingTileCount += batchLoadingCount;
      // The stuck clock starts when rendering does: queue wait never counts.
      if (batch.status === 'queued') clearFirstSeenLoading(batch.id);
      loadingBatches.push({
        batchId: batch.id,
        startedAt: batch.status === 'queued' ? null : markFirstSeenLoading(batch.id),
      });
    }
  }
  return { loadingTileCount, loadingBatches };
}

// Stall signal for the adaptive refetchInterval, kept out of the `select`
// path. refetchInterval itself is recomputed on every cache update and
// observer options update, so this is not a once-per-poll walk. Returns the most recent
// tile.completedAt across batches with any loading tile, falling back to
// batch.startedAt (or createdAt) when no tile has completed yet.
// Using query.state.dataUpdatedAt as the stall signal — the previous
// approach — was wrong because optimistic SSE writes bump dataUpdatedAt
// every event, keeping stallMs pegged at 0 so the backoff tiers never fire.
function mostRecentProgressFromPages(pages: readonly HistoryPage<Batch>[]): number {
  let mostRecentProgressAt = 0;
  for (const page of pages) {
    for (const batch of page.items) {
      let hasLoading = false;
      for (const tile of batch.tiles) {
        if (tile.status === 'loading') { hasLoading = true; break; }
      }
      const stitching = batch.sequence?.masterStatus === 'stitching';
      if (!hasLoading && !stitching) continue;
      // Dispatch, not creation, is the baseline: queue wait is not a stall.
      const sequenceProgress = batch.sequence?.masterUpdatedAt ?? batch.startedAt ?? batch.createdAt;
      if (sequenceProgress > mostRecentProgressAt) mostRecentProgressAt = sequenceProgress;
      for (const tile of batch.tiles) {
        if ((tile.status === 'done' || tile.status === 'failed') && tile.completedAt > mostRecentProgressAt) {
          mostRecentProgressAt = tile.completedAt;
        }
      }
    }
  }
  return mostRecentProgressAt;
}

function countLoadingTilesInBatches(batches: readonly Batch[]): number {
  let count = 0;
  for (const batch of batches) {
    for (const tile of batch.tiles) {
      if (tile.status === 'loading') count += 1;
    }
  }
  return count;
}

function loadingStateFromTaggedPages(pages: readonly HistoryPageWithLoading[]): {
  loadingTileCount: number;
  loadingBatches: readonly LoadingBatchTag[];
} {
  let loadingTileCount = 0;
  const loadingBatches: LoadingBatchTag[] = [];
  for (const page of pages) {
    if (typeof page.loadingTileCount !== 'number') {
      return loadingStateFromPages(pages);
    }
    if (page.loadingTileCount > 0 && (!isLoadingBatchTags(page.loadingBatches) || page.loadingBatches.length === 0)) {
      const recomputed = loadingStateFromPages([page]);
      loadingTileCount += recomputed.loadingTileCount;
      loadingBatches.push(...recomputed.loadingBatches);
      continue;
    }
    loadingTileCount += page.loadingTileCount;
    if (isLoadingBatchTags(page.loadingBatches)) loadingBatches.push(...page.loadingBatches);
  }
  return { loadingTileCount, loadingBatches };
}

// Identity-keyed memo: TanStack re-invokes `select` on every `data` reference
// change. The write paths in `historyCache.ts` already tag pages with
// `loadingTileCount` / `loadingBatches`, so the per-page short-circuit in
// `loadingStateFromTaggedPages` is the hot path. Cache by `data` identity so
// repeated `select` calls with the same `data` object skip the page map walk
// entirely. WeakMap so stale data objects GC naturally.
const taggedHistoryCache = new WeakMap<InfiniteData<HistoryPage<Batch>>, HistoryData>();

function tagHistoryData(data: InfiniteData<HistoryPage<Batch>>): HistoryData {
  const cached = taggedHistoryCache.get(data);
  if (cached) return cached;
  const pages = data.pages.map(tagHistoryPage);
  const tagged = {
    ...data,
    pages,
    loadingTileCount: loadingStateFromTaggedPages(pages).loadingTileCount,
    activeByModel: activeByModelFromPages(pages),
  };
  taggedHistoryCache.set(data, tagged);
  return tagged;
}

function tagHistoryPage(page: HistoryPage<Batch>): HistoryPageWithLoading {
  const { loadingTileCount, loadingBatches } = loadingStateFromPages([page]);
  return {
    ...page,
    loadingTileCount,
    hasLoadingTiles: loadingTileCount > 0,
    loadingBatches,
    activeByModel: activeByModelFromBatches(page.items),
  };
}

function normalizeBatch(batch: Batch): Batch {
  return {
    ...batch,
    tiles: batch.tiles.map((tile) => (
      tile.status === 'done'
        ? {
            ...tile,
            url: apiImageUrl(tile.url),
            ...(tile.thumbUrl ? { thumbUrl: apiImageUrl(tile.thumbUrl) } : {}),
          }
        : tile
    )),
  };
}

// Maps a history AppView scope onto the wire query params shared by the
// GET and DELETE /history endpoints — one place to extend when a new
// AppView kind is added.
function applyHistoryScopeParams(params: URLSearchParams, view: AppView): void {
  if (view.kind === 'pinned') params.set('pinned', 'true');
  if (view.kind === 'unsorted') params.set('collectionId', 'null');
  if (view.kind === 'collection') params.set('collectionId', view.id);
}

export function fetchHistoryPage(
  cursor: string | null | undefined,
  limit = 30,
  view: AppView = { kind: 'unsorted' },
  q = '',
  init: RequestInit = {},
): Promise<HistoryPageWithLoading> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  applyHistoryScopeParams(params, view);
  const trimmedQ = q.trim();
  if (trimmedQ) params.set('q', trimmedQ);
  return requestJsonValidated(`/history?${params.toString()}`, init, isBatchHistoryPage).then((page) =>
    tagHistoryPage({
      ...page,
      items: page.items.map(normalizeBatch),
    })
  );
}

export interface PatchBatchInput {
  collectionId?: string | null;
  pinned?: boolean;
}

export function patchBatch(batchId: string, patch: PatchBatchInput): Promise<Batch> {
  return requestJson<Batch>(`/history/${batchId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(normalizeBatch);
}

export function clearHistory(view: AppView = { kind: 'unsorted' }): Promise<void> {
  const params = new URLSearchParams();
  applyHistoryScopeParams(params, view);
  return deleteKeepingUploads('/history', params);
}

export function deleteBatch(batchId: string): Promise<void> {
  return deleteKeepingUploads(`/history/${batchId}`);
}

export function deleteTile(batchId: string, tileId: string): Promise<void> {
  return deleteKeepingUploads(`/history/${batchId}/${tileId}`);
}

// The server's `?keepUploads=` query cap. Larger hold sets travel as a JSON
// body instead, so the URL stays small and no hold is ever dropped; the server
// enforces MAX_DELETE_KEEP_UPLOADS on the merged set.
const MAX_QUERY_KEEP_UPLOADS = 64;

/** A thread DELETE that sends every held upload (`heldUploadIds`) as `keepUploads`. */
export function deleteKeepingUploads(path: string, params = new URLSearchParams()): Promise<void> {
  const held = heldUploadIds();
  const init: RequestInit = { method: 'DELETE' };
  if (held.length > MAX_QUERY_KEEP_UPLOADS) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify({ keepUploads: held });
  } else if (held.length > 0) {
    params.set('keepUploads', held.join(','));
  }
  const search = params.toString();
  return requestNoContent(search ? `${path}?${search}` : path, init);
}
