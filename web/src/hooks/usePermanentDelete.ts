import { useQueryClient } from '@tanstack/react-query';
import { permanentDelete } from '../api/archive';
import { useAtelierStore } from '../store/atelier';
import { invalidateLibrary } from './invalidateLibrary';
import { useToastMutation } from './useToastMutation';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

export function usePermanentDelete() {
  const queryClient = useQueryClient();
  const closeLightbox = useAtelierStore((state) => state.closeLightbox);
  return useToastMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: permanentDelete,
    successToast: 'Deleted',
    errorFallback: "Couldn't delete that permanently.",
    onSuccess: () => { closeLightbox(); },
    onSettled: () => invalidateLibrary(queryClient),
  });
}
