import { useQueryClient } from '@tanstack/react-query';
import { permanentDelete } from '../api/archive';
import { useAtelierStore } from '../store/atelier';
import { invalidateLibrary } from './invalidateLibrary';
import { useToastMutation } from './useToastMutation';

export function usePermanentDelete() {
  const queryClient = useQueryClient();
  const closeLightbox = useAtelierStore((state) => state.closeLightbox);
  return useToastMutation({
    mutationFn: permanentDelete,
    successToast: 'Deleted',
    errorFallback: "Couldn't delete that permanently.",
    onSuccess: () => { closeLightbox(); },
    onSettled: () => invalidateLibrary(queryClient),
  });
}
