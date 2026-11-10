import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { historyKeys } from '../api/history';
import { historyLoadingTileCount, type HistoryData } from './historyCache';

/**
 * Whether the Unsorted feed (where every generation lands) holds a loading
 * tile. A boolean read of the cache, so the caller re-renders only when work
 * starts or stops, not on every tile event of a stream. No request and no
 * poll: the stream and the active-work refresh keep the cache current.
 */
export function useHistoryWorkRunning(): boolean {
  const queryClient = useQueryClient();
  // Batched through the notify manager, as query-core's own cache hooks do:
  // the cache also emits while a component renders.
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [queryClient],
  );
  return useSyncExternalStore(
    subscribe,
    () => {
      const data = queryClient.getQueryData<HistoryData>(historyKeys.list());
      return data !== undefined && historyLoadingTileCount(data) > 0;
    },
    () => false,
  );
}
