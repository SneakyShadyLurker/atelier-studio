import { H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT, H3_IMAGE_ENHANCE_SYSTEM_PROMPT } from '../prompts/enhanceSystemPrompt';
import { promptNeedsExpansionForModel } from '../prompts/promptBudget';
import { promptRewriteTimeoutMs } from '../providers/text/textBudgets';
import { downscaleForVision } from '../storage/downscaleForVision';
import { rewriteBatchPrompt, type RewriteDeps } from './rewriteBatchPrompt';

/**
 * Expand a short MiniMax H3 Image prompt with the model's own enhance prompt.
 *
 * The opposite direction of `condenseBatchPrompt`, on the same queued
 * preparation path: it runs in the batch worker, never on the request, and
 * resolves the `enhance` task's model, the one the manual Enhance button uses
 * for image targets. Prompts at or above `H3_IMAGE_PROMPT_EXPAND_BELOW_WORDS`
 * words, other models, and `H3_IMAGE_AUTO_EXPAND=false` return the prompt
 * untouched without a call.
 *
 * A batch with reference pictures is expanded by the reference-edit writer,
 * which needs to see them: `references` are the batch's pictures in order,
 * and the call then requires a vision model. A short prompt that already
 * names a `<Picture N>` is kept as written.
 *
 * Fail-open at every step like condensation; a result that does not have
 * strictly more words than the input is rejected as `not-longer`. Logs
 * `h3_image_prompt_expanded` / `h3_image_prompt_expand_skipped` with word
 * counts only.
 */
export async function expandBatchPrompt(
  prompt: string,
  modelId: string,
  deps: RewriteDeps,
  references: readonly Uint8Array[] = [],
): Promise<string> {
  if (!deps.config.H3_IMAGE_AUTO_EXPAND || !promptNeedsExpansionForModel(modelId, prompt, references.length)) {
    return prompt;
  }
  let images: Awaited<ReturnType<typeof downscaleForVision>>[];
  try {
    images = await Promise.all(references.map((bytes) => downscaleForVision(bytes, deps.signal)));
  } catch {
    deps.logger.info(
      { event: 'h3_image_prompt_expand_skipped', reason: 'reference-unreadable' },
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
