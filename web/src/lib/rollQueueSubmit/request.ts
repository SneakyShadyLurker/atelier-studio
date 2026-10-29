import { RETRY_AFTER_FIELD, type ApiErrorCode, type GenerateRequest } from '@atelier/shared';
import type { RollSubmission } from '../../store/atelier';
import { ApiError } from '../../api/client';
import { clampRetryAfterMs } from '../../api/queueFullRetry';
import { apiErrorCode } from '../errorCopy';
import { isRecord } from '../guards';
import { nextSeed } from '../seed';
import type { FireItem } from './types';

// A generate() rejection means a batch was already CREATED (real / billable) iff
// it is a StreamTruncatedError carrying a string batchId — a mid-stream drop after
// the batch row existed. Duck-typed rather than importing StreamTruncatedError as
// a value, because `hooks/useGenerate` is module-mocked in several tests (e.g.
// App.rollQueue) without re-exporting the class; a value import would break those
// mocks. The class sets `name = 'StreamTruncatedError'` and a `batchId` field.
export function batchAlreadyStarted(reason: unknown): boolean {
  return (
    typeof reason === 'object'
    && reason !== null
    && (reason as { name?: unknown }).name === 'StreamTruncatedError'
    && typeof (reason as { batchId?: unknown }).batchId === 'string'
  );
}

// A generate() rejection is QUEUE_FULL backpressure (the per-user queued-batch cap
// at /api/generate) — re-queue the roll and retry — iff it is a 429 carrying the
// QUEUE_FULL wire code. Crucially NOT VIDEO_BUSY, which /api/generate also emits at
// 429 but is a single-flight video guard, not drainable capacity.
export function generateBackpressure(reason: unknown): number | null {
  if (!(reason instanceof ApiError) || reason.status !== 429) return null;
  if (apiErrorCode(reason) !== ('QUEUE_FULL' satisfies ApiErrorCode)) return null;
  const retryAfter = isRecord(reason.body) ? reason.body[RETRY_AFTER_FIELD] : undefined;
  return clampRetryAfterMs(typeof retryAfter === 'number' ? retryAfter : undefined);
}

/**
 * The wire request for one prepared item. `base` is the draft's request;
 * `clampedCount` is its count clamped to the model's per-batch cap.
 *
 * Image seed: random PER generation so spamming Generate on an unchanged prompt
 * yields mild variance — UNLESS the user explicitly locked the seed in the
 * picker (`lockedImageSeed`), in which case reproduce it. This is the
 * server-side image seed (distinct from the picker's token-resolution seed).
 * Without it the server falls back to a FIXED deterministic seed
 * (`(req.seed ?? 1) + tileIndex`), which made every repeat of the same prompt
 * produce byte-identical images.
 */
export function makeGenerateRequest(
  base: GenerateRequest,
  item: FireItem,
  clampedCount: number,
  lockedImageSeed: number | null,
): GenerateRequest {
  const { provenance: _drop, ...rest } = base;
  return {
    ...rest,
    prompt: item.text,
    count: clampedCount,
    // Fresh random seed per fired item when unlocked (so two queued rolls of
    // the same text still differ); the locked seed otherwise.
    seed: lockedImageSeed ?? nextSeed(),
    // For I2V the workflow reads {{motionPrompt}} = params.motionPrompt ?? prompt.
    // base.motionPrompt is the RAW text, so sync it to the (possibly enhanced)
    // item text — otherwise the enhanced prompt never reaches H3.
    ...(base.motionPrompt !== undefined ? { motionPrompt: item.text } : {}),
    ...(item.provenance ? { provenance: item.provenance } : {}),
    idempotencyKey: item.key,
  };
}

/** The wire request for one prepared item under a press's settings. */
export function makeSubmissionRequest(submission: RollSubmission, item: FireItem): GenerateRequest {
  if (submission.prepared) {
    return {
      ...submission.request,
      prompt: item.text,
      idempotencyKey: item.key,
      ...(submission.lockedSeed !== null ? { seed: submission.lockedSeed } : {}),
      ...(item.provenance ? { provenance: item.provenance } : {}),
    };
  }
  return makeGenerateRequest(
    { ...submission.request, prompt: item.text },
    item,
    submission.request.count,
    submission.lockedSeed,
  );
}
