import type { ByokProvider } from '@atelier/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { putKey } from '../api/keys';
import { invalidateByokStatus } from './invalidateByokStatus';

export function useSetKey(provider: ByokProvider) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => putKey(provider, key),
    onSuccess: () => { invalidateByokStatus(queryClient, provider); },
  });
}
