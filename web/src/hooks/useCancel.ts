// A cancel removes the tile or batch from every cached history scope that
// shows it (the acted-on scope, the canonical Unsorted feed the SSE stream
// writes, and any other cached scope holding the row).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteBatch, deleteTile, historyKeys } from '../api/history';
import { useAtelierStore } from '../store/atelier';
import { emitHistoryCancel, emitHistoryInvalidate } from './broadcastHistory';
import { historyScopesWithBatch, loadingTileIdsInBatch, removeBatchFromCache, removeTileFromCache, tombstoneCanceledTiles } from './historyCache';
import { invalidateLibrary } from './invalidateLibrary';
import { activeScopeKey, liveActiveScopeKey, type ActiveScope } from './scopedHistoryMutation';
import { getBatch } from './inFlightBatches';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

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
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: async (input: CancelInput): Promise<void> => {
      if (input.kind === 'tile') {
        // Per-tile cancel is server-mediated: the server aborts that tile's
        // work and the events stream delivers its `canceled` terminal, while
        // the batch's other tiles keep rendering on the same stream. Aborting
        // the stream here would drop their previews and progress and leave
        // their terminals to the poll.
        await deleteTile(input.batchId, input.tileId);
        return;
      }
      await deleteBatch(input.batchId);
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
    // The context carries the tiles a confirmed cancel tombstones: the tile, or
    // every loading tile of the batch as the cache showed it here.
    onMutate: async (input): Promise<{ canceledTileIds: readonly string[] }> => {
      await queryClient.cancelQueries({ queryKey: historyKeys.all() });
      const activeKey = resolveActiveKey();
      // The active key first (a scope whose cache is missing still gets the
      // no-op), then every other cached scope that holds the batch.
      const keys = [activeKey, ...historyScopesWithBatch(queryClient, historyKeys.all(), input.batchId)
        .filter((key) => JSON.stringify(key) !== JSON.stringify(activeKey))];
      const tileIds = new Set<string>();
      if (input.kind === 'tile') {
        tileIds.add(input.tileId);
        for (const key of keys) removeTileFromCache(queryClient, key, input.batchId, input.tileId);
        clearTilePreview(input.tileId);
        clearTileProgress(input.tileId);
      } else {
        for (const key of keys) {
          for (const tileId of loadingTileIdsInBatch(queryClient, key, input.batchId)) tileIds.add(tileId);
        }
        for (const tileId of tileIds) {
          clearTilePreview(tileId);
          clearTileProgress(tileId);
        }
        for (const key of keys) removeBatchFromCache(queryClient, key, input.batchId);
      }
      emitHistoryInvalidate(input.batchId);
      // Only a batch cancel ends the stream; the owning tab aborts on this.
      if (input.kind === 'batch') emitHistoryCancel(input.batchId);
      return { canceledTileIds: [...tileIds] };
    },
    // Only a confirmed cancel tombstones: a history read sent before the
    // DELETE committed must not show those tiles again. A failed cancel
    // writes nothing, so the settle re-read brings a surviving tile back.
    onSuccess: (_data, _input, context) => {
      tombstoneCanceledTiles(context.canceledTileIds);
    },
    // The optimistic removal hid the tile, so a failed DELETE would otherwise
    // be invisible until onSettled's refetch quietly brings it back.
    onError: () => {
      addToast("Couldn't cancel — the generation may still finish.", 'error');
    },
    // The early signal may have made siblings read before DELETE committed;
    // the app MutationCache notifies them again once this write settles, even
    // on failure, when the generation may survive. invalidateLibrary is the
    // one history re-read: it waits behind any other pending history write.
    onSettled: async () => {
      await invalidateLibrary(queryClient);
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
