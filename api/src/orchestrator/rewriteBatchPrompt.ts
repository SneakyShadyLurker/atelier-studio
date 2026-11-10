import { MAX_PROMPT_CHARS, type TextLatencyProfile } from '@atelier/shared';
import type { Config } from '../config';
import type { AppLogger } from '../observability/logger';
import { isLikelyModelRefusal } from '../prompts/modelOutput';
import { countPromptWords } from '../prompts/promptBudget';
import type { EnhanceImageInput } from '../providers/text/featureHelpers';
import { imageModelRouting, textProviderForResolved } from '../providers/textRouting';
import type { ResolvedTextModel } from '../routing/textModelResolver';
import type { TextServices } from '../routing/textServices';
import { enhancePool } from './llmAdmission';

/** Dependencies of a queued prompt rewrite (Krea condense, H3 Image expand). */
export interface RewriteDeps {
  readonly config: Config;
  readonly text: TextServices;
  readonly logger: AppLogger;
  readonly userId: string;
  /** Batch controller signal — user cancel, DELETE /history, SIGTERM drain. */
  readonly signal: AbortSignal;
}

export interface RewriteSpec {
  readonly task: 'condense' | 'enhance';
  readonly systemPrompt: string;
  /** Pictures the writer must see; a non-empty list requires a vision model. */
  readonly images?: readonly EnhanceImageInput[];
  readonly timeoutMs: (latencyProfile: TextLatencyProfile) => number;
  /** Accepts the rewrite's word count against the original's. */
  readonly accepts: (afterWords: number, beforeWords: number) => boolean;
  /** Skip reason logged when `accepts` rejects the rewrite. */
  readonly rejectReason: string;
  readonly skippedEvent: string;
  readonly skippedMessage: string;
  readonly doneEvent: string;
  readonly doneMessage: string;
}

/**
 * Stream one queued prompt rewrite and validate it. Fail-open at every step:
 * no text model, refused admission, provider failure, timeout, cancellation,
 * a truncated stream, empty output, a refusal, an over-length result or one
 * `spec.accepts` rejects all return the original prompt and log
 * `spec.skippedEvent`. Logs carry word counts only, never prompt text.
 */
export async function rewriteBatchPrompt(
  prompt: string,
  modelId: string,
  deps: RewriteDeps,
  spec: RewriteSpec,
): Promise<string> {
  const beforeWords = countPromptWords(prompt);
  const images = spec.images ?? [];
  const skip = (reason: string, afterWords?: number): string => {
    deps.logger.info(
      {
        event: spec.skippedEvent,
        reason,
        beforeWords,
        ...(afterWords === undefined ? {} : { afterWords }),
      },
      spec.skippedMessage,
    );
    return prompt;
  };
  // Resolved before the timer so the deadline follows the model.
  let resolved: ResolvedTextModel;
  try {
    resolved = deps.text.resolve({
      userId: deps.userId,
      task: spec.task,
      ...imageModelRouting(deps.config, modelId),
      ...(images.length > 0 ? { visionRequired: true } : {}),
    });
  } catch {
    return skip('error');
  }
  if (!resolved.ok) return skip(`text-model-${resolved.reason}`);
  const textModel = resolved.model;
  const reasoningEffort = resolved.effort;
  const timeoutSignal = AbortSignal.timeout(spec.timeoutMs(textModel.latencyProfile));
  const signal = AbortSignal.any([deps.signal, timeoutSignal]);
  let releaseEnhanceSlot: (() => void) | null = null;

  try {
    const slot = enhancePool.acquire(deps.userId);
    if (!slot.ok) return skip(`admission-${slot.reason}`);
    releaseEnhanceSlot = () => { slot.release(); };

    const provider = textProviderForResolved(deps.config, deps.text, textModel);
    let rewritten = '';
    let completed = false;

    const enhanceOpts = reasoningEffort === undefined ? {} : { reasoningEffort };

    for await (const chunk of provider.enhance(prompt, [...images], signal, spec.systemPrompt, enhanceOpts)) {
      if (signal.aborted) break;
      if (chunk.type === 'delta') rewritten += chunk.text;
      else if (chunk.type === 'done') completed = true;
      else if (chunk.type === 'failed') return skip('provider-failed');
    }

    if (timeoutSignal.aborted) return skip('timeout');
    if (deps.signal.aborted) return skip('batch-canceled');
    if (!completed) return skip('truncated');

    const candidate = rewritten.trim();
    if (candidate.length === 0) return skip('empty');
    if (isLikelyModelRefusal(candidate)) return skip('refusal');
    const afterWords = countPromptWords(candidate);
    if (candidate.length > MAX_PROMPT_CHARS) return skip('over-char-limit', afterWords);
    if (!spec.accepts(afterWords, beforeWords)) return skip(spec.rejectReason, afterWords);

    deps.logger.info({ event: spec.doneEvent, beforeWords, afterWords }, spec.doneMessage);
    return candidate;
  } catch {
    if (timeoutSignal.aborted) return skip('timeout');
    if (deps.signal.aborted) return skip('batch-canceled');
    return skip('error');
  } finally {
    releaseEnhanceSlot?.();
  }
}
