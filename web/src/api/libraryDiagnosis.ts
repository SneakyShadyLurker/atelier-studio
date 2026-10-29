import type {
  ConflictingPair,
  LibraryDiagnosisEntry,
  LibraryDiagnosisResponse,
} from '@atelier/shared';
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
    headers: { Accept: 'application/json' },
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
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { listA?: unknown; listB?: unknown; dimensionName?: unknown };
  return typeof v.listA === 'string' && typeof v.listB === 'string' && typeof v.dimensionName === 'string';
}

export function isLibraryDiagnosisEntry(value: unknown): value is LibraryDiagnosisEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as {
    templateName?: unknown;
    satisfiable?: unknown;
    reason?: unknown;
    conflictingPairs?: unknown;
  };
  if (typeof v.templateName !== 'string') return false;
  if (typeof v.satisfiable !== 'boolean') return false;
  if (v.reason !== undefined && typeof v.reason !== 'string') return false;
  if (v.conflictingPairs !== undefined) {
    if (!Array.isArray(v.conflictingPairs)) return false;
    if (!v.conflictingPairs.every(isConflictingPair)) return false;
  }
  return true;
}

export function isLibraryDiagnosisResponse(value: unknown): value is LibraryDiagnosisResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as {
    templates?: unknown;
    librarySnapshotHash?: unknown;
    templatesDigest?: unknown;
  };
  if (!Array.isArray(v.templates)) return false;
  if (!v.templates.every(isLibraryDiagnosisEntry)) return false;
  if (typeof v.librarySnapshotHash !== 'string') return false;
  if (typeof v.templatesDigest !== 'string') return false;
  return true;
}
