import type { Context } from 'hono';
import { RETRY_AFTER_FIELD } from '@atelier/shared';
import type { ApiErrorCode } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import type { LlmAdmissionPool } from '../orchestrator/llmAdmission';
import { sseHeaders } from './sse';
import { createLlmSseStream } from './llm-sse';
import type { LlmSseContext } from './llm-sse';

/** The SSE stream an admitted LLM request opens. */
export interface LlmStreamPlan {
  readonly timeoutMs: number;
  /** Client-disconnect signal forwarded to the SSE lifecycle. */
  readonly disconnect: AbortSignal;
  readonly run: (ctx: LlmSseContext) => Promise<void>;
}

/**
 * Single owner of the LLM admission-slot lifecycle for every LLM SSE route:
 * acquire a slot from `pool`, emit the QUEUE_FULL 429 (with a
 * `retryAfterSeconds` hint) if it is saturated, otherwise call `open` while
 * the slot is held. `open` may answer early with a Response (pre-stream
 * validation) or throw; either way the slot is released before returning.
 * When it returns a plan, the slot is released exactly once in the stream
 * body's finally, or here if stream construction throws before the body
 * runs. (The slot's own release() is idempotent; this keeps the leak-guard
 * contract in one place.)
 */
export function withLlmSlot(
  c: Context<AppEnv>,
  pool: LlmAdmissionPool,
  userId: string,
  retryAfterSeconds: number,
  open: () => Response | LlmStreamPlan,
): Response {
  const slot = pool.acquire(userId);
  if (!slot.ok) {
    return c.json(
      {
        error: 'queue full',
        code: 'QUEUE_FULL' satisfies ApiErrorCode,
        reason: slot.reason,
        [RETRY_AFTER_FIELD]: retryAfterSeconds,
      },
      429,
    );
  }
  let streamOwnsSlot = false;
  try {
    const plan = open();
    if (plan instanceof Response) return plan;
    const stream = createLlmSseStream({ timeoutMs: plan.timeoutMs, disconnect: plan.disconnect }, async (ctx) => {
      try {
        await plan.run(ctx);
      } finally {
        slot.release();
      }
    });
    streamOwnsSlot = true;
    return c.body(stream, 200, sseHeaders());
  } finally {
    if (!streamOwnsSlot) slot.release();
  }
}
