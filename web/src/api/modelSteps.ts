import type { ModelStepsPutRequest, ModelStepsSettingsResponse } from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, requestJson } from './client';

export const modelStepsKeys = {
  all: () => ['model-steps'] as const,
};

export const modelStepsOpts = () =>
  queryOptions({
    queryKey: modelStepsKeys.all(),
    queryFn: () => requestJson<ModelStepsSettingsResponse>('/settings/model-steps'),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 404 || !error.retryable)) return false;
      return failureCount < 2;
    },
  });

/** null resets the model to its default step count. */
export function putModelSteps(modelId: string, steps: number | null): Promise<ModelStepsSettingsResponse> {
  const body: ModelStepsPutRequest = { steps };
  return requestJson<ModelStepsSettingsResponse>(
    `/settings/model-steps/${encodeURIComponent(modelId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}
