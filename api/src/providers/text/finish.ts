import type { LanguageModelV4FinishReason } from '@ai-sdk/provider';
import { PermanentUpstreamError, TransientUpstreamError } from '../../lifecycle/resilient-call';

// The terminal rule for one text call. Only a natural stop completes
// unconstrained text; truncation, filtering and tool calls are terminal
// failures. Capacity failures and streams that end without a terminal stay
// retryable before callers expose any content.

type FailedFinish = Exclude<LanguageModelV4FinishReason['unified'], 'stop' | 'interrupted'>;

/** The model finished for a reason other than a natural stop. */
export class TextFinishError extends PermanentUpstreamError {
  constructor(readonly reason: FailedFinish, readonly raw: string | undefined) {
    // The raw wording ('content_filter') is the detail downstream matches on.
    super('in-stream', raw ?? reason, raw ?? reason);
  }
}

export function incompleteTextStream(): TransientUpstreamError {
  return new TransientUpstreamError('socket', null, 'stream ended without successful terminal');
}

/**
 * Null when the call completed; otherwise the error to throw. Takes the
 * stream's `finish` part (undefined when the stream ended without one) or a
 * `doGenerate` result, which carry the same `finishReason`.
 */
export function classifyFinish(
  terminal: { readonly finishReason: LanguageModelV4FinishReason } | undefined,
): Error | null {
  if (terminal === undefined) return incompleteTextStream();
  const { unified, raw } = terminal.finishReason;
  if (unified === 'stop') return null;
  if (raw === 'insufficient_system_resource') {
    return new TransientUpstreamError('socket', raw, raw);
  }
  if (unified === 'interrupted') return incompleteTextStream();
  return new TextFinishError(unified, raw);
}
