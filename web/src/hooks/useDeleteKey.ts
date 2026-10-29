import type { ByokProvider } from '@atelier/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteKey } from '../api/keys';
import { invalidateByokStatus } from './invalidateByokStatus';

export function useDeleteKey(provider: ByokProvider) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteKey(provider),
    onSuccess: () => { invalidateByokStatus(queryClient, provider); },
  });
}
