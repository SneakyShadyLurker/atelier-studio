import type { Config } from '../config';
import {
  H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT,
  H3_IMAGE_ENHANCE_SYSTEM_PROMPT,
  MOSS_ENHANCE_SYSTEM_PROMPT,
} from '../prompts/enhanceSystemPrompt';
import { classifyImageModelTarget } from '../prompts/gptImagePhrasing';
import { promptNeedsExpansionForModel } from '../prompts/promptBudget';
import { promptRewriteTimeoutMs } from '../providers/text/textBudgets';
import { downscaleForVision } from '../storage/downscaleForVision';
import { rewriteBatchPrompt, type RewriteDeps } from './rewriteBatchPrompt';

/**
 * Whether queue-time expansion is switched on for this model's family: each
 * family that expands has its own kill-switch, and every other family never
 * expands.
 */
export function promptExpansionEnabled(config: Config, modelId: string): boolean {
  const target = classifyImageModelTarget(modelId);
  if (target === 'h3image') return config.H3_IMAGE_AUTO_EXPAND;
  if (target === 'moss') return config.MOSS_AUTO_EXPAND;
  return false;
}

/**
 * Expand a short MiniMax H3 Image or MOSS Image prompt with the model's own
 * enhance prompt.
 *
 * The opposite direction of `condenseBatchPrompt`, on the same queued
 * preparation path: it runs in the batch worker, never on the request, and
 * resolves the `enhance` task's model, the one the manual Enhance button uses
 * for image targets. Prompts at or above the family's word threshold
 * (`H3_IMAGE_PROMPT_EXPAND_BELOW_WORDS`, `MOSS_PROMPT_EXPAND_BELOW_WORDS`),
 * other models, and a family whose switch is off (`H3_IMAGE_AUTO_EXPAND`,
 * `MOSS_AUTO_EXPAND`) return the prompt untouched without a call.
 *
 * An H3 Image batch with reference pictures is expanded by the reference-edit
 * writer, which needs to see them: `references` are the batch's pictures in
 * order, and the call then requires a vision model. A short prompt that
 * already names a `<Picture N>` is kept as written. MOSS Image takes no
 * pictures, so its expansion never reads them.
 *
 * Fail-open at every step like condensation; a result that does not have
 * strictly more words than the input is rejected as `not-longer`. Logs
 * `h3_image_prompt_expanded` / `h3_image_prompt_expand_skipped` or
 * `moss_prompt_expanded` / `moss_prompt_expand_skipped` with word counts only.
 */
export async function expandBatchPrompt(
  prompt: string,
  modelId: string,
  deps: RewriteDeps,
  references: readonly Uint8Array[] = [],
): Promise<string> {
  if (!promptExpansionEnabled(deps.config, modelId) || !promptNeedsExpansionForModel(modelId, prompt, references.length)) {
    return prompt;
  }
  if (classifyImageModelTarget(modelId) === 'moss') {
    return rewriteBatchPrompt(prompt, modelId, deps, {
      task: 'enhance',
      systemPrompt: MOSS_ENHANCE_SYSTEM_PROMPT,
      timeoutMs: (profile) => promptRewriteTimeoutMs(profile, deps.config.MOSS_EXPAND_TIMEOUT_MS),
      accepts: (afterWords, beforeWords) => afterWords > beforeWords,
      rejectReason: 'not-longer',
      skippedEvent: 'moss_prompt_expand_skipped',
      skippedMessage: 'MOSS prompt expansion skipped',
      doneEvent: 'moss_prompt_expanded',
      doneMessage: 'MOSS prompt expanded',
    });
  }
  let images: Awaited<ReturnType<typeof downscaleForVision>>[];
  try {
    images = await Promise.all(references.map((bytes) => downscaleForVision(bytes, deps.signal)));
  } catch (error) {
    if (deps.signal.aborted) {
      deps.logger.info(
        { event: 'h3_image_prompt_expand_skipped', skipReason: 'batch-canceled' },
        'H3 Image prompt expansion skipped',
      );
      return prompt;
    }
    // An undecodable picture is a fault worth seeing; the error type is
    // content-free, its message is not.
    deps.logger.warn(
      {
        event: 'h3_image_prompt_expand_skipped',
        skipReason: 'reference-unreadable',
        errorType: error instanceof Error ? error.name : typeof error,
      },
      'H3 Image prompt expansion skipped',
    );
    return prompt;
  }
  return rewriteBatchPrompt(prompt, modelId, deps, {
    task: 'enhance',
    systemPrompt: images.length > 0 ? H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT : H3_IMAGE_ENHANCE_SYSTEM_PROMPT,
    images,
    timeoutMs: (profile) => promptRewriteTimeoutMs(profile, deps.config.H3_IMAGE_EXPAND_TIMEOUT_MS),
    accepts: (afterWords, beforeWords) => afterWords > beforeWords,
    rejectReason: 'not-longer',
    skippedEvent: 'h3_image_prompt_expand_skipped',
    skippedMessage: 'H3 Image prompt expansion skipped',
    doneEvent: 'h3_image_prompt_expanded',
    doneMessage: 'H3 Image prompt expanded',
  });
}
