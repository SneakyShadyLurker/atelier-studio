import type {
  AiFillBackend,
  TextBackendSettingsResponse,
  TextBackendWorkload,
  TextReasoningEffort,
} from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, requestJson } from './client';

export const textBackendKeys = {
  all: () => ['text-backends'] as const,
};

export const textBackendsOpts = () =>
  queryOptions({
    queryKey: textBackendKeys.all(),
    queryFn: () => requestJson<TextBackendSettingsResponse>('/prompts/settings/text-backends'),
    // `unavailable` is live status from the server's 60s CLIProxy inventory
    // poller; refetch on the same cadence so labels track actual routing.
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 404 || !error.retryable)) return false;
      return failureCount < 2;
    },
  });

/** `effort` omitted keeps a stored effort the backend still accepts; null resets it. */
export function putTextBackend(
  workload: TextBackendWorkload,
  backend: AiFillBackend | null,
  effort?: TextReasoningEffort | null,
): Promise<TextBackendSettingsResponse> {
  return requestJson<TextBackendSettingsResponse>(
    `/prompts/settings/text-backends/${encodeURIComponent(workload)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(effort === undefined ? { backend } : { backend, effort }),
    },
  );
}
