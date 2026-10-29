import type { GenerateRequest } from '@atelier/shared';
import { isRecord } from '../lib/guards';
import { ApiError, apiFetch, extractApiError, responseRequestId } from './client';
import { parseSseStream, type GenerateSseEvent } from './sse';

const STREAM_STALL_MS = 30_000;

function createStallWatchdog(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  rearm: () => void;
  cleanup: () => void;
} {
  const watchdog = new AbortController();
  const linked = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const rearm = () => {
    disarm();
    stallTimer = setTimeout(() => {
      if (!watchdog.signal.aborted) {
        watchdog.abort(new DOMException('stalled', 'AbortError'));
      }
    }, STREAM_STALL_MS);
  };

  return {
    signal: linked,
    rearm,
    cleanup: disarm,
  };
}

export async function* batchEventsStream(batchId: string, signal?: AbortSignal): AsyncGenerator<GenerateSseEvent> {
  const watchdog = createStallWatchdog(signal);
  const init: RequestInit = {
    headers: { Accept: 'text/event-stream' },
    signal: watchdog.signal,
  };
  try {
    watchdog.rearm();
    const response = await apiFetch(`/batches/${batchId}/events`, init);
    watchdog.rearm();
    if (!response.ok) {
      const details = await extractApiError(response, 'generation events failed');
      throw new ApiError(response.status, details.message, details.body, responseRequestId(response));
    }
    // WHATWG §9.2.4 mandates this check for EventSource; we enforce it on the
    // fetch path too so an api regression to JSON/HTML with a 200 (config drift,
    // edge-worker injection, mis-routed proxy) surfaces as a clean error rather
    // than the SSE parser silently chewing noisy bytes.
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new ApiError(response.status, 'unexpected response content-type', undefined, responseRequestId(response));
    }
    if (!response.body) throw new Error('generation response did not include a stream');
    yield* parseSseStream(response.body, { onRead: watchdog.rearm });
  } finally {
    watchdog.cleanup();
  }
}

export interface GenerateAcceptance {
  // True when the server answered an idempotent replay (200 with
  // `replayed: true`): the batch already existed under the request's key, so
  // the request's prompt, model or ratio may not describe it.
  readonly replayed: boolean;
}

export interface GenerateStreamOptions {
  // Fires once the server has accepted (and may bill) the batch: after a valid
  // 201 (or 200 replay) body and BEFORE the events GET, or on the first batch
  // event of a legacy direct SSE response. Local only; never serialized onto
  // the wire.
  readonly onAccepted?: (batchId: string, acceptance: GenerateAcceptance) => void;
}

export async function* generateStream(
  request: GenerateRequest,
  signal?: AbortSignal,
  options: GenerateStreamOptions = {},
): AsyncGenerator<GenerateSseEvent> {
  const watchdog = createStallWatchdog(signal);
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: watchdog.signal,
  };
  try {
    watchdog.rearm();
    const response = await apiFetch('/generate', init);
    watchdog.rearm();
    if (!response.ok) {
      const details = await extractApiError(response, 'generation failed');
      throw new ApiError(response.status, details.message, details.body, responseRequestId(response));
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      if (!response.body) throw new Error('generation response did not include a stream');
      let accepted = false;
      for await (const event of parseSseStream(response.body, { onRead: watchdog.rearm })) {
        if (!accepted && event.event === 'batch') {
          accepted = true;
          options.onAccepted?.(event.data.batchId, { replayed: false });
        }
        yield event;
      }
      return;
    }
    const submitted = await response.json() as unknown;
    if (!isRecord(submitted) || typeof submitted.batchId !== 'string' || submitted.batchId.trim().length === 0) {
      throw new ApiError(
        response.status,
        'invalid generation response shape',
        { code: 'invalid-response-shape' },
        responseRequestId(response),
      );
    }
    watchdog.rearm();
    watchdog.cleanup();
    options.onAccepted?.(submitted.batchId, { replayed: submitted.replayed === true });
    yield* batchEventsStream(submitted.batchId, signal);
  } finally {
    watchdog.cleanup();
  }
}
