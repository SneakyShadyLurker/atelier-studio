import type {
  AiFillBackend,
  AiFillBatchRequest,
  AiFillBatchSseEvent,
  AiFillRequest,
  AiFillSseEvent,
} from '@atelier/shared';
import { AI_FILL_BACKEND_VALUES } from '@atelier/shared';
import { ApiError, apiFetch, extractApiError, responseRequestId } from './client';
import { consumeSseResult, parseTerminalSseErrorFromData } from './sse';
import { classifyQueueFull, delay, jitterRetryDelayMs, MAX_QUEUE_FULL_RETRIES, QueueFullError } from './queueFullRetry';
import { isRecord, isStringArray } from '../lib/guards';

// Derived from the shared wire union so the client result type can't drift
// from what the api's `result` frame actually carries.
export type AiFillResolved = Extract<AiFillSseEvent, { event: 'result' }>['data'];
export type AiFillBatchResolved = Extract<AiFillBatchSseEvent, { event: 'result' }>['data'];

function isAiFillResult(value: unknown): value is AiFillResolved {
  return isRecord(value)
    && typeof value.prompt === 'string'
    && isStringArray(value.fills);
}

function isAiFillBatchResult(value: unknown): value is AiFillBatchResolved {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  return value.items.every((item) => {
    if (!isRecord(item) || typeof item.ok !== 'boolean') return false;
    if (!item.ok) return true;
    return typeof item.prompt === 'string' && isStringArray(item.fills);
  });
}

function isBackendFrame(value: unknown): value is AiFillBackend {
  return typeof value === 'string' && (AI_FILL_BACKEND_VALUES as readonly string[]).includes(value);
}

// Resolves {{ai-fill}} blanks via the SSE endpoint. The server streams 15s
// :keepalive frames then ONE terminal `result` (the filled prompt) or `error`
// (a safe message). Mirrors inferDimensions: no auto-reconnect on a mid-stream
// drop — the server makes the LLM call before the terminal frame, so reconnecting
// could double-bill.
//
// EXCEPTION: a 429 (QUEUE_FULL) means no pool slot was acquired, so NO LLM call
// was made — retrying is safe and cannot double-bill. We retry it (bounded,
// abortable) so the per-user concurrency cap is transparent: when several fills
// fire at once (multi-submit, or a submit with multiple queued ai-fill rolls),
// the ones past the cap wait and resolve as slots free rather than being dropped.
export async function resolveAiFill(
  req: AiFillRequest,
  signal?: AbortSignal,
  onBackend?: (backend: AiFillBackend) => void,
): Promise<AiFillResolved> {
  const init: RequestInit = {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  };
  if (signal) init.signal = signal;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const res = await apiFetch('/prompts/ai-fill', init);

    if (res.status === 429) {
      // Read the 429 body ONCE to classify by wire code. QUEUE_FULL → backpressure
      // (retry while the budget lasts, then hand a typed QueueFullError to the
      // drain). Any other 429 (defensive — the enhance pool only emits QUEUE_FULL)
      // is a genuine error.
      const backoffMs = await classifyQueueFull(res);
      if (backoffMs !== null) {
        if (attempt < MAX_QUEUE_FULL_RETRIES) {
          await delay(jitterRetryDelayMs(backoffMs), signal);
          continue;
        }
        throw new QueueFullError(backoffMs);
      }
      throw new ApiError(429, 'ai-fill failed', undefined, responseRequestId(res));
    }

    const reqId = responseRequestId(res);
    if (!res.ok) {
      const details = await extractApiError(res, 'ai-fill failed');
      throw new ApiError(res.status, details.message, details.body, reqId);
    }
    if (!res.body) throw new ApiError(res.status, 'ai-fill response did not include a stream', undefined, reqId);
    return consumeSseResult<AiFillResolved>(res.body, res.status, reqId, {
      result: (data) => {
        if (isAiFillResult(data)) return data;
        throw new ApiError(res.status, 'invalid ai-fill result payload', undefined, reqId);
      },
      error: (data) => {
        throw parseTerminalSseErrorFromData(data);
      },
    }, 'ai-fill stream ended without a terminal event', {
      backend: (data) => {
        if (!isRecord(data) || !isBackendFrame(data.backend)) return;
        onBackend?.(data.backend);
      },
    });
  }
}

export async function resolveAiFillBatch(
  req: AiFillBatchRequest,
  signal?: AbortSignal,
  onBackend?: (backend: AiFillBackend) => void,
): Promise<AiFillBatchResolved> {
  const init: RequestInit = {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  };
  if (signal) init.signal = signal;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const res = await apiFetch('/prompts/ai-fill/batch', init);

    if (res.status === 429) {
      const backoffMs = await classifyQueueFull(res);
      if (backoffMs !== null) {
        if (attempt < MAX_QUEUE_FULL_RETRIES) {
          await delay(jitterRetryDelayMs(backoffMs), signal);
          continue;
        }
        throw new QueueFullError(backoffMs);
      }
      throw new ApiError(429, 'ai-fill batch failed', undefined, responseRequestId(res));
    }

    const reqId = responseRequestId(res);
    if (!res.ok) {
      const details = await extractApiError(res, 'ai-fill batch failed');
      throw new ApiError(res.status, details.message, details.body, reqId);
    }
    if (!res.body) throw new ApiError(res.status, 'ai-fill batch response did not include a stream', undefined, reqId);
    return consumeSseResult<AiFillBatchResolved>(res.body, res.status, reqId, {
      result: (data) => {
        if (isAiFillBatchResult(data) && data.items.length === req.items.length) return data;
        throw new ApiError(res.status, 'invalid ai-fill batch result payload', undefined, reqId);
      },
      error: (data) => {
        throw parseTerminalSseErrorFromData(data);
      },
    }, 'ai-fill batch stream ended without a terminal event', {
      backend: (data) => {
        if (!isRecord(data) || !isBackendFrame(data.backend)) return;
        onBackend?.(data.backend);
      },
    });
  }
}
