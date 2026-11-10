import type { Batch, Tile } from '@atelier/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { historyKeys, patchBatch, type PatchBatchInput } from '../api/history';
import { APP_VIEW_UNSORTED, useAtelierStore, type AppView } from '../store/atelier';
import { historyScopesWithBatch, retagHistoryData, tagHistoryPageItems, upsertHistoryBatch, withTaggedPages, writeHistoryScope, type HistoryData } from './historyCache';
import { invalidateLibrary } from './invalidateLibrary';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

export type { HistoryData } from './historyCache';

export interface ActiveScope {
  activeView: AppView;
  q: string;
}

// Single source of truth for "which scoped history query is the user acting
// on". Used by every optimistic mutation hook and the SSE cache guards so the
// cache write/read always targets the scope the user actually sees — not a
// hardcoded historyKeys.list(). Cross-scope convergence is the caller's broad
// historyKeys.all() invalidate on settle.
export function activeScopeKey(scope: Partial<ActiveScope>): QueryKey {
  return historyKeys.scoped(scope.activeView ?? APP_VIEW_UNSORTED, scope.q ?? '');
}

// Store-derived variant for leaf consumers (LoadingTile cancel guard) that
// can't be threaded a scope prop. Reads the live store view/q; the brief
// useDeferredValue lag vs the visible query key is covered by the broad
// invalidate-on-settle contract.
export function liveActiveScopeKey(): QueryKey {
  const state = useAtelierStore.getState();
  return historyKeys.scoped(state.view, state.q);
}

export interface ScopedRollback {
  activeKey: QueryKey;
  previous: HistoryData | undefined;
}

export interface ScopeSnapshot {
  readonly key: QueryKey;
  readonly previous: HistoryData | undefined;
}

/** What one optimistic history write changed, so a failure can undo exactly that. */
export type MirrorChange =
  | { readonly kind: 'removeBatch' }
  | { readonly kind: 'removeTile'; readonly tileId: string }
  | { readonly kind: 'patch'; readonly patch: Partial<Pick<Batch, 'collectionId' | 'pinned'>> };

export interface CanonicalMirror {
  activeKey: QueryKey;
  previous: HistoryData | undefined;
  batchId: string;
  change: MirrorChange;
  /** Every cached history scope the write must touch: the active one first, then each other scope holding the batch. */
  keys: readonly QueryKey[];
  snapshots: readonly ScopeSnapshot[];
}

// Begin an optimistic write against every cached history scope that shows the
// batch: the scope the user acts in, plus any other scope (the canonical
// Unsorted feed the SSE stream writes, Pinned, a collection, a search) that
// also holds the row. Cancels in-flight refetches on each and snapshots each
// for rollback. It deliberately does NOT remove anything: the caller applies
// its entity-specific removal (tile vs batch) to every key in `keys`,
// preserving each hook's exact pre/post-removal ordering (e.g. useDeleteBatch's
// preview-id snapshot between cancel and removal). Writing every scope keeps
// a revisit from first painting the archived row out of its cache.
export async function beginCanonicalMirror(
  queryClient: QueryClient,
  activeKey: QueryKey,
  batchId: string,
  change: MirrorChange,
): Promise<CanonicalMirror> {
  const keys = [activeKey, ...historyScopesWithBatch(queryClient, historyKeys.all(), batchId).filter((key) => !sameKey(key, activeKey))];
  await Promise.all(keys.map((key) => queryClient.cancelQueries({ queryKey: key, exact: true })));
  const snapshots = keys.map((key) => ({ key, previous: queryClient.getQueryData<HistoryData>(key) }));
  return { activeKey, previous: snapshots[0]?.previous, batchId, change, keys, snapshots };
}

function sameKey(a: QueryKey, b: QueryKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function findRow(data: HistoryData, batchId: string): Batch | undefined {
  for (const page of data.pages) {
    const found = page.items.find((batch) => batch.id === batchId);
    if (found) return found;
  }
  return undefined;
}

function mapRow(data: HistoryData, batchId: string, update: (batch: Batch) => Batch | null): HistoryData {
  const pages = data.pages.map((page) => {
    if (!page.items.some((batch) => batch.id === batchId)) return page;
    return tagHistoryPageItems(page, page.items.flatMap((batch) => {
      if (batch.id !== batchId) return [batch];
      const next = update(batch);
      return next ? [next] : [];
    }));
  });
  return withTaggedPages(data, pages);
}

// The tile back at its snapshot position relative to the tiles still present.
function withTileRestored(current: Batch, snapshot: Batch, tile: Tile): Batch {
  const at = snapshot.tiles.findIndex((candidate) => candidate.id === tile.id);
  const predecessor = snapshot.tiles.slice(0, Math.max(0, at)).findLast((candidate) => current.tiles.some((present) => present.id === candidate.id));
  const insertAt = predecessor ? current.tiles.findIndex((present) => present.id === predecessor.id) + 1 : 0;
  return { ...current, tiles: current.tiles.toSpliced(insertAt, 0, tile) };
}

function inverseOf(data: HistoryData, snapshotRow: Batch, change: MirrorChange, view: AppView): HistoryData {
  const current = findRow(data, snapshotRow.id);
  if (change.kind === 'removeBatch') return current ? data : upsertHistoryBatch(data, snapshotRow);
  if (change.kind === 'removeTile') {
    const tile = snapshotRow.tiles.find((candidate) => candidate.id === change.tileId);
    if (!tile) return data;
    // The batch is gone: this write removed it only when the tile was its last.
    if (!current) return snapshotRow.tiles.length === 1 ? upsertHistoryBatch(data, snapshotRow) : data;
    if (current.tiles.some((candidate) => candidate.id === tile.id)) return data;
    return mapRow(data, current.id, (batch) => withTileRestored(batch, snapshotRow, tile));
  }
  const fields = Object.keys(change.patch) as (keyof typeof change.patch)[];
  if (!current) {
    // Re-insert only where this write's own patch dropped the row.
    const patched = { ...snapshotRow, ...change.patch };
    return belongsToScope(snapshotRow, view) && !belongsToScope(patched, view) ? upsertHistoryBatch(data, snapshotRow) : data;
  }
  const restored: Partial<Pick<Batch, 'collectionId' | 'pinned'>> = {};
  for (const field of fields) {
    if (current[field] === change.patch[field] && snapshotRow[field] !== change.patch[field]) {
      Object.assign(restored, { [field]: snapshotRow[field] });
    }
  }
  if (Object.keys(restored).length === 0) return data;
  return mapRow(data, current.id, (batch) => {
    const next = { ...batch, ...restored };
    return belongsToScope(next, view) ? next : null;
  });
}

// Undo exactly what this write changed, scope by scope, against each scope's
// current data: re-insert a removed batch that is still absent, re-insert a
// removed tile at its relative position, restore a patched field only where
// the row still holds this write's optimistic value. Rows, pages, tiles and
// fields other writers changed since the snapshot stay; anything ambiguous is
// left to the settle re-read.
export function rollbackCanonicalMirror(queryClient: QueryClient, ctx: CanonicalMirror): void {
  for (const { key, previous } of ctx.snapshots) {
    const snapshotRow = previous ? findRow(previous, ctx.batchId) : undefined;
    if (!snapshotRow) continue;
    const view = viewFromActiveKey(key);
    writeHistoryScope(queryClient, key, (current) => inverseOf(current, snapshotRow, ctx.change, view));
  }
}

function belongsToScope(batch: Batch, view: AppView): boolean {
  if (view.kind === 'pinned') return batch.pinned;
  if (view.kind === 'unsorted') return batch.collectionId === null;
  if (view.kind === 'collection') return batch.collectionId === view.id;
  return false;
}

function viewFromActiveKey(activeKey: QueryKey): AppView {
  const scope = activeKey.at(-1);
  if (typeof scope === 'object' && scope !== null && 'view' in scope) {
    return (scope.view as AppView);
  }
  return APP_VIEW_UNSORTED;
}

export function updateBatchInActiveScope(
  queryClient: QueryClient,
  activeKey: QueryKey,
  batchId: string,
  patch: Partial<Pick<Batch, 'collectionId' | 'pinned'>>,
): HistoryData | undefined {
  const previous = queryClient.getQueryData<HistoryData>(activeKey);
  const activeView = viewFromActiveKey(activeKey);
  writeHistoryScope(queryClient, activeKey, (current) => retagHistoryData({
    ...current,
    pages: current.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((batch) => {
        if (batch.id !== batchId) return [batch];
        const next = { ...batch, ...patch };
        return belongsToScope(next, activeView) ? [next] : [];
      }),
    })),
  }));
  return previous;
}

/** Server-truth replacement of one batch in one cached scope; drops it when it no longer belongs there. */
export function replaceBatchInScope(
  queryClient: QueryClient,
  activeKey: QueryKey,
  returnedBatch: Batch,
): void {
  const activeView = viewFromActiveKey(activeKey);
  writeHistoryScope(queryClient, activeKey, (current) => retagHistoryData({
    ...current,
    pages: current.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((batch) => {
        if (batch.id !== returnedBatch.id) return [batch];
        return belongsToScope(returnedBatch, activeView) ? [returnedBatch] : [];
      }),
    })),
  }));
}

interface ScopedBatchPatchOptions<TInput extends { batchId: string }> {
  toPatch: (input: TInput) => PatchBatchInput;
  toOptimistic: (input: TInput) => Partial<Pick<Batch, 'collectionId' | 'pinned'>>;
}

export function useScopedBatchPatch<TInput extends { batchId: string }>(
  scope: Partial<ActiveScope> = {},
  options: ScopedBatchPatchOptions<TInput>,
) {
  const queryClient = useQueryClient();
  const activeKey = activeScopeKey(scope);
  return useMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: (input: TInput) => patchBatch(input.batchId, options.toPatch(input)),
    // The patch lands in every cached scope that shows the batch, not only the
    // acted-on one: the canonical Unsorted feed (the SSE write target) and any
    // other cached scope would otherwise keep the old collection or pin until
    // their next server read, and while a stream runs that read can be a long
    // way off. A scope the batch leaves drops it; a scope it would newly join
    // waits for the settle re-read (canonical placement needs the server row).
    onMutate: async (input): Promise<CanonicalMirror> => {
      const mirror = await beginCanonicalMirror(queryClient, activeKey, input.batchId, { kind: 'patch', patch: options.toOptimistic(input) });
      for (const key of mirror.keys) {
        updateBatchInActiveScope(queryClient, key, input.batchId, options.toOptimistic(input));
      }
      return mirror;
    },
    onError: (_error, _input, rollback) => {
      if (rollback) rollbackCanonicalMirror(queryClient, rollback);
    },
    onSuccess: (batch, _input, mirror) => {
      // Server-truth write into every touched scope so the visible feed
      // doesn't flash between the optimistic patch and the settle refetch.
      for (const key of mirror.keys) replaceBatchInScope(queryClient, key, batch);
    },
    onSettled: async () => {
      // Default (active) refetch — identical to the original
      // useMoveBatch/useTogglePin behaviour. The earlier
      // refetchType:'none' optimization was reverted: both adversarial
      // tiers flagged that it dropped the active-scope server reconcile in
      // the no-navigation case and mis-keyed the navigated-into scope.
      await invalidateLibrary(queryClient);
    },
  });
}
