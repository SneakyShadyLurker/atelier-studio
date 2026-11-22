import type { PromptCondensePutRequest, PromptCondenseSettingsResponse } from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, requestJson } from './client';

export const promptCondenseKeys = {
  all: () => ['prompt-condense'] as const,
};

export const promptCondenseOpts = () =>
  queryOptions({
    queryKey: promptCondenseKeys.all(),
    queryFn: () => requestJson<PromptCondenseSettingsResponse>('/settings/prompt-condense'),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 404 || !error.retryable)) return false;
      return failureCount < 2;
    },
  });

export function putPromptCondense(enabled: boolean): Promise<PromptCondenseSettingsResponse> {
  const body: PromptCondensePutRequest = { enabled };
  return requestJson<PromptCondenseSettingsResponse>('/settings/prompt-condense', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
