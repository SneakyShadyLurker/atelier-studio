import { RETRY_AFTER_FIELD } from '@atelier/shared';
import type { ApiErrorCode } from '@atelier/shared';
import { isRecord } from '../lib/guards';
import { QuotaExhaustedError } from './sse';

// Bound automatic queue admission retries; untouched work remains saved for
// an explicit Generate/Resume after this idle budget.
export const IDLE_BACKPRESSURE_BUDGET_MS = 8 * 60 * 1000;

// Shared QUEUE_FULL (429) retry plumbing for the enhance-pool SSE endpoints
// (ai-fill, prompt auto-format). A 429 means admission control rejected the
// request BEFORE any pool slot was acquired or LLM call made, so retrying is
// safe and cannot double-bill — unlike mid-stream drops, which are never
// retried.

// A cancellable sleep — settles after `ms`, or rejects immediately if `signal` aborts.
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Typed backpressure signal. Thrown by the enhance-pool transports (ai-fill,
// prompt-format) when a request is rejected by admission control and the bounded
// per-call retry is exhausted. The submit-chokepoint drain treats this as
// "pool busy — keep the roll queued and try again", NEVER as a drop: no slot was
// acquired and no LLM call was made, so the roll is intact and re-firing it is
// safe. Distinct from QuotaExhaustedError (5h budget) and every genuine failure
// (refusal, invalid output), which keeps the roll in the queue but skips it for
// the rest of the drain; only an over-length prompt drops.
export class QueueFullError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = 'queue full — at capacity') {
    super(message);
    this.name = 'QueueFullError';
    this.retryAfterMs = retryAfterMs;
  }
}

// Clamp the server's retry_after_seconds hint to a snappy window — fills are
// seconds-long, so a pool slot frees quickly. Exported for the drain loop's
// inter-pass backoff.
export function clampRetryAfterMs(retryAfterSeconds: number | undefined): number {
  const secs = typeof retryAfterSeconds === 'number' ? retryAfterSeconds : 1;
  return Math.min(3000, Math.max(800, secs * 1000));
}

// Spread simultaneous retries across the server hint window so one freed slot
// does not wake every waiting client at once.
export function jitterRetryDelayMs(delayMs: number, random = Math.random): number {
  return Math.max(0, Math.round(delayMs * (0.8 + random() * 0.4)));
}

export function nextBackpressureDelayMs(
  previousDelayMs: number,
  serverHintMs: number,
  madeProgress: boolean,
): number {
  const baseMs = Math.max(serverHintMs, 1000);
  if (madeProgress || previousDelayMs === 0) return Math.min(15_000, baseMs);
  return Math.min(15_000, Math.max(baseMs, previousDelayMs * 2));
}

// Classifies a 429 by its WIRE code, reading the body exactly ONCE. Returns the
// clamped retry delay for a genuine QUEUE_FULL admission rejection, throws the
// typed quota signal for QUOTA_EXHAUSTED, or returns null for any other 429
// (e.g. VIDEO_BUSY). Status alone is too coarse.
export async function classifyQueueFull(res: Response): Promise<number | null> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Body unreadable (e.g. an HTML 429 from an edge proxy / auth layer / upstream
    // rate limiter, not our typed envelope). NOT drain backpressure — treat it as a
    // genuine failure so it surfaces instead of retrying forever.
    return null;
  }
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
  if (code === ('QUOTA_EXHAUSTED' satisfies ApiErrorCode)) {
    const retryAfter = isRecord(body) && typeof body[RETRY_AFTER_FIELD] === 'number'
      ? body[RETRY_AFTER_FIELD]
      : null;
    throw new QuotaExhaustedError(retryAfter);
  }
  if (code !== ('QUEUE_FULL' satisfies ApiErrorCode)) return null;
  const retryAfter = isRecord(body) && typeof body[RETRY_AFTER_FIELD] === 'number' ? body[RETRY_AFTER_FIELD] : undefined;
  return clampRetryAfterMs(retryAfter);
}

// Cap on per-call QUEUE_FULL retries. With the single-owner drain handling the
// long tail of backpressure, this only smooths brief sub-slot waits before the
// call hands a QueueFullError back to the drain, which re-queues and re-passes.
export const MAX_QUEUE_FULL_RETRIES = 12;
