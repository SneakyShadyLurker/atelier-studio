import type { Model } from '@atelier/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { mergeModelsByAvailabilityFreshness, modelKeys, probeModel } from '../api/models';

export function useProbeModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: probeModel,
    onSuccess: (list) => {
      queryClient.setQueryData<readonly Model[]>(
        modelKeys.list(),
        (cached) => mergeModelsByAvailabilityFreshness(cached, list),
      );
    },
  });
}
