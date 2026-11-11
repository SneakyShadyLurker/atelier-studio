import type { EnhancePromptRequest, Model } from '@atelier/shared';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { ApiError, apiFetch, extractApiError, responseRequestId } from './client';
import { parseEnhanceStream } from './sse';
import { classifyQueueFull, delay, MAX_QUEUE_FULL_RETRIES, QueueFullError } from './queueFullRetry';

/** Why a prompt goes through `/enhance-prompt`: a model's trained format, or an Enhance press. */
export type PromptRewritePurpose = NonNullable<Model['promptFormat']> | 'enhance';

const PURPOSE_NOUN: Record<PromptRewritePurpose, string> = {
  'h3-motion': 'motion prompt',
  enhance: 'enhanced prompt',
};

// Rewrites a FINAL resolved prompt via `/enhance-prompt` (the server picks the
// model-specific system prompt from `modelId`). Used by the submit chokepoint
// for models that declare `Model.promptFormat` and for Enhance presses, which
// generate from the rewrite and never show it in the composer.
//
// Mirrors resolveAiFill's transport semantics: bounded retry on QUEUE_FULL
// 429s (no pool slot was acquired, so retrying cannot double-bill); never
// reconnect after the stream opens (the upstream LLM call has started). A
// stream with no text is a failure, and so is an Enhance stream that ends
// without `done`.
export async function formatPromptForModel(
  request: EnhancePromptRequest,
  purpose: PromptRewritePurpose,
  signal?: AbortSignal,
): Promise<string> {
  const noun = PURPOSE_NOUN[purpose];
  const init: RequestInit = {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  };
  if (signal) init.signal = signal;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const res = await apiFetch('/enhance-prompt', init);

    if (res.status === 429) {
      const backoffMs = await classifyQueueFull(res);
      if (backoffMs !== null) {
        if (attempt < MAX_QUEUE_FULL_RETRIES) {
          await delay(backoffMs, signal);
          continue;
        }
        throw new QueueFullError(backoffMs);
      }
      throw new ApiError(429, `${noun} request failed`, undefined, responseRequestId(res));
    }

    const reqId = responseRequestId(res);
    if (!res.ok) {
      const details = await extractApiError(res, `${noun} request failed`);
      throw new ApiError(res.status, details.message, details.body, reqId);
    }
    if (!res.body) throw new ApiError(res.status, `${noun} response did not include a stream`, undefined, reqId);

    let acc = '';
    let completed = false;
    // `error` frames throw from the parser (including QuotaExhaustedError for
    // quota-exhausted terminals); `done` ends the stream.
    for await (const event of parseEnhanceStream(res.body)) {
      if (event.event === 'delta') acc += event.data.text;
      else {
        completed = true;
        break;
      }
    }
    // An Enhance rewrite cut short must not fire as if it were whole. The
    // motion format keeps what arrived, as it always has.
    if (!completed && purpose === 'enhance') {
      signal?.throwIfAborted();
      throw new ApiError(res.status, `${noun} stream ended before it finished`, undefined, reqId);
    }
    const formatted = acc.trim();
    if (formatted.length === 0) {
      throw new ApiError(res.status, `${noun} stream ended without content`, undefined, reqId);
    }
    if (formatted.length > MAX_PROMPT_CHARS) {
      throw new ApiError(res.status, `${noun} exceeded length cap`, undefined, reqId);
    }
    return formatted;
  }
}
