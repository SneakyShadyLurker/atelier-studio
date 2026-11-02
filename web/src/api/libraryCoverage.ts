import type {
  CoverageLowList,
  CoverageMissingDimension,
  CoverageOrphanTag,
  CoverageUntaggedGroup,
  LibraryCoverageResponse,
} from '@atelier/shared';
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

function isUntaggedGroup(v: unknown): v is CoverageUntaggedGroup {
  if (typeof v !== 'object' || v === null) return false;
  const g = v as { listId?: unknown; listName?: unknown; dim?: unknown; untaggedCount?: unknown };
  return typeof g.listId === 'string' && typeof g.listName === 'string'
    && typeof g.dim === 'string' && typeof g.untaggedCount === 'number';
}

function isLowList(v: unknown): v is CoverageLowList {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as { listName?: unknown; dim?: unknown; coverage?: unknown; taggedCount?: unknown; totalCount?: unknown };
  return typeof l.listName === 'string' && typeof l.dim === 'string'
    && typeof l.coverage === 'number' && typeof l.taggedCount === 'number' && typeof l.totalCount === 'number';
}

function isOrphanTag(v: unknown): v is CoverageOrphanTag {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { dim?: unknown; label?: unknown };
  return typeof o.dim === 'string' && typeof o.label === 'string';
}

function isMissingDimension(v: unknown): v is CoverageMissingDimension {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as { listName?: unknown; dim?: unknown };
  return typeof m.listName === 'string' && typeof m.dim === 'string';
}

export function isLibraryCoverageResponse(value: unknown): value is LibraryCoverageResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as {
    untaggedByList?: unknown;
    lowCoverageLists?: unknown;
    orphanTags?: unknown;
    missingDimensions?: unknown;
    librarySnapshotHash?: unknown;
    templatesDigest?: unknown;
  };
  if (!Array.isArray(v.untaggedByList) || !v.untaggedByList.every(isUntaggedGroup)) return false;
  if (!Array.isArray(v.lowCoverageLists) || !v.lowCoverageLists.every(isLowList)) return false;
  if (!Array.isArray(v.orphanTags) || !v.orphanTags.every(isOrphanTag)) return false;
  if (!Array.isArray(v.missingDimensions) || !v.missingDimensions.every(isMissingDimension)) return false;
  if (typeof v.librarySnapshotHash !== 'string') return false;
  if (typeof v.templatesDigest !== 'string') return false;
  return true;
}
