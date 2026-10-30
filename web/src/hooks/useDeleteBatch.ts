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
} from './scopedHistoryMutation';
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
  readonly canonicalKey?: QueryKey;
  readonly canonicalPrevious?: HistoryData | undefined;
  readonly hadAnyLoading: boolean;
  readonly previous: HistoryData | undefined;
  readonly previewTileIds: readonly string[];
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
    allLoading: tiles.length > 0 && tiles.every((tile) => tile.status === 'loading'),
    hadAnyLoading: tiles.some((tile) => tile.status === 'loading'),
    previous: undefined,
    previewTileIds: [],
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
      const mirror = await beginCanonicalMirror(queryClient, activeKey);
      // Snapshot loading tile IDs BEFORE removing the batch so we can drop
      // their preview entries from the Zustand store. The LoadingTile
      // unmount effect would also catch this, but the explicit cleanup
      // closes the gap where a partial event arrives between
      // `removeBatchFromCache` and the stream's `findTileInCache` guard
      // noticing the batch is gone. beginCanonicalMirror only cancels +
      // snapshots (no removal), so the cache is still intact here.
      const previewTileIds = loadingTileIdsInBatch(queryClient, activeKey, input.batchId);
      removeBatchFromCache(queryClient, activeKey, input.batchId);
      if (mirror.canonicalKey) {
        removeBatchFromCache(queryClient, mirror.canonicalKey, input.batchId);
      }
      for (const tileId of previewTileIds) {
        clearTilePreview(tileId);
        clearTileProgress(tileId);
      }
      return { ...context, ...mirror, previewTileIds };
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
      addToast(input.intent === 'dismiss' ? 'Dismissed' : 'Archived');
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
