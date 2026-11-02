import { useQueryClient } from '@tanstack/react-query';
import { archiveKeys, purgeArchive } from '../api/archive';
import { invalidateLibrary } from './invalidateLibrary';
import { useToastMutation } from './useToastMutation';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

export function usePurgeArchive() {
  const queryClient = useQueryClient();
  return useToastMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: purgeArchive,
    successToast: 'Archive emptied',
    errorFallback: "Couldn't empty the archive.",
    onSuccess: () => { queryClient.removeQueries({ queryKey: archiveKeys.all() }); },
    onSettled: () => invalidateLibrary(queryClient),
  });
}
