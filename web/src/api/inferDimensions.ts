import type {
  ApplyDimensionsRequest,
  InferDimensionsResponse,
  InferPhaseEvent,
  InferProgressEvent,
  PromptLibraryResponse,
} from '@atelier/shared';
import {
  InferDimensionsResponseSchema,
  InferPhaseEventSchema,
  InferProgressEventSchema,
} from '@atelier/shared/prompt-tool-schemas';
import { ApiError, apiFetch, extractApiError, isPromptLibraryResponse, requestJsonValidated, responseRequestId } from './client';
import { parseTerminalSseError, readSseFrames } from './sse';

export function isInferDimensionsResponse(value: unknown): value is InferDimensionsResponse {
  return InferDimensionsResponseSchema.safeParse(value).success;
}

export interface InferProgressNotification {
  readonly phase: InferPhaseEvent['phase'];
  readonly progress?: InferProgressEvent;
}

function isInferPhaseEvent(value: unknown): value is InferPhaseEvent {
  return InferPhaseEventSchema.safeParse(value).success;
}

function isInferProgressEvent(value: unknown): value is InferProgressEvent {
  return InferProgressEventSchema.safeParse(value).success;
}

export interface InferDimensionsOpts {
  readonly modelId?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (notification: InferProgressNotification) => void;
}

// /infer streams its result via SSE: a long upstream LLM call exceeds
// Cloudflare's ~100s edge timeout for a single JSON response; the route
// emits 15s :keepalive frames and ONE terminal `done` (with the
// InferDimensionsResponse payload) or `error` (with a safe message).
// The fetch resolves when the server closes the stream.
export async function inferDimensions(opts: InferDimensionsOpts = {}): Promise<InferDimensionsResponse> {
  const { signal, onProgress } = opts;
  // Do not auto-reconnect /infer streams: the server only creates proposalId
  // on the terminal done frame, so a retry after a drop would start a new LLM
  // call with no resume token and could bill again without clear user intent.
  // The server recomputes the prior diagnosis from its own DB, so only the
  // optional image context is sent. Calls without that context retain the
  // empty-body contract.
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
    },
  };
  if (opts.modelId) {
    init.headers = { Accept: 'text/event-stream', 'Content-Type': 'application/json' };
    init.body = JSON.stringify({ modelId: opts.modelId });
  }
  if (signal) init.signal = signal;
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
        onProgress?.({ phase: currentPhase });
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
        onProgress?.({ phase: currentPhase, progress: payload });
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
