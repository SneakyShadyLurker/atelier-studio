import { useQueryClient } from '@tanstack/react-query';
import { collectionKeys, renameCollection } from '../api/collections';
import { useToastMutation } from './useToastMutation';

export function useRenameCollection() {
  const queryClient = useQueryClient();
  return useToastMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameCollection(id, name),
    errorFallback: "Couldn't rename that collection.",
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: collectionKeys.list() }); },
  });
}
