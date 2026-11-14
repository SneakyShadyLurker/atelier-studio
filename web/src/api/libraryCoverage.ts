import type { LibraryCoverageResponse } from '@atelier/shared';
import { LibraryCoverageResponseSchema } from '@atelier/shared/wire-schemas';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, apiFetch, extractApiError, responseRequestId } from './client';

export const libraryCoverageKeys = {
  all: () => ['libraryCoverage'] as const,
  current: () => [...libraryCoverageKeys.all(), 'current'] as const,
};

export const libraryCoverageOpts = (enabled = true) =>
  queryOptions({
    queryKey: libraryCoverageKeys.current(),
    queryFn: ({ signal }) => fetchLibraryCoverage(signal),
    enabled,
    staleTime: 30_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && !error.retryable) return false;
      return failureCount < 2;
    },
  });

async function fetchLibraryCoverage(signal?: AbortSignal): Promise<LibraryCoverageResponse> {
  const init: RequestInit = { method: 'POST', headers: { Accept: 'application/json' } };
  if (signal) init.signal = signal;
  const res = await apiFetch('/prompts/library-coverage', init);
  const reqId = responseRequestId(res);
  if (!res.ok) {
    const details = await extractApiError(res, 'library-coverage failed');
    throw new ApiError(res.status, details.message, details.body, reqId);
  }
  const payload = (await res.json()) as unknown;
  if (!isLibraryCoverageResponse(payload)) {
    throw new ApiError(res.status, 'invalid library-coverage response shape', undefined, reqId);
  }
  return payload;
}

export function isLibraryCoverageResponse(value: unknown): value is LibraryCoverageResponse {
  return LibraryCoverageResponseSchema.safeParse(value).success;
}
