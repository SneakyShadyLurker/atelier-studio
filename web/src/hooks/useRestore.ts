import { useQueryClient } from '@tanstack/react-query';
import { restoreArchive } from '../api/archive';
import { invalidateLibrary } from './invalidateLibrary';
import { useToastMutation } from './useToastMutation';

export function useRestore() {
  const queryClient = useQueryClient();
  return useToastMutation({
    mutationFn: restoreArchive,
    successToast: 'Restored',
    errorFallback: "Couldn't restore that.",
    onSettled: () => invalidateLibrary(queryClient),
  });
}
