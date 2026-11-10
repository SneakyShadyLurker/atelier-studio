import type { ModelResolutionPutRequest, ModelResolutionSettingsResponse } from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, requestJson } from './client';

export const modelResolutionKeys = {
  all: () => ['model-resolution'] as const,
};

export const modelResolutionOpts = () =>
  queryOptions({
    queryKey: modelResolutionKeys.all(),
    queryFn: () => requestJson<ModelResolutionSettingsResponse>('/settings/model-resolution'),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 404 || !error.retryable)) return false;
      return failureCount < 2;
    },
  });

/** null resets a mode to the model default, `downscale: true` turns downsizing back on; an absent key leaves it unchanged. */
export function putModelResolution(
  modelId: string,
  body: ModelResolutionPutRequest,
): Promise<ModelResolutionSettingsResponse> {
  return requestJson<ModelResolutionSettingsResponse>(
    `/settings/model-resolution/${encodeURIComponent(modelId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}
