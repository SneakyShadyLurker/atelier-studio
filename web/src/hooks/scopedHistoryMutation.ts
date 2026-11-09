import type { Batch } from '@atelier/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { historyKeys, patchBatch, type PatchBatchInput } from '../api/history';
import { APP_VIEW_UNSORTED, useAtelierStore, type AppView } from '../store/atelier';
import { historyScopesWithBatch, retagHistoryData, writeHistoryScope, type HistoryData } from './historyCache';
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

export interface CanonicalMirror {
  activeKey: QueryKey;
  previous: HistoryData | undefined;
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
): Promise<CanonicalMirror> {
  const keys = [activeKey, ...historyScopesWithBatch(queryClient, historyKeys.all(), batchId).filter((key) => !sameKey(key, activeKey))];
  await Promise.all(keys.map((key) => queryClient.cancelQueries({ queryKey: key, exact: true })));
  const snapshots = keys.map((key) => ({ key, previous: queryClient.getQueryData<HistoryData>(key) }));
  return { activeKey, previous: snapshots[0]?.previous, keys, snapshots };
}

function sameKey(a: QueryKey, b: QueryKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Restore every scope a beginCanonicalMirror snapshot captured. Pure cache
// restore — no removal.
export function rollbackCanonicalMirror(queryClient: QueryClient, ctx: CanonicalMirror): void {
  for (const { key, previous } of ctx.snapshots) {
    if (previous) queryClient.setQueryData(key, previous);
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
      const mirror = await beginCanonicalMirror(queryClient, activeKey, input.batchId);
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
