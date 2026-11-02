import type { CollectionsResponse } from '@atelier/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { collectionKeys, collectionListOpts, reorderCollections } from '../api/collections';

interface ReorderAnnounce {
  /** Announced via aria-live on success (caller pre-renders with names/positions). */
  readonly success: string;
  /** Announced via aria-live + toast when the mutation fails and rolls back. */
  readonly revert: string;
}

interface ReorderVars {
  readonly orderedIds: readonly string[];
  readonly announce?: ReorderAnnounce;
}

interface UseReorderCollectionsOptions {
  onAnnounce?: (message: string) => void;
  onErrorToast?: (message: string) => void;
}

// Shared scope keeps overlapping reorders sequential — held-key Alt+ArrowDown
// or rapid drags queue at the mutation layer instead of racing for the cache.
const REORDER_SCOPE_ID = 'collections-order';
const REORDER_MUTATION_KEY = ['collections', 'order'] as const;

// Last server-acknowledged list for the current burst, per client. The cache
// holds the newest optimistic order while siblings are queued, so an earlier
// success records its response here instead; a failure rolls back to it.
// Seeded with the pre-burst cache and cleared when the burst settles.
const confirmedByClient = new WeakMap<QueryClient, CollectionsResponse>();

export function useReorderCollections(options: UseReorderCollectionsOptions = {}) {
  const queryClient = useQueryClient();
  const queryKey = collectionListOpts().queryKey;

  // Hold the handlers in a ref so the hook-level mutation callbacks always
  // call the latest functions — useMutation captures the config at mount and
  // closures would otherwise stale on re-renders.
  const handlersRef = useRef(options);
  // eslint-disable-next-line react-hooks/refs -- latest-ref write; mutation callbacks read it after commit.
  handlersRef.current = options;

  interface ReorderContext {
    previous: CollectionsResponse | undefined;
    optimistic: CollectionsResponse | undefined;
  }

  return useMutation<CollectionsResponse, Error, ReorderVars, ReorderContext>({
    mutationKey: REORDER_MUTATION_KEY,
    scope: { id: REORDER_SCOPE_ID },
    retry: false,
    mutationFn: ({ orderedIds }) => reorderCollections(orderedIds),
    onMutate: async ({ orderedIds }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<CollectionsResponse>(queryKey);
      if (previous && !confirmedByClient.has(queryClient)) confirmedByClient.set(queryClient, previous);
      let optimistic: CollectionsResponse | undefined;
      if (previous) {
        const byId = new Map(previous.items.map((item) => [item.id, item]));
        const reordered = orderedIds.flatMap((id) => {
          const item = byId.get(id);
          return item ? [item] : [];
        });
        if (reordered.length === previous.items.length) {
          // setQueryData applies structural sharing — what lands in the cache
          // is NOT the object we passed in. Capture the stored ref so the
          // compare-and-swap in onError sees an honest equality check.
          optimistic = queryClient.setQueryData<CollectionsResponse>(queryKey, { ...previous, items: reordered });
        }
      }
      return { previous, optimistic };
    },
    onSuccess: (response, vars) => {
      // onMutate runs before the scope gate, so a queued sibling has already
      // written a newer optimistic order. Only the last reorder in a burst
      // writes server truth; an earlier response would rewind the cache that
      // the next keyboard/drag intent computes its order from.
      confirmedByClient.set(queryClient, response);
      if (queryClient.isMutating({ mutationKey: REORDER_MUTATION_KEY }) <= 1) {
        queryClient.setQueryData<CollectionsResponse>(queryKey, response);
      }
      if (vars.announce) handlersRef.current.onAnnounce?.(vars.announce.success);
    },
    onError: (_error, vars, context) => {
      // Compare-and-swap: only roll back if our optimistic write is still the
      // current cache value. A queued sibling's newer optimistic order, or a
      // refetch, means there is nothing for THIS mutation to undo.
      //
      // Roll back to the last server-acknowledged list, not our snapshot:
      // `previous` may be a sibling's optimistic order (lacking the metadata
      // its response carried), so restoring it would revert a successful
      // reorder on a later failure.
      //
      // If we never wrote optimistically (previous was empty or the permutation
      // didn't match the cached set due to a concurrent refetch), leave the
      // cache alone and let invalidateQueries refetch truth.
      if (context?.optimistic) {
        const current = queryClient.getQueryData<CollectionsResponse>(queryKey);
        const rollback = confirmedByClient.get(queryClient) ?? context.previous;
        if (current === context.optimistic && rollback) {
          queryClient.setQueryData(queryKey, rollback);
        }
      }
      if (vars.announce) {
        handlersRef.current.onAnnounce?.(vars.announce.revert);
        handlersRef.current.onErrorToast?.(vars.announce.revert);
      }
    },
    onSettled: () => {
      // Only the last reorder in a burst invalidates — a refetch firing while
      // a sibling mutation is still optimistic would flash the user back to a
      // stale order before the queued mutate lands.
      if (queryClient.isMutating({ mutationKey: REORDER_MUTATION_KEY }) > 1) return;
      confirmedByClient.delete(queryClient);
      void queryClient.invalidateQueries({ queryKey: collectionKeys.list() });
    },
  });
}
