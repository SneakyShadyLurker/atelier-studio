import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PromptCondenseSettingsResponse } from '@atelier/shared';
import { promptCondenseKeys, promptCondenseOpts, putPromptCondense } from '../api/promptCondense';

export function usePromptCondense() {
  return useQuery(promptCondenseOpts());
}

interface SetPromptCondenseContext {
  readonly prev: PromptCondenseSettingsResponse | undefined;
}

const setPromptCondenseMutationKey = ['prompt-condense', 'set'] as const;

/**
 * True while a save is in flight. The switch stays locked until it settles,
 * so a slower earlier write cannot land last and restore a value already changed.
 */
export function usePendingPromptCondense(): boolean {
  return useMutationState({
    filters: { mutationKey: setPromptCondenseMutationKey, status: 'pending' },
  }).length > 0;
}

export function useSetPromptCondense() {
  const queryClient = useQueryClient();
  return useMutation<PromptCondenseSettingsResponse, Error, boolean, SetPromptCondenseContext>({
    mutationKey: setPromptCondenseMutationKey,
    mutationFn: (enabled) => putPromptCondense(enabled),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: promptCondenseKeys.all() });
      const prev = queryClient.getQueryData<PromptCondenseSettingsResponse>(promptCondenseKeys.all());
      if (prev) queryClient.setQueryData<PromptCondenseSettingsResponse>(promptCondenseKeys.all(), { ...prev, enabled });
      return { prev };
    },
    onSuccess: (response) => {
      queryClient.setQueryData(promptCondenseKeys.all(), response);
    },
    onError: (_error, _enabled, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(promptCondenseKeys.all(), ctx.prev);
    },
    onSettled: () => {
      return queryClient.invalidateQueries({ queryKey: promptCondenseKeys.all() });
    },
  });
}
