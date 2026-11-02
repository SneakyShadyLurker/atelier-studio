import { useQueryClient } from '@tanstack/react-query';
import { collectionKeys, createCollection } from '../api/collections';
import { useToastMutation } from './useToastMutation';

export function useCreateCollection() {
  const queryClient = useQueryClient();
  return useToastMutation({
    mutationFn: ({ name }: { name: string }) => createCollection(name),
    errorFallback: "Couldn't create that collection.",
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: collectionKeys.list() }); },
  });
}
