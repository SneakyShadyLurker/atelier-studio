import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModelStepsSettingsResponse } from '@atelier/shared';
import { modelStepsKeys, modelStepsOpts, putModelSteps } from '../api/modelSteps';

export function useModelSteps() {
  return useQuery(modelStepsOpts());
}

interface SetModelStepsVars {
  readonly modelId: string;
  /** null resets to the model default. */
  readonly steps: number | null;
}

interface SetModelStepsContext {
  readonly prev: ModelStepsSettingsResponse | undefined;
}

const setModelStepsMutationKey = ['model-steps', 'set'] as const;

/**
 * Models with a save in flight. A row stays locked until its save settles, so
 * a slower earlier write cannot land last and restore a value already changed.
 */
export function usePendingModelSteps(): ReadonlySet<string> {
  const modelIds = useMutationState<string | undefined>({
    filters: { mutationKey: setModelStepsMutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as SetModelStepsVars | undefined)?.modelId,
  });
  return new Set(modelIds.filter((modelId) => modelId !== undefined));
}

export function useSetModelSteps() {
  const queryClient = useQueryClient();
  return useMutation<ModelStepsSettingsResponse, Error, SetModelStepsVars, SetModelStepsContext>({
    mutationKey: setModelStepsMutationKey,
    mutationFn: ({ modelId, steps }) => putModelSteps(modelId, steps),
    onMutate: async ({ modelId, steps }) => {
      await queryClient.cancelQueries({ queryKey: modelStepsKeys.all() });
      const prev = queryClient.getQueryData<ModelStepsSettingsResponse>(modelStepsKeys.all());
      if (prev) {
        queryClient.setQueryData<ModelStepsSettingsResponse>(modelStepsKeys.all(), {
          ...prev,
          // Mirrors the server: the default value is stored as no override.
          models: prev.models.map((model) => (model.modelId === modelId
            ? { ...model, steps: steps === model.defaultSteps ? null : steps }
            : model)),
        });
      }
      return { prev };
    },
    onSuccess: (response) => {
      queryClient.setQueryData(modelStepsKeys.all(), response);
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(modelStepsKeys.all(), ctx.prev);
    },
    onSettled: () => {
      return queryClient.invalidateQueries({ queryKey: modelStepsKeys.all() });
    },
  });
}
