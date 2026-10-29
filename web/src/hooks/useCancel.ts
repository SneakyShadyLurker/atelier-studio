// Unsorted (historyKeys.list()) is the canonical SSE channel scope — every mutation touching batch tiles must mirror the optimistic patch into Unsorted in addition to the active scope.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteBatch, deleteTile, historyKeys, isDefaultHistoryScopeKey } from '../api/history';
import { useAtelierStore } from '../store/atelier';
import { emitHistoryCancel, emitHistoryInvalidate } from './broadcastHistory';
import { loadingTileIdsInBatch, removeBatchFromCache, removeTileFromCache } from './historyCache';
import { invalidateLibrary } from './invalidateLibrary';
import { activeScopeKey, liveActiveScopeKey, type ActiveScope } from './scopedHistoryMutation';
import { getBatch } from './inFlightBatches';

type CancelInput =
  | { kind: 'tile'; batchId: string; tileId: string }
  | { kind: 'batch'; batchId: string };

export function useCancel(scope: Partial<ActiveScope> = {}): {
  cancelTile: (batchId: string, tileId: string) => Promise<void>;
  cancelBatch: (batchId: string) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const clearTilePreview = useAtelierStore((state) => state.clearTilePreview);
  const clearTileProgress = useAtelierStore((state) => state.clearTileProgress);
  const addToast = useAtelierStore((state) => state.addToast);
  // Resolve lazily at mutate time: an explicit scope (from useDeleteBatch/
  // useDeleteTile, sourced from App's view + deferred-q) pins the visible
  // scope; TilePlaceholder's bare useCancel() resolves the live store scope so
  // a navigation during the cancel exit animation still targets what's shown.
  const resolveActiveKey = () =>
    scope.activeView !== undefined ? activeScopeKey(scope) : liveActiveScopeKey();

  const { mutateAsync } = useMutation({
    mutationFn: async (input: CancelInput): Promise<void> => {
      if (input.kind === 'tile') await deleteTile(input.batchId, input.tileId);
      else await deleteBatch(input.batchId);
      getBatch(input.batchId)?.controller.abort(new DOMException('canceled by user', 'AbortError'));
    },
    // Fire-and-forget-with-reconcile: optimistically remove, then let
    // onSettled's invalidate converge against server truth. No snapshot /
    // rollback — the server-side cancel fires BEFORE its DB transaction
    // (architecture.md §Lifecycle "User cancel"), so the rows are already
    // gone server-side; restoring the pre-cancel snapshot on a flaky DELETE
    // would reintroduce stale `loading` tiles that fight the server until
    // the next focus refetch. cancelQueries stops an in-flight refetch from
    // resurrecting the rows between here and onSettled.
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: historyKeys.all() });
      const activeKey = resolveActiveKey();
      const canonicalKey = historyKeys.list();
      const hasCanonicalCache = queryClient.getQueryData(canonicalKey) !== undefined;
      const shouldMirrorToCanonical = !isDefaultHistoryScopeKey(activeKey) && hasCanonicalCache;
      if (input.kind === 'tile') {
        removeTileFromCache(queryClient, activeKey, input.batchId, input.tileId);
        if (shouldMirrorToCanonical) {
          removeTileFromCache(queryClient, canonicalKey, input.batchId, input.tileId);
        }
        clearTilePreview(input.tileId);
        clearTileProgress(input.tileId);
      } else {
        const tileIds = new Set(loadingTileIdsInBatch(queryClient, activeKey, input.batchId));
        if (shouldMirrorToCanonical) {
          for (const tileId of loadingTileIdsInBatch(queryClient, canonicalKey, input.batchId)) {
            tileIds.add(tileId);
          }
        }
        for (const tileId of tileIds) {
          clearTilePreview(tileId);
          clearTileProgress(tileId);
        }
        removeBatchFromCache(queryClient, activeKey, input.batchId);
        if (shouldMirrorToCanonical) {
          removeBatchFromCache(queryClient, canonicalKey, input.batchId);
        }
      }
      emitHistoryInvalidate(input.batchId);
      emitHistoryCancel(input.batchId);
    },
    // The optimistic removal hid the tile, so a failed DELETE would otherwise
    // be invisible until onSettled's refetch quietly brings it back.
    onError: () => {
      addToast("Couldn't cancel — the generation may still finish.", 'error');
    },
    onSettled: async (_data, _error, input) => {
      // The early signal may have made siblings read before DELETE committed.
      // Notify them again even on failure, when the generation may survive.
      emitHistoryInvalidate(input.batchId);
      await invalidateLibrary(queryClient);
      await queryClient.invalidateQueries({ queryKey: historyKeys.all() });
    },
  });

  const cancelTile = async (batchId: string, tileId: string): Promise<void> => {
    await mutateAsync({ kind: 'tile', batchId, tileId });
  };
  const cancelBatch = async (batchId: string): Promise<void> => {
    await mutateAsync({ kind: 'batch', batchId });
  };

  return { cancelTile, cancelBatch };
}
