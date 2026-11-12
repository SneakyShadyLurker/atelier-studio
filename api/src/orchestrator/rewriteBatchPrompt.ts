import { MAX_PROMPT_CHARS, type TextLatencyProfile, type TextTask } from '@atelier/shared';
import type { Config } from '../config';
import type { AppLogger } from '../observability/logger';
import { isLikelyModelRefusal } from '../prompts/modelOutput';
import { countPromptWords } from '../prompts/promptBudget';
import type { EnhanceImageInput, TextCallFailure } from '../providers/text/featureHelpers';
import { imageModelRouting, textProviderForResolved } from '../providers/textRouting';
import type { ResolvedTextModel, ResolveTextModelInput } from '../routing/textModelResolver';
import type { TextServices } from '../routing/textServices';
import { enhancePool } from './llmAdmission';

/** Dependencies of a queued prompt rewrite (Krea condense, H3 Image or MOSS expand). */
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

export type RewriteRejection = 'empty' | 'refusal' | 'over-char-limit';

export type RewriteCheck =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: RewriteRejection };

/**
 * The one validation of a finished rewrite, shared by queued rewrites, story
 * segment writing and the enhance route: empty output, refusal prose and a
 * result over MAX_PROMPT_CHARS never reach an image or video model.
 */
export function validateRewrite(raw: string): RewriteCheck {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (isLikelyModelRefusal(text)) return { ok: false, reason: 'refusal' };
  if (text.length > MAX_PROMPT_CHARS) return { ok: false, reason: 'over-char-limit' };
  return { ok: true, text };
}

/** One rewrite through the shared core: what to write and how long it may take. */
export interface TextRewriteRequest {
  readonly task: TextTask;
  readonly prompt: string;
  readonly systemPrompt: string;
  /** Pictures the writer must see; a non-empty list requires a vision model. */
  readonly images: readonly EnhanceImageInput[];
  /** Image model the text is written for; selects a prompt writer. */
  readonly routing?: Pick<ResolveTextModelInput, 'imageModelId'>;
  readonly maxOutputTokens?: number;
  /** Deadline of the text call alone, from the resolved model's profile. */
  readonly timeoutMs: (latencyProfile: TextLatencyProfile) => number;
}

/**
 * Evidence of a skip that points at a fault rather than an expected outcome.
 * Content-free: a failure kind, an HTTP status and an error type, never
 * upstream text.
 */
export interface RewriteFault {
  readonly failureKind?: TextCallFailure['kind'];
  readonly status?: number | null;
  readonly errorType?: string;
}

export type TextRewriteOutcome =
  | { readonly type: 'ok'; readonly text: string; readonly textModelId: string }
  | {
      readonly type: 'skipped';
      readonly skipReason: string;
      readonly textModelId?: string;
      readonly afterWords?: number;
      /** Set for a provider failure or an unexpected error; those log at warn. */
      readonly fault?: RewriteFault;
    };

function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The rewrite core: resolve the task's model, take an enhance-pool slot, run
 * the accumulating `rewrite()` under the model's deadline and validate the
 * result. Never throws; every way the rewrite can fall short is a `skipped`
 * outcome the caller logs and answers with its original text.
 */
export async function runTextRewrite(deps: RewriteDeps, request: TextRewriteRequest): Promise<TextRewriteOutcome> {
  // Resolved before the timer so the deadline follows the model.
  let resolved: ResolvedTextModel;
  try {
    resolved = deps.text.resolve({
      userId: deps.userId,
      task: request.task,
      ...request.routing,
      ...(request.images.length > 0 ? { visionRequired: true } : {}),
    });
  } catch (error) {
    return { type: 'skipped', skipReason: 'error', fault: { errorType: errorTypeOf(error) } };
  }
  if (!resolved.ok) return { type: 'skipped', skipReason: `text-model-${resolved.reason}` };
  const textModel = resolved.model;
  const textModelId = textModel.id;
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs(textModel.latencyProfile));
  const signal = AbortSignal.any([deps.signal, timeoutSignal]);
  const slot = enhancePool.acquire(deps.userId);
  if (!slot.ok) return { type: 'skipped', skipReason: `admission-${slot.reason}`, textModelId };

  try {
    const provider = textProviderForResolved(deps.config, deps.text, textModel);
    const result = await provider.rewrite({
      prompt: request.prompt,
      images: request.images,
      systemPrompt: request.systemPrompt,
      ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
      ...(resolved.effort === undefined ? {} : { reasoningEffort: resolved.effort }),
    }, signal);
    if (timeoutSignal.aborted) return { type: 'skipped', skipReason: 'timeout', textModelId };
    if (deps.signal.aborted) return { type: 'skipped', skipReason: 'batch-canceled', textModelId };
    if (result.type === 'failed') {
      return {
        type: 'skipped',
        skipReason: 'provider-failed',
        textModelId,
        fault: { failureKind: result.kind, status: result.status },
      };
    }
    const checked = validateRewrite(result.text);
    if (!checked.ok) {
      return {
        type: 'skipped',
        skipReason: checked.reason,
        textModelId,
        ...(checked.reason === 'over-char-limit' ? { afterWords: countPromptWords(result.text) } : {}),
      };
    }
    return { type: 'ok', text: checked.text, textModelId };
  } catch (error) {
    if (timeoutSignal.aborted) return { type: 'skipped', skipReason: 'timeout', textModelId };
    if (deps.signal.aborted) return { type: 'skipped', skipReason: 'batch-canceled', textModelId };
    return { type: 'skipped', skipReason: 'error', textModelId, fault: { errorType: errorTypeOf(error) } };
  } finally {
    slot.release();
  }
}

/**
 * Run one queued prompt rewrite and validate it. Fail-open at every step:
 * no text model, refused admission, provider failure, timeout, cancellation,
 * empty output, a refusal, an over-length result or one `spec.accepts`
 * rejects all return the original prompt and log `spec.skippedEvent`. A
 * provider failure or an unexpected error logs at warn so a persistent
 * upstream fault is visible; expected skips log at info. Logs carry word
 * counts and content-free fault fields only, never prompt or upstream text.
 */
export async function rewriteBatchPrompt(
  prompt: string,
  modelId: string,
  deps: RewriteDeps,
  spec: RewriteSpec,
): Promise<string> {
  const beforeWords = countPromptWords(prompt);
  // `skipReason`, not `reason`: the production log formatter redacts a key
  // named `reason`. `skipReason` and `textModelId` are on its operational
  // allowlist, so both survive.
  const skip = (outcome: Extract<TextRewriteOutcome, { type: 'skipped' }>): string => {
    const fields = {
      event: spec.skippedEvent,
      skipReason: outcome.skipReason,
      beforeWords,
      ...(outcome.afterWords === undefined ? {} : { afterWords: outcome.afterWords }),
      ...(outcome.textModelId === undefined ? {} : { textModelId: outcome.textModelId }),
      ...outcome.fault,
    };
    if (outcome.fault) deps.logger.warn(fields, spec.skippedMessage);
    else deps.logger.info(fields, spec.skippedMessage);
    return prompt;
  };
  const outcome = await runTextRewrite(deps, {
    task: spec.task,
    prompt,
    systemPrompt: spec.systemPrompt,
    images: spec.images ?? [],
    routing: imageModelRouting(deps.config, modelId),
    timeoutMs: spec.timeoutMs,
  });
  if (outcome.type === 'skipped') return skip(outcome);
  const afterWords = countPromptWords(outcome.text);
  if (!spec.accepts(afterWords, beforeWords)) {
    return skip({ type: 'skipped', skipReason: spec.rejectReason, afterWords, textModelId: outcome.textModelId });
  }
  deps.logger.info({ event: spec.doneEvent, beforeWords, afterWords }, spec.doneMessage);
  return outcome.text;
}
