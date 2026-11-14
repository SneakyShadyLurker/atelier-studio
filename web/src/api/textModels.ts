import type { TextModelsResponse, TextModelTaskPutRequest, TextTask } from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, requestJson } from './client';

// Not persisted: `shouldDehydrateQuery` (lib/persister.ts) keeps only its own
// key families, and model `status` is live data.
export const textModelKeys = {
  all: () => ['text-models'] as const,
};

export const textModelsOpts = () =>
  queryOptions({
    queryKey: textModelKeys.all(),
    queryFn: () => requestJson<TextModelsResponse>('/text-models'),
    // Model `status` comes from the server's 60s availability poller; refetch
    // on the same cadence so offline marks track actual routing.
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 404 || !error.retryable)) return false;
      return failureCount < 2;
    },
  });

export function putTaskPick(task: TextTask, { modelId, effort }: TextModelTaskPutRequest): Promise<TextModelsResponse> {
  return requestJson<TextModelsResponse>(`/text-models/tasks/${encodeURIComponent(task)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(effort === undefined ? { modelId } : { modelId, effort }),
  });
}
