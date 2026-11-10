import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ModelResolutionPutRequest,
  ModelResolutionSetting,
  ModelResolutionSettingsResponse,
  RenderResolution,
} from '@atelier/shared';
import { modelResolutionKeys, modelResolutionOpts, putModelResolution } from '../api/modelResolution';

export function useModelResolution() {
  return useQuery(modelResolutionOpts());
}

interface SetModelResolutionVars {
  readonly modelId: string;
  /** Per mode: null resets to the default, an absent key leaves it unchanged. */
  readonly update: ModelResolutionPutRequest;
}

interface SetModelResolutionContext {
  readonly prev: ModelResolutionSettingsResponse | undefined;
}

const setModelResolutionMutationKey = ['model-resolution', 'set'] as const;

/**
 * Models with a save in flight. A row stays locked until its save settles, so
 * a slower earlier write cannot land last and restore a value already changed.
 */
export function usePendingModelResolution(): ReadonlySet<string> {
  const modelIds = useMutationState<string | undefined>({
    filters: { mutationKey: setModelResolutionMutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as SetModelResolutionVars | undefined)?.modelId,
  });
  return new Set(modelIds.filter((modelId) => modelId !== undefined));
}

// Mirrors the server: the default value is stored as no override.
function applied(
  value: RenderResolution | null | undefined,
  current: RenderResolution | null,
  fallback: RenderResolution | null,
): RenderResolution | null {
  if (value === undefined) return current;
  return value === fallback ? null : value;
}

function optimistic(model: ModelResolutionSetting, update: ModelResolutionPutRequest): ModelResolutionSetting {
  return {
    ...model,
    textToImage: applied(update.textToImage, model.textToImage, model.defaultTextToImage),
    reference: applied(update.reference, model.reference, model.defaultReference),
  };
}

export function useSetModelResolution() {
  const queryClient = useQueryClient();
  return useMutation<ModelResolutionSettingsResponse, Error, SetModelResolutionVars, SetModelResolutionContext>({
    mutationKey: setModelResolutionMutationKey,
    mutationFn: ({ modelId, update }) => putModelResolution(modelId, update),
    onMutate: async ({ modelId, update }) => {
      await queryClient.cancelQueries({ queryKey: modelResolutionKeys.all() });
      const prev = queryClient.getQueryData<ModelResolutionSettingsResponse>(modelResolutionKeys.all());
      if (prev) {
        queryClient.setQueryData<ModelResolutionSettingsResponse>(modelResolutionKeys.all(), {
          ...prev,
          models: prev.models.map((model) => (model.modelId === modelId ? optimistic(model, update) : model)),
        });
      }
      return { prev };
    },
    onSuccess: (response) => {
      queryClient.setQueryData(modelResolutionKeys.all(), response);
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(modelResolutionKeys.all(), ctx.prev);
    },
    onSettled: () => {
      return queryClient.invalidateQueries({ queryKey: modelResolutionKeys.all() });
    },
  });
}
