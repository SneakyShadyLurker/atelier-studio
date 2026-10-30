import { useQueryClient } from '@tanstack/react-query';
import { deleteCollection } from '../api/collections';
import { APP_VIEW_ARCHIVE, APP_VIEW_UNSORTED, useAtelierStore, type AppView } from '../store/atelier';
import { replaceUrlState } from '../store/urlState';
import { invalidateLibrary } from './invalidateLibrary';
import { useToastMutation } from './useToastMutation';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

function collectionIdForView(view: AppView): string | null {
  if (view.kind === 'collection') return view.id;
  if (view.kind === 'archive' && view.scope.kind === 'collection') return view.scope.id;
  return null;
}

export function useDeleteCollection() {
  const queryClient = useQueryClient();
  return useToastMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: ({ id }: { id: string }) => deleteCollection(id),
    errorFallback: "Couldn't delete that collection.",
    onSuccess: async (_data, input) => {
      const state = useAtelierStore.getState();
      if (collectionIdForView(state.view) === input.id) {
        replaceUrlState(state.view.kind === 'archive' ? APP_VIEW_ARCHIVE : APP_VIEW_UNSORTED, '');
      }
      await invalidateLibrary(queryClient);
    },
  });
}
