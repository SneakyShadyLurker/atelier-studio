// Unsorted (historyKeys.list()) is the canonical SSE channel scope — every mutation touching batch tiles must mirror the optimistic patch into Unsorted in addition to the active scope.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { describeError } from '../lib/errorCopy';
import { deleteTile } from '../api/history';
import { useAtelierStore } from '../store/atelier';
import { historyKeys } from '../api/history';
import { findTileInCache, removeTileFromCache } from './historyCache';
import { invalidateLibrary } from './invalidateLibrary';
import {
  activeScopeKey,
  beginCanonicalMirror,
  rollbackCanonicalMirror,
  type ActiveScope,
  type HistoryData,
} from './scopedHistoryMutation';
import { useCancel } from './useCancel';
import type { QueryKey } from '@tanstack/react-query';

interface DeleteTileInput {
  batchId: string;
  tileId: string;
  intent?: 'archive' | 'dismiss';
}

interface MutationContext {
  readonly activeKey: QueryKey;
  readonly canonicalKey?: QueryKey;
  readonly canonicalPrevious?: HistoryData | undefined;
  readonly previous: HistoryData | undefined;
  readonly wasLoading: boolean;
}

export function useDeleteTile(scope: Partial<ActiveScope> = {}) {
  const queryClient = useQueryClient();
  const addToast = useAtelierStore((state) => state.addToast);
  const closeLightbox = useAtelierStore((state) => state.closeLightbox);
  const clearTilePreview = useAtelierStore((state) => state.clearTilePreview);
  const clearTileProgress = useAtelierStore((state) => state.clearTileProgress);
  const activeKey = activeScopeKey(scope);
  const { cancelTile } = useCancel(scope);
  return useMutation({
    mutationFn: async ({ batchId, tileId }: DeleteTileInput): Promise<void> => {
      const cached = findTileInCache(queryClient, activeKey, batchId, tileId);
      if (cached?.status === 'loading') {
        await cancelTile(batchId, tileId);
        return;
      }
      await deleteTile(batchId, tileId);
    },
    onMutate: async (input): Promise<MutationContext> => {
      const cached = findTileInCache(queryClient, activeKey, input.batchId, input.tileId);
      const wasLoading = cached?.status === 'loading';
      if (wasLoading) {
        // Match the v5 contract (cancel-before-snapshot) on the loading
        // branch too. Without this, an in-flight refetch landing between
        // here and `useCancel.onMutate`'s own cancelQueries can resurrect
        // the optimistically-removed tile before the server delete lands.
        await queryClient.cancelQueries({ queryKey: historyKeys.all() });
        return { activeKey, previous: undefined, wasLoading };
      }
      const mirror = await beginCanonicalMirror(queryClient, activeKey);
      removeTileFromCache(queryClient, activeKey, input.batchId, input.tileId);
      if (mirror.canonicalKey) {
        removeTileFromCache(queryClient, mirror.canonicalKey, input.batchId, input.tileId);
      }
      // Drops a possible in-flight preview entry. Same rationale as
      // useDeleteBatch — closes the partial-arrives-after-remove gap.
      clearTilePreview(input.tileId);
      clearTileProgress(input.tileId);
      return { ...mirror, wasLoading };
    },
    onSuccess: (_data, input, context) => {
      if (context.wasLoading) {
        closeLightbox();
        addToast('Image canceled');
        return;
      }
      closeLightbox();
      addToast(input.intent === 'dismiss' ? 'Dismissed' : 'Archived');
    },
    onError: (error, _input, context) => {
      if (context?.wasLoading) return;
      if (context) rollbackCanonicalMirror(queryClient, context);
      addToast(describeError(error, "Couldn't delete that."), 'error');
    },
    onSettled: async () => {
      await invalidateLibrary(queryClient);
    },
  });
}
