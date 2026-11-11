import { buildCondensePromptSystemPrompt } from '../prompts/condensePromptSystemPrompt';
import {
  countPromptWords,
  KREA_PROMPT_CONDENSE_TRIGGER_WORDS,
  promptWordBudgetForModel,
} from '../prompts/promptBudget';
import { promptRewriteTimeoutMs } from '../providers/text/textBudgets';
import { rewriteBatchPrompt, type RewriteDeps } from './rewriteBatchPrompt';

export type CondenseDeps = RewriteDeps;

/**
 * Condense an over-budget Krea prompt down toward its word budget.
 *
 * Runs in the batch worker, NOT in `POST /api/generate`. It used to sit on the
 * request path, ahead of the 201 that carries the batch id: a 57-120s LLM call
 * in front of a response the client needs immediately. Any proxy between the
 * client and the API cut the connection first: an edge proxy with a ~125s
 * limit killed long dispatches while Atelier went on rendering batches
 * nobody could see. Here the latency overlaps GPU queue time
 * and costs no caller anything, so the pass gets a real budget instead of one
 * squeezed under someone else's proxy timeout.
 *
 * Fail-open at EVERY step: no text model to serve it, refused admission,
 * provider failure, timeout,
 * cancellation, empty output, a refusal, an over-length result, or a result
 * that is not strictly shorter all return the original prompt and log
 * `krea_prompt_condense_skipped`. A condense failure must never fail a batch
 * the user already paid queue time for.
 */
export function condenseBatchPrompt(
  prompt: string,
  modelId: string,
  deps: CondenseDeps,
): Promise<string> {
  const wordBudget = promptWordBudgetForModel(modelId);
  if (wordBudget === null || countPromptWords(prompt) <= KREA_PROMPT_CONDENSE_TRIGGER_WORDS) {
    return Promise.resolve(prompt);
  }
  // Condensation runs only for Krea rows, on the `condense` task's model.
  return rewriteBatchPrompt(prompt, modelId, deps, {
    task: 'condense',
    systemPrompt: buildCondensePromptSystemPrompt(wordBudget),
    timeoutMs: (profile) => promptRewriteTimeoutMs(profile, deps.config.KREA_CONDENSE_TIMEOUT_MS),
    accepts: (afterWords, beforeWords) => afterWords < beforeWords,
    rejectReason: 'not-shorter',
    skippedEvent: 'krea_prompt_condense_skipped',
    skippedMessage: 'Krea prompt condensation skipped',
    doneEvent: 'krea_prompt_condensed',
    doneMessage: 'Krea prompt condensed',
  });
}
