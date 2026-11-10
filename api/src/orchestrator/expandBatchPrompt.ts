import { H3_IMAGE_ENHANCE_SYSTEM_PROMPT } from '../prompts/enhanceSystemPrompt';
import { promptNeedsExpansionForModel } from '../prompts/promptBudget';
import { promptRewriteTimeoutMs } from '../providers/text/textBudgets';
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
 * Fail-open at every step like condensation; a result that does not have
 * strictly more words than the input is rejected as `not-longer`. Logs
 * `h3_image_prompt_expanded` / `h3_image_prompt_expand_skipped` with word
 * counts only.
 */
export function expandBatchPrompt(
  prompt: string,
  modelId: string,
  deps: RewriteDeps,
): Promise<string> {
  if (!deps.config.H3_IMAGE_AUTO_EXPAND || !promptNeedsExpansionForModel(modelId, prompt)) {
    return Promise.resolve(prompt);
  }
  return rewriteBatchPrompt(prompt, modelId, deps, {
    task: 'enhance',
    systemPrompt: H3_IMAGE_ENHANCE_SYSTEM_PROMPT,
    timeoutMs: (profile) => promptRewriteTimeoutMs(profile, deps.config.H3_IMAGE_EXPAND_TIMEOUT_MS),
    accepts: (afterWords, beforeWords) => afterWords > beforeWords,
    rejectReason: 'not-longer',
    skippedEvent: 'h3_image_prompt_expand_skipped',
    skippedMessage: 'H3 Image prompt expansion skipped',
    doneEvent: 'h3_image_prompt_expanded',
    doneMessage: 'H3 Image prompt expanded',
  });
}
