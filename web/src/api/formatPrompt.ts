import type { EnhancePromptRequest, Model } from '@atelier/shared';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { ApiError, apiFetch, extractApiError, responseRequestId } from './client';
import { parseEnhanceStream } from './sse';
import { classifyQueueFull, delay, MAX_QUEUE_FULL_RETRIES, QueueFullError } from './queueFullRetry';

// Converts a FINAL resolved prompt into the selected model's trained prompt
// format via `/enhance-prompt` (the server picks the model-specific system
// prompt from `modelId`). Used by the submit chokepoint for models that
// declare `Model.promptFormat` — not by the interactive Enhance button, which
// streams into the composer instead.
//
// Mirrors resolveAiFill's transport semantics: bounded retry on QUEUE_FULL
// 429s (no pool slot was acquired, so retrying cannot double-bill); never
// reconnect after the stream opens (the upstream LLM call has started).
export async function formatPromptForModel(
  request: EnhancePromptRequest,
  format: NonNullable<Model['promptFormat']>,
  signal?: AbortSignal,
): Promise<string> {
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
      throw new ApiError(429, 'prompt format failed', undefined, responseRequestId(res));
    }

    const reqId = responseRequestId(res);
    if (!res.ok) {
      const details = await extractApiError(res, 'prompt format failed');
      throw new ApiError(res.status, details.message, details.body, reqId);
    }
    if (!res.body) throw new ApiError(res.status, 'prompt format response did not include a stream', undefined, reqId);

    let acc = '';
    // `error` frames throw from the parser (including QuotaExhaustedError for
    // quota-exhausted terminals); `done` ends the stream.
    for await (const event of parseEnhanceStream(res.body)) {
      if (event.event === 'delta') acc += event.data.text;
      else break;
    }
    const formatted = acc.trim();
    if (formatted.length === 0) {
      throw new ApiError(res.status, 'prompt format stream ended without content', undefined, reqId);
    }
    if (formatted.length > MAX_PROMPT_CHARS) {
      throw new ApiError(res.status, 'motion prompt exceeded length cap', undefined, reqId);
    }
    return formatted;
  }
}
