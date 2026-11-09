// Unsorted (historyKeys.list()) is the canonical SSE channel scope — every mutation touching batch tiles must mirror the optimistic patch into Unsorted in addition to the active scope.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { describeError } from '../lib/errorCopy';
import { deleteBatch } from '../api/history';
import { useAtelierStore } from '../store/atelier';
import { historyKeys } from '../api/history';
import { findBatchInCache, loadingTileIdsInBatch, removeBatchFromCache } from './historyCache';
import { invalidateLibrary } from './invalidateLibrary';
import {
  activeScopeKey,
  beginCanonicalMirror,
  rollbackCanonicalMirror,
  type ActiveScope,
  type HistoryData,
  type ScopeSnapshot,
} from './scopedHistoryMutation';
import { useArchiveUndoToast } from './useArchiveUndoToast';
import { useCancel } from './useCancel';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';
import type { QueryKey } from '@tanstack/react-query';

interface DeleteBatchInput {
  batchId: string;
  intent?: 'archive' | 'dismiss';
}

interface MutationContext {
  readonly allLoading: boolean;
  readonly activeKey: QueryKey;
  readonly keys: readonly QueryKey[];
  readonly snapshots: readonly ScopeSnapshot[];
  readonly hadAnyLoading: boolean;
  readonly previous: HistoryData | undefined;
  readonly previewTileIds: readonly string[];
  // Done tiles of a batch with nothing in flight: what the server archives
  // (failed tiles are hard-deleted) and so the exact set an Undo restores.
  // Empty on the cancel branch, where cancel intent may hard-delete them.
  readonly archivedTileIds: readonly string[];
}

function batchMutationContext(
  queryClient: ReturnType<typeof useQueryClient>,
  activeKey: QueryKey,
  batchId: string,
): MutationContext {
  const batch = findBatchInCache(queryClient, activeKey, batchId);
  const tiles = batch?.tiles ?? [];
  return {
    activeKey,
    keys: [activeKey],
    snapshots: [],
    allLoading: tiles.length > 0 && tiles.every((tile) => tile.status === 'loading'),
    hadAnyLoading: tiles.some((tile) => tile.status === 'loading'),
    previous: undefined,
    previewTileIds: [],
    archivedTileIds: [],
  };
}

export function useDeleteBatch(scope: Partial<ActiveScope> = {}) {
  const queryClient = useQueryClient();
  const addToast = useAtelierStore((state) => state.addToast);
  const closeLightbox = useAtelierStore((state) => state.closeLightbox);
  const clearTilePreview = useAtelierStore((state) => state.clearTilePreview);
  const clearTileProgress = useAtelierStore((state) => state.clearTileProgress);
  const activeKey = activeScopeKey(scope);
  const { cancelBatch } = useCancel(scope);
  const toastArchived = useArchiveUndoToast();
  return useMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: async ({ batchId }: DeleteBatchInput): Promise<void> => {
      const context = batchMutationContext(queryClient, activeKey, batchId);
      if (context.hadAnyLoading) {
        await cancelBatch(batchId);
        return;
      }
      await deleteBatch(batchId);
    },
    onMutate: async (input): Promise<MutationContext> => {
      const context = batchMutationContext(queryClient, activeKey, input.batchId);
      if (context.hadAnyLoading) {
        // Match the v5 contract (cancel-before-snapshot) on the loading
        // branch too. Without this, an in-flight refetch landing between
        // here and `useCancel.onMutate`'s own cancelQueries can resurrect
        // the optimistically-removed batch before the server delete lands.
        await queryClient.cancelQueries({ queryKey: historyKeys.all() });
        return context;
      }
      const mirror = await beginCanonicalMirror(queryClient, activeKey, input.batchId);
      // Snapshot loading tile IDs BEFORE removing the batch so we can drop
      // their preview entries from the Zustand store. The LoadingTile
      // unmount effect would also catch this, but the explicit cleanup
      // closes the gap where a partial event arrives between
      // `removeBatchFromCache` and the stream's `findTileInCache` guard
      // noticing the batch is gone. beginCanonicalMirror only cancels +
      // snapshots (no removal), so the cache is still intact here.
      const previewTileIds = loadingTileIdsInBatch(queryClient, activeKey, input.batchId);
      // A tile archive from this batch still in flight already removed its
      // tile from the cache; if it then failed, this batch archive would take
      // that tile too and an Undo built from the cache would miss it. Offer
      // no Undo while such an overlap exists (the Archive view still restores).
      const tileArchivePending = queryClient.getMutationCache().findAll({ mutationKey: HISTORY_WRITE_MUTATION_KEY, status: 'pending' })
        .some((mutation) => {
          const variables = mutation.state.variables as { batchId?: unknown; tileId?: unknown } | undefined;
          return variables?.batchId === input.batchId && typeof variables.tileId === 'string';
        });
      const archivedTileIds = tileArchivePending
        ? []
        : (findBatchInCache(queryClient, activeKey, input.batchId)?.tiles ?? [])
          .filter((tile) => tile.status === 'done')
          .map((tile) => tile.id);
      for (const key of mirror.keys) removeBatchFromCache(queryClient, key, input.batchId);
      for (const tileId of previewTileIds) {
        clearTilePreview(tileId);
        clearTileProgress(tileId);
      }
      return { ...context, ...mirror, previewTileIds, archivedTileIds };
    },
    onSuccess: (_data, input, context) => {
      if (context.hadAnyLoading) {
        closeLightbox();
        if (context.allLoading) addToast('Batch canceled');
        else if (input.intent === 'dismiss') addToast('Dismissed');
        else addToast('Archived');
        return;
      }
      closeLightbox();
      toastArchived(input.intent === 'dismiss' ? 'Dismissed' : 'Archived', context.archivedTileIds);
    },
    onError: (error, _input, context) => {
      if (context?.hadAnyLoading) return;
      if (context) rollbackCanonicalMirror(queryClient, context);
      addToast(describeError(error, "Couldn't delete that."), 'error');
    },
    onSettled: async () => {
      await invalidateLibrary(queryClient);
    },
  });
}
