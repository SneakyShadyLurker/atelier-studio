import type {
  ConflictingPair,
  LibraryDiagnosisEntry,
  LibraryDiagnosisResponse,
} from '@atelier/shared';
import { DIAGNOSIS_VERSION, DIAGNOSIS_VERSION_HEADER } from '@atelier/shared';
import { ConflictingPairSchema, LibraryDiagnosisEntrySchema, LibraryDiagnosisResponseSchema } from '@atelier/shared/wire-schemas';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, apiFetch, extractApiError, responseRequestId } from './client';

export const libraryDiagnosisKeys = {
  all: () => ['libraryDiagnosis'] as const,
  current: () => [...libraryDiagnosisKeys.all(), 'current'] as const,
};

export const libraryDiagnosisOpts = (enabled = true) =>
  queryOptions({
    queryKey: libraryDiagnosisKeys.current(),
    queryFn: ({ signal }) => fetchLibraryDiagnosis(signal),
    enabled,
    staleTime: 30_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && !error.retryable) return false;
      return failureCount < 2;
    },
  });

async function fetchLibraryDiagnosis(signal?: AbortSignal): Promise<LibraryDiagnosisResponse> {
  const init: RequestInit = {
    method: 'POST',
    headers: { Accept: 'application/json', [DIAGNOSIS_VERSION_HEADER]: DIAGNOSIS_VERSION },
  };
  if (signal) init.signal = signal;
  const res = await apiFetch('/prompts/library-diagnosis', init);
  const reqId = responseRequestId(res);
  if (!res.ok) {
    const details = await extractApiError(res, 'library-diagnosis failed');
    throw new ApiError(res.status, details.message, details.body, reqId);
  }
  const payload = (await res.json()) as unknown;
  if (!isLibraryDiagnosisResponse(payload)) {
    throw new ApiError(res.status, 'invalid library-diagnosis response shape', undefined, reqId);
  }
  return payload;
}

export function isConflictingPair(value: unknown): value is ConflictingPair {
  return ConflictingPairSchema.safeParse(value).success;
}

export function isLibraryDiagnosisEntry(value: unknown): value is LibraryDiagnosisEntry {
  return LibraryDiagnosisEntrySchema.safeParse(value).success;
}

export function isLibraryDiagnosisResponse(value: unknown): value is LibraryDiagnosisResponse {
  return LibraryDiagnosisResponseSchema.safeParse(value).success;
}
