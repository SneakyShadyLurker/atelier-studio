import { useEffect } from 'react';
import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Batch } from '@atelier/shared';
import type { HistoryRefreshResponse } from '@atelier/shared/wire-schemas';
import { ApiError } from '../api/client';
import { historyKeys, historyRefreshInterval, pendingStoryPollDecision, type HistoryData } from '../api/history';
import { historyRefreshKeys, historyRefreshTargets, refreshHistory } from '../api/historyRefresh';
import { useAtelierStore, type AppView } from '../store/atelier';
import { sortsBefore, tagHistoryPageItems, upsertHistoryBatch, withTaggedPages } from './historyCache';
import { HISTORY_WRITE_MUTATION_KEY, lastHistoryWriteId } from './historyWrites';
import { getBatch } from './inFlightBatches';

const lastHistoryWrite = lastHistoryWriteId;

/** Active refreshes change job state, never optimistic scope or tile membership. */
export function mergeHistoryRefresh(current: HistoryData, response: HistoryRefreshResponse, storyIds: readonly string[] = [], snapshot: HistoryData = current): HistoryData {
  const before = new Map(snapshot.pages.flatMap((page) => page.items.map((batch) => [batch.id, batch] as const)));
  const present = new Map(current.pages.flatMap((page) => page.items.map((batch) => [batch.id, batch] as const)));
  // SSE updates to one batch must not starve unrelated jobs. Compare each
  // batch by identity, retaining newer writes and removals from this request.
  const unchanged = (id: string) => before.has(id) ? present.get(id) === before.get(id) : !present.has(id);
  const items = response.items.filter((batch) => unchanged(batch.id));
  const missing = new Set(response.missingBatchIds.filter(unchanged));
  if (items.length === 0 && missing.size === 0) return current;
  const updates = new Map(items.map((batch) => [batch.id, batch]));
  // Pages with no touched batch keep their identity, so structural sharing
  // and the row memos skip them without a deep compare.
  const pages = current.pages.map((page) => (
    page.items.some((batch) => missing.has(batch.id) || updates.has(batch.id))
      ? tagHistoryPageItems(page, page.items.flatMap((batch): Batch[] => {
            if (missing.has(batch.id)) return [];
            const incoming = updates.get(batch.id);
            if (!incoming) return [batch];
            const tiles = new Map(batch.tiles.map((tile) => [tile.id, tile]));
            // Collection and pin come from the server row: the queryFn already
            // discards any response that overlapped a local history write, so
            // an optimistic patch is never overwritten here, and a change made
            // elsewhere (another tab or device) converges on the next poll.
            return [{
              ...incoming,
              tiles: incoming.tiles.flatMap((tile) => {
                const before = tiles.get(tile.id);
                return before ? [before.status !== 'loading' ? before : tile] : [];
              }),
            }];
          }))
      : page
  ));
  const stories = new Set(storyIds);
  const tail = current.pages.at(-1);
  const oldest = current.pages.toReversed().find((page) => page.items.length > 0)?.items.at(-1);
  const added = items.filter((batch) => !present.has(batch.id) && !missing.has(batch.id)
    && batch.story !== undefined && stories.has(batch.story.id)
    // Older unloaded story segments belong to future cursor pages. Inserting
    // them now would put those future pages after an older row in the feed.
    // A loaded window with every row removed gives no position either: it
    // still waits for pagination while a cursor remains.
    && !(tail?.nextCursor !== null && (oldest === undefined || sortsBefore(oldest, batch))));
  return added.reduce(upsertHistoryBatch, withTaggedPages(current, pages));
}

export function useHistoryRefresh(view: AppView, q: string, data: HistoryData | undefined, enabled: boolean) {
  const client = useQueryClient();
  const writing = useIsMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY });
  const pendingStory = useAtelierStore((state) => state.pendingStory);
  const sourceKey = historyKeys.scoped(view, q);
  const refreshKey = historyRefreshKeys.scoped(view, q);
  const pages = data?.pages ?? [];
  const targets = historyRefreshTargets(pages.flatMap((page) => page.items), pendingStory?.id);
  const active = targets.batchIds.length > 0 || targets.storyIds.length > 0;
  const refreshEnabled = enabled && writing === 0 && active;

  useEffect(() => {
    if (writing > 0 || !enabled) void client.cancelQueries({ queryKey: historyRefreshKeys.all() });
  }, [client, enabled, writing]);

  const query = useQuery({
    queryKey: refreshKey,
    enabled: refreshEnabled,
    // Preserve the previous 3–30s scheduling: mounting an active feed does
    // not issue a second request immediately after its initial history GET.
    initialData: null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal, client: queryClient }) => {
      const sourceKey = historyKeys.scoped(view, q);
      const sourceQuery = queryClient.getQueryCache().find({ queryKey: sourceKey, exact: true });
      const snapshot = queryClient.getQueryData<HistoryData>(sourceKey);
      const write = lastHistoryWrite(queryClient);
      if (!snapshot || queryClient.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY }) > 0) return null;
      const pending = useAtelierStore.getState().pendingStory;
      const pendingId = pendingStoryPollDecision(snapshot.pages, pending, Date.now()) === 'poll' ? pending?.id : undefined;
      const all = historyRefreshTargets(snapshot.pages.flatMap((page) => page.items), pendingId);
      // A batch this tab streams converges through its own events; the poll
      // covers work whose stream lives elsewhere or has ended.
      const targets = { ...all, batchIds: all.batchIds.filter((id) => getBatch(id) === undefined) };
      if (targets.batchIds.length === 0 && targets.storyIds.length === 0) return null;
      const response = await refreshHistory(targets, view, q, signal);
      signal.throwIfAborted();
      // User writes invalidate the whole request; SSE/pagination changes are
      // reconciled per batch so independent active jobs can still converge.
      // A list GET still in flight was read before this response: landing the
      // merge under it would let the older read drop a batch the merge added,
      // so the next tick applies it instead.
      const liveSource = queryClient.getQueryCache().find({ queryKey: sourceKey, exact: true });
      if (queryClient.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY }) > 0
        || lastHistoryWrite(queryClient) !== write
        || liveSource !== sourceQuery
        || liveSource?.state.fetchStatus === 'fetching') return null;
      queryClient.setQueryData<HistoryData>(sourceKey, (current) => current ? mergeHistoryRefresh(current, response, targets.storyIds, snapshot) : current);
      return null;
    },
    refetchInterval: (query) => enabled && writing === 0
      ? historyRefreshInterval({ state: { data: client.getQueryData<HistoryData>(sourceKey), fetchFailureCount: query.state.fetchFailureCount } })
      : false,
    retry: (count, error) => !(error instanceof ApiError && !error.retryable) && count < 2,
  });
  useEffect(() => {
    // An ended activity window must not lend its error to the next job.
    // Resetting a disabled query clears native error state without fetching.
    if (!active && query.isError) {
      void client.resetQueries({ queryKey: historyRefreshKeys.scoped(view, q), exact: true });
    }
  }, [active, client, q, query.isError, view]);
  return {
    isError: refreshEnabled && query.isError,
    error: refreshEnabled ? query.error : null,
    refetch: query.refetch,
  };
}
