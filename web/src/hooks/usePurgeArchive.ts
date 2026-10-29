import { useQueryClient } from '@tanstack/react-query';
import { archiveKeys, purgeArchive } from '../api/archive';
import { invalidateLibrary } from './invalidateLibrary';
import { useToastMutation } from './useToastMutation';

export function usePurgeArchive() {
  const queryClient = useQueryClient();
  return useToastMutation({
    mutationFn: purgeArchive,
    successToast: 'Archive emptied',
    errorFallback: "Couldn't empty the archive.",
    onSuccess: () => { queryClient.removeQueries({ queryKey: archiveKeys.all() }); },
    onSettled: () => invalidateLibrary(queryClient),
  });
}
