import type { DiagnoseSelectionRequest, DiagnoseSelectionResponse } from '@atelier/shared';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { isTemplateConflict } from './bundleGuards';
import { ApiError, apiFetch, extractApiError, responseRequestId } from './client';

function isDiagnoseSelectionResponse(value: unknown): value is DiagnoseSelectionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { conflicts?: unknown };
  return Array.isArray(v.conflicts) && v.conflicts.every(isTemplateConflict);
}

// Live SAT recheck against the user's current bundle selection.
// Server-side counterpart: api/src/routes/prompts/diagnoseSelection.ts.
//
// Plain JSON, no SSE — the SAT walk is in-process and fast (no LLM call).
// We bypass the shared `requestJson` helper so we can validate the response
// shape via `isTemplateConflict` (matches the strictness of the infer-time
// response validation rather than trusting an opaque cast).
export async function diagnoseSelection(
  body: DiagnoseSelectionRequest,
  signal?: AbortSignal,
): Promise<DiagnoseSelectionResponse> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  const res = await apiFetch('/prompts/dimensions/diagnose-selection', init);
  const reqId = responseRequestId(res);
  if (!res.ok) {
    const details = await extractApiError(res, 'diagnose-selection failed');
    throw new ApiError(res.status, details.message, details.body, reqId);
  }
  const payload = await res.json() as unknown;
  if (!isDiagnoseSelectionResponse(payload)) {
    throw new ApiError(res.status, 'invalid diagnose-selection response shape', undefined, reqId);
  }
  return payload;
}

const diagnoseSelectionKeys = {
  all: () => ['dim-diagnose'] as const,
  detail: (proposalId: string, acceptedBundleKeys: readonly string[]) =>
    [...diagnoseSelectionKeys.all(), proposalId, acceptedBundleKeys] as const,
};

export function diagnoseSelectionOpts(
  proposalId: string,
  acceptedBundleKeys: readonly string[],
  enabled: boolean,
) {
  return queryOptions({
    queryKey: diagnoseSelectionKeys.detail(proposalId, acceptedBundleKeys),
    queryFn: ({ signal }) => diagnoseSelection({ proposalId, acceptedBundleKeys }, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 1_000,
    // No retry — diagnose is a server-side SAT call; if it fails, the user can
    // still hit Apply and fall back to the apply-422 inline controls.
    retry: false,
  });
}
