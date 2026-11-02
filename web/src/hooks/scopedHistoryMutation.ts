import type { Batch } from '@atelier/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { historyKeys, isDefaultHistoryScopeKey, patchBatch, type PatchBatchInput } from '../api/history';
import { APP_VIEW_UNSORTED, useAtelierStore, type AppView } from '../store/atelier';
import { retagHistoryData, type HistoryData } from './historyCache';
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

export interface CanonicalMirror {
  activeKey: QueryKey;
  previous: HistoryData | undefined;
  canonicalKey?: QueryKey;
  canonicalPrevious?: HistoryData | undefined;
}

// Begin an optimistic destructive write that must mirror into the canonical
// Unsorted scope (historyKeys.list() — the SSE channel scope) whenever the
// user acts on a NON-default scope whose canonical cache is populated. Cancels
// in-flight refetches on the active key (and the canonical key when mirroring)
// and snapshots both for rollback. It deliberately does NOT remove anything:
// the caller applies its entity-specific removal (tile vs batch) to activeKey
// and — when `canonicalKey` is returned — to canonicalKey, preserving each
// hook's exact pre/post-removal ordering (e.g. useDeleteBatch's preview-id
// snapshot between cancel and removal).
export async function beginCanonicalMirror(
  queryClient: QueryClient,
  activeKey: QueryKey,
): Promise<CanonicalMirror> {
  const canonicalKey = historyKeys.list();
  const hasCanonicalCache = queryClient.getQueryData(canonicalKey) !== undefined;
  const shouldMirror = !isDefaultHistoryScopeKey(activeKey) && hasCanonicalCache;
  await queryClient.cancelQueries({ queryKey: activeKey });
  if (shouldMirror) await queryClient.cancelQueries({ queryKey: canonicalKey });
  const previous = queryClient.getQueryData<HistoryData>(activeKey);
  return {
    activeKey,
    previous,
    ...(shouldMirror ? { canonicalKey, canonicalPrevious: queryClient.getQueryData<HistoryData>(canonicalKey) } : {}),
  };
}

// Restore both the active scope and (when it was mirrored) the canonical scope
// from a beginCanonicalMirror snapshot. Pure cache restore — no removal.
export function rollbackCanonicalMirror(queryClient: QueryClient, ctx: CanonicalMirror): void {
  if (ctx.previous) queryClient.setQueryData(ctx.activeKey, ctx.previous);
  if (ctx.canonicalKey && ctx.canonicalPrevious) {
    queryClient.setQueryData(ctx.canonicalKey, ctx.canonicalPrevious);
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
  queryClient.setQueryData<HistoryData>(activeKey, (current) => {
    if (!current) return current;
    const activeView = viewFromActiveKey(activeKey);
    return retagHistoryData({
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((batch) => {
          if (batch.id !== batchId) return [batch];
          const next = { ...batch, ...patch };
          return belongsToScope(next, activeView) ? [next] : [];
        }),
      })),
    });
  });
  return previous;
}

function replaceBatchInActiveScope(
  queryClient: QueryClient,
  activeKey: QueryKey,
  returnedBatch: Batch,
): void {
  queryClient.setQueryData<HistoryData>(activeKey, (current) => {
    if (!current) return current;
    const activeView = viewFromActiveKey(activeKey);
    return retagHistoryData({
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((batch) => {
          if (batch.id !== returnedBatch.id) return [batch];
          return belongsToScope(returnedBatch, activeView) ? [returnedBatch] : [];
        }),
      })),
    });
  });
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
    onMutate: async (input): Promise<ScopedRollback> => {
      await queryClient.cancelQueries({ queryKey: activeKey });
      const previous = updateBatchInActiveScope(
        queryClient,
        activeKey,
        input.batchId,
        options.toOptimistic(input),
      );
      return { activeKey, previous };
    },
    onError: (_error, _input, rollback) => {
      if (rollback?.previous) queryClient.setQueryData(rollback.activeKey, rollback.previous);
    },
    onSuccess: (batch) => {
      // Server-truth write into the acted-on scope so the visible feed
      // doesn't flash between the optimistic patch and the settle refetch.
      replaceBatchInActiveScope(queryClient, activeKey, batch);
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
