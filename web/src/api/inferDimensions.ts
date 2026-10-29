import type {
  ApplyDimensionsRequest,
  DimensionBundle,
  DimensionChangeBundle,
  InferDimensionsResponse,
  InferPhaseEvent,
  InferProgressEvent,
  LibraryDiagnosisResponse,
  PromptLibraryResponse,
  RescueBundle,
} from '@atelier/shared';
import { ApiError, apiFetch, extractApiError, isPromptLibraryResponse, requestJsonValidated, responseRequestId } from './client';
import { parseTerminalSseError, readSseFrames } from './sse';
import { isBundleCommon, isTemplateConflict } from './bundleGuards';
import { isRecord } from '../lib/guards';

function isDimensionBundle(value: unknown): value is DimensionBundle {
  if (!isBundleCommon(value)) return false;
  return (value.kind === 'create' || value.kind === 'extend' || value.kind === 'merge' || value.kind === 'rename')
    && typeof value.dimensionName === 'string'
    && typeof value.optionCount === 'number'
    && typeof value.listCount === 'number';
}

function isRescueBundle(value: unknown): value is RescueBundle {
  if (!isBundleCommon(value)) return false;
  return value.kind === 'rescue'
    && typeof value.listName === 'string'
    && typeof value.optionValue === 'string'
    && typeof value.templateName === 'string';
}

function isDimensionChangeBundle(value: unknown): value is DimensionChangeBundle {
  return isDimensionBundle(value) || isRescueBundle(value);
}

function isRejectedOp(value: unknown): boolean {
  return isRecord(value) && typeof value.reason === 'string' && typeof value.count === 'number';
}

function isCoherenceWarning(value: unknown): boolean {
  return isRecord(value) && typeof value.templateName === 'string' && typeof value.detail === 'string';
}

function isCoverageWarning(value: unknown): boolean {
  if (!isRecord(value) || typeof value.detail !== 'string') return false;
  if (value.kind === 'orphanTag') {
    return typeof value.dim === 'string' && typeof value.label === 'string';
  }
  if (value.kind === 'lowCoverage') {
    return typeof value.listName === 'string'
      && typeof value.dim === 'string'
      && typeof value.coverage === 'number'
      && typeof value.taggedCount === 'number'
      && typeof value.totalCount === 'number';
  }
  return value.kind === 'missingDimension'
    && typeof value.listName === 'string'
    && typeof value.dim === 'string';
}

export function isInferDimensionsResponse(value: unknown): value is InferDimensionsResponse {
  return isRecord(value)
    && typeof value.proposalId === 'string'
    && typeof value.baseSnapshotHash === 'string'
    && isRecord(value.proposal)
    && Array.isArray(value.proposal.bundles)
    && value.proposal.bundles.every(isDimensionChangeBundle)
    && Array.isArray(value.warnings)
    && value.warnings.every(isCoherenceWarning)
    && Array.isArray(value.coverage)
    && value.coverage.every(isCoverageWarning)
    && Array.isArray(value.rejected)
    && value.rejected.every(isRejectedOp)
    && Array.isArray(value.conflicts)
    && value.conflicts.every(isTemplateConflict)
    && (value.notices === undefined || (Array.isArray(value.notices) && value.notices.every((n) => typeof n === 'string')));
}

export interface InferProgressNotification {
  readonly phase: InferPhaseEvent['phase'];
  readonly progress?: InferProgressEvent;
}

function isInferPhaseEvent(value: unknown): value is InferPhaseEvent {
  return isRecord(value)
    && (
      value.phase === 'taxonomy' ||
      value.phase === 'chunks' ||
      value.phase === 'retry-gaps' ||
      value.phase === 'finalize'
    );
}

function isInferProgressEvent(value: unknown): value is InferProgressEvent {
  return isRecord(value)
    && typeof value.done === 'number'
    && typeof value.total === 'number'
    && (value.wave === 1 || value.wave === 2);
}

export interface InferDimensionsOpts {
  readonly modelId?: string;
  readonly priorDiagnosis?: LibraryDiagnosisResponse;
  readonly signal?: AbortSignal;
  readonly onProgress?: (notification: InferProgressNotification) => void;
}

// /infer streams its result via SSE: a long upstream LLM call exceeds
// Cloudflare's ~100s edge timeout for a single JSON response; the route
// emits 15s :keepalive frames and ONE terminal `done` (with the
// InferDimensionsResponse payload) or `error` (with a safe message).
// The fetch resolves when the server closes the stream.
export async function inferDimensions(
  signal?: AbortSignal,
  onProgress?: (notification: InferProgressNotification) => void,
  opts?: InferDimensionsOpts,
): Promise<InferDimensionsResponse> {
  const effectiveSignal = opts?.signal ?? signal;
  const effectiveOnProgress = opts?.onProgress ?? onProgress;
  // Do not auto-reconnect /infer streams: the server only creates proposalId
  // on the terminal done frame, so a retry after a drop would start a new LLM
  // call with no resume token and could bill again without clear user intent.
  // priorDiagnosis is accepted in opts for API compat but no longer sent —
  // the server unconditionally recomputes from its own DB (prompt-injection
  // vector closed). Only the optional image context
  // is sent. Calls without that context retain the empty-body contract.
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
    },
  };
  if (opts?.modelId) {
    init.headers = { Accept: 'text/event-stream', 'Content-Type': 'application/json' };
    init.body = JSON.stringify({ modelId: opts.modelId });
  }
  if (effectiveSignal) init.signal = effectiveSignal;
  const res = await apiFetch('/prompts/dimensions/infer', init);
  const reqId = responseRequestId(res);
  if (!res.ok) {
    const details = await extractApiError(res, 'infer failed');
    throw new ApiError(res.status, details.message, details.body, reqId);
  }
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    throw new ApiError(res.status, 'unexpected response content-type', undefined, reqId);
  }
  if (!res.body) throw new ApiError(res.status, 'infer response did not include a stream', undefined, reqId);
  let currentPhase: InferPhaseEvent['phase'] | null = null;
  for await (const frame of readSseFrames(res.body)) {
    if (frame.event === 'infer-phase') {
      let payload: unknown;
      try {
        payload = JSON.parse(frame.data) as unknown;
      } catch {
        continue;
      }
      if (isInferPhaseEvent(payload)) {
        currentPhase = payload.phase;
        effectiveOnProgress?.({ phase: currentPhase });
      }
      continue;
    }
    if (frame.event === 'infer-progress') {
      if (currentPhase === null) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(frame.data) as unknown;
      } catch {
        continue;
      }
      if (isInferProgressEvent(payload)) {
        effectiveOnProgress?.({ phase: currentPhase, progress: payload });
      }
      continue;
    }
    if (frame.event === 'done') {
      const payload = JSON.parse(frame.data) as unknown;
      if (isInferDimensionsResponse(payload)) return payload;
      throw new ApiError(res.status, 'invalid done SSE payload', undefined, reqId);
    }
    if (frame.event === 'error') {
      throw parseTerminalSseError(frame.data);
    }
  }
  throw new ApiError(res.status, 'infer stream ended without a terminal event', undefined, reqId);
}

// `overrideCoherence` is intentionally stripped at the client boundary even
// if a caller still threads it through — the server compat shim accepts it
// for one deploy but the client owns the new contract per Task 15.
export async function applyDimensions(
  req: ApplyDimensionsRequest,
  signal?: AbortSignal,
): Promise<PromptLibraryResponse> {
  const body: ApplyDimensionsRequest = {
    proposalId: req.proposalId,
    acceptedBundleKeys: req.acceptedBundleKeys,
    acceptUnsatisfiableTemplates: req.acceptUnsatisfiableTemplates ?? [],
  };
  return requestJsonValidated('/prompts/dimensions/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  }, isPromptLibraryResponse);
}
