import { useQueryClient } from '@tanstack/react-query';
import { clearHistory, historyKeys } from '../api/history';
import { APP_VIEW_UNSORTED, useAtelierStore, type AppView } from '../store/atelier';
import { invalidateLibrary } from './invalidateLibrary';
import { useToastMutation } from './useToastMutation';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

export function clearAllConfirmCopy(view: AppView): string {
  if (view.kind === 'unsorted') return 'Every unsorted batch moves to the Archive.';
  if (view.kind === 'collection') return 'Every batch in this collection moves to the Archive.';
  return 'Every batch in this view moves to the Archive.';
}

export function useClearAll(scope: { activeView?: AppView } = {}) {
  const queryClient = useQueryClient();
  const setActiveBatchId = useAtelierStore((state) => state.setActiveBatchId);
  const clearFollowAnchor = useAtelierStore((state) => state.clearFollowAnchor);
  const clearAllTilePreviews = useAtelierStore((state) => state.clearAllTilePreviews);
  const clearAllTileProgress = useAtelierStore((state) => state.clearAllTileProgress);
  const activeView = scope.activeView ?? APP_VIEW_UNSORTED;
  return useToastMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: () => clearHistory(activeView),
    successToast: 'Archived',
    errorFallback: "Couldn't clear history.",
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: historyKeys.all() });
      // Wipe any in-flight preview entries left over from streams that
      // were mid-generation when the user cleared. The LoadingTile
      // unmount effect would also catch them, but bulk reset is O(1) vs
      // N sequential single-key spread+filters.
      clearAllTilePreviews();
      clearAllTileProgress();
      setActiveBatchId(null);
      clearFollowAnchor();
    },
    onSettled: () => invalidateLibrary(queryClient),
  });
}
