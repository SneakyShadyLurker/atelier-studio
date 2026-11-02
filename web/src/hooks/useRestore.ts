import { useQueryClient } from '@tanstack/react-query';
import { restoreArchive } from '../api/archive';
import { invalidateLibrary } from './invalidateLibrary';
import { useToastMutation } from './useToastMutation';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

// One tile (Archive view, Lightbox) or the exact set an archive Undo hands
// back. The set is bounded by one batch, so the per-tile fan-out stays small.
function restoreTiles(tileIds: string | readonly string[]): Promise<void> {
  if (typeof tileIds === 'string') return restoreArchive(tileIds);
  // allSettled, not all: the mutation (and its history-write fence) must not
  // settle while sibling restores are still writing.
  return Promise.allSettled(tileIds.map((tileId) => restoreArchive(tileId))).then((results) => {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
}

export function useRestore() {
  const queryClient = useQueryClient();
  return useToastMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: restoreTiles,
    successToast: 'Restored',
    errorFallback: "Couldn't restore that.",
    onSettled: () => invalidateLibrary(queryClient),
  });
}
