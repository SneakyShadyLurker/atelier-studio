import type { Batch } from '@atelier/shared';
import { notifyManager, useIsMutating, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { fetchHistoryPage, historyKeys } from '../api/history';
import type { AppView } from '../store/atelier';
import { historyLoadingTileCount, sortsBefore, upsertHistoryBatch, writeHistoryScope, type HistoryData } from './historyCache';
import { HISTORY_WRITE_MUTATION_KEY, lastHistoryWriteId } from './historyWrites';
import { reReadHistory } from './invalidateLibrary';
import { GENERATE_MUTATION_KEY } from './useGenerate';

// Other-device arrivals. Nothing streams a batch started on another device
// (or in a tab outside this browser's BroadcastChannel) into this tab, so an
// idle feed would show it only on the next focus or settle re-read. One
// 1-row read of the active unfiltered scope per interval compares the
// server's newest row with the cache; a new head costs one further 30-row
// read whose unknown rows are merged canonically.

export const HISTORY_HEAD_PROBE_INTERVAL_MS = 60_000;
const HEAD_MERGE_LIMIT = 30;

// Outside historyKeys.all(): the probe holds no HistoryData, and history
// invalidations and scope scans must never see it.
export const historyHeadKeys = {
  scoped: (view: AppView) => ['history-head', { view }] as const,
};

export type HeadProbeResult = 'current' | 'merged' | 'invalidated' | 'discarded';

function cachedIds(data: HistoryData): Set<string> {
  return new Set(data.pages.flatMap((page) => page.items.map((batch) => batch.id)));
}

/**
 * One probe of `view`'s unfiltered scope. A response read while a history
 * write was pending, or that overlapped a write started after the request,
 * is discarded: it could carry pre-commit state over the write's patch.
 */
export async function probeHistoryHead(queryClient: QueryClient, view: AppView, signal: AbortSignal): Promise<HeadProbeResult> {
  const key = historyKeys.scoped(view, '');
  const write = lastHistoryWriteId(queryClient);
  // The scope's data generation: every read and every cache write bumps it. A
  // read that started and finished while a probe request was in flight is
  // newer than the probe's response (it may have dropped a row another device
  // archived), and `fetchStatus` alone would no longer show it.
  const generation = queryClient.getQueryState(key)?.dataUpdateCount;
  const overlapped = () => queryClient.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY }) > 0
    || lastHistoryWriteId(queryClient) !== write
    || queryClient.getQueryState(key)?.fetchStatus === 'fetching'
    || queryClient.getQueryState(key)?.dataUpdateCount !== generation;
  if (overlapped() || queryClient.getQueryData<HistoryData>(key) === undefined) return 'discarded';
  const head = (await fetchHistoryPage(null, 1, view, '', { signal })).items[0];
  const before = queryClient.getQueryData<HistoryData>(key);
  if (overlapped() || !before) return 'discarded';
  const newest = before.pages.flatMap((page) => page.items)[0];
  // Only a row newer than the newest cached one is an arrival.
  if (!head || cachedIds(before).has(head.id) || (newest !== undefined && !sortsBefore(head, newest))) return 'current';
  const rows = (await fetchHistoryPage(null, HEAD_MERGE_LIMIT, view, '', { signal })).items;
  const current = queryClient.getQueryData<HistoryData>(key);
  if (overlapped() || !current) return 'discarded';
  const known = cachedIds(current);
  const unknown = rows.filter((batch) => !known.has(batch.id));
  if (unknown.length === 0) return 'current';
  // No overlap with the cache: the gap between is unknown, so re-read the scope.
  if (unknown.length === rows.length) {
    await reReadHistory(queryClient, { queryKey: key, exact: true });
    return 'invalidated';
  }
  // An unknown row older than the loaded window belongs to a future cursor page.
  const tail = current.pages.at(-1);
  const oldest = current.pages.toReversed().find((page) => page.items.length > 0)?.items.at(-1);
  const placeable = unknown.filter((batch: Batch) => tail?.nextCursor === null || (oldest !== undefined && sortsBefore(batch, oldest)));
  if (placeable.length > 0) writeHistoryScope(queryClient, key, (data) => placeable.reduce(upsertHistoryBatch, data));
  return 'merged';
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => { document.removeEventListener('visibilitychange', onChange); };
}

const documentVisible = () => document.visibilityState !== 'hidden';

/**
 * Probes the active scope for batches created elsewhere while the feed is
 * visible and idle: not searching, a cache present, no loading tiles cached,
 * no scope read, stream or history write in flight. Mounted by the app shell.
 */
export function useHistoryHeadProbe(
  view: AppView,
  q: string,
  { intervalMs = HISTORY_HEAD_PROBE_INTERVAL_MS }: { intervalMs?: number } = {},
): void {
  const queryClient = useQueryClient();
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, () => true);
  const writing = useIsMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY });
  const generating = useIsMutating({ mutationKey: GENERATE_MUTATION_KEY });
  // Batched through the notify manager, as query-core's own cache hooks do:
  // the cache also emits while a component renders (an observer mounting),
  // and a store change delivered then would update this hook mid-render.
  const subscribeCache = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [queryClient],
  );
  const sourceIdle = useSyncExternalStore(
    subscribeCache,
    () => {
      const state = queryClient.getQueryState<HistoryData>(historyKeys.scoped(view, q));
      return state?.data !== undefined && state.fetchStatus === 'idle' && historyLoadingTileCount(state.data) === 0;
    },
  );
  const enabled = visible && q === '' && sourceIdle && writing === 0 && generating === 0;
  useQuery({
    queryKey: historyHeadKeys.scoped(view),
    enabled,
    // No read on mount or enable: the first probe waits one interval.
    initialData: null,
    staleTime: Infinity,
    gcTime: 0,
    refetchInterval: enabled ? intervalMs : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryFn: async ({ signal, client }) => {
      await probeHistoryHead(client, view, signal);
      return null;
    },
  });
}
