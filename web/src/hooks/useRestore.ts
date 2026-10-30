import { useQueryClient } from '@tanstack/react-query';
import { restoreArchive } from '../api/archive';
import { invalidateLibrary } from './invalidateLibrary';
import { useToastMutation } from './useToastMutation';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

export function useRestore() {
  const queryClient = useQueryClient();
  return useToastMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: restoreArchive,
    successToast: 'Restored',
    errorFallback: "Couldn't restore that.",
    onSettled: () => invalidateLibrary(queryClient),
  });
}
