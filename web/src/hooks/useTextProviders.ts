import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { TextRoutingResponse, TextTask } from '@atelier/shared';
import { ApiError } from '../api/client';
import {
  addModels,
  createProvider,
  deleteModel,
  deleteProvider,
  patchModel,
  patchProvider,
  putRoutingDefault,
  putRoutingWriter,
  textAdminKeys,
  textProvidersOpts,
  textRoutingOpts,
  testModel,
  type ModelPatchBody,
  type NewModelBody,
  type ProviderCreateBody,
  type ProviderPatchBody,
  type WriterBody,
} from '../api/textProviders';
import { textModelKeys } from '../api/textModels';

/**
 * Admin text providers. A 404 means the signed-in user is not in
 * TEXT_PROVIDER_ADMINS (same gating as `usePromptLibrary`).
 */
export function useTextProviders() {
  const q = useQuery(textProvidersOpts());
  const gated = q.error instanceof ApiError && q.error.status === 404;
  return {
    enabled: q.isSuccess && !gated,
    gated,
    data: q.data,
    isLoading: q.isLoading,
    isError: q.isError && !gated,
    refetch: q.refetch,
  };
}

export function useTextRouting(enabled = true) {
  return useQuery({ ...textRoutingOpts(), enabled });
}

/**
 * Every admin write changes what users can pick and what their tasks resolve
 * to, so it refreshes the admin queries and the user-facing `/text-models`
 * (picker, effective assignments, in-flight labels) together.
 */
export function invalidateTextConfig(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: textAdminKeys.all() }),
    queryClient.invalidateQueries({ queryKey: textModelKeys.all() }),
  ]).then(() => undefined);
}

/** The one way to write admin text config; Tasks 15-16 dialogs build on it. */
export function useTextAdminMutation<TVars, TData>(mutationFn: (vars: TVars) => Promise<TData>, onSuccess?: (data: TData, queryClient: QueryClient) => void) {
  const queryClient = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn,
    onSuccess: (data) => { onSuccess?.(data, queryClient); },
    onSettled: () => invalidateTextConfig(queryClient),
  });
}

export function useCreateProvider() {
  return useTextAdminMutation((body: ProviderCreateBody) => createProvider(body));
}

export function useDeleteProvider() {
  return useTextAdminMutation((id: string) => deleteProvider(id));
}

export function useAddModels() {
  return useTextAdminMutation(({ providerId, models }: { providerId: string; models: readonly NewModelBody[] }) => addModels(providerId, models));
}

/** "Test model" stores its report and may mark the model tested. */
export function useTestModel() {
  return useTextAdminMutation(({ providerId, modelId }: { providerId: string; modelId: string }) => testModel(providerId, modelId));
}

export function useUpdateProvider() {
  return useTextAdminMutation(({ id, patch }: { id: string; patch: ProviderPatchBody }) => patchProvider(id, patch));
}

/**
 * "Check again": an empty PATCH makes the server re-poll the provider's
 * model list. There is no dedicated refresh route (spec § 10.2).
 */
export function useRefreshProvider() {
  return useTextAdminMutation((id: string) => patchProvider(id, {}));
}

export function useUpdateModel() {
  return useTextAdminMutation(
    ({ providerId, modelId, patch }: { providerId: string; modelId: string; patch: ModelPatchBody }) =>
      patchModel(providerId, modelId, patch),
  );
}

export function useDeleteModel() {
  return useTextAdminMutation(({ providerId, modelId }: { providerId: string; modelId: string }) => deleteModel(providerId, modelId));
}

const keepRouting = (data: TextRoutingResponse, queryClient: QueryClient) => {
  queryClient.setQueryData(textAdminKeys.routing(), data);
};

export function useSetRoutingDefault() {
  return useTextAdminMutation(
    ({ scope, modelId }: { scope: 'default' | TextTask; modelId: string | null }) => putRoutingDefault(scope, modelId),
    keepRouting,
  );
}

export function useSetRoutingWriter() {
  return useTextAdminMutation(
    ({ imageModelId, body }: { imageModelId: string; body: WriterBody }) => putRoutingWriter(imageModelId, body),
    keepRouting,
  );
}
