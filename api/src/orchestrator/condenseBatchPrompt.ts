import type { Database } from 'bun:sqlite';
import { MAX_PROMPT_CHARS, type AiFillBackend, type TextReasoningEffort } from '@atelier/shared';
import type { Config } from '../config';
import type { AppLogger } from '../observability/logger';
import { buildCondensePromptSystemPrompt } from '../prompts/condensePromptSystemPrompt';
import { isLikelyModelRefusal } from '../prompts/modelOutput';
import {
  countPromptWords,
  KREA_PROMPT_CONDENSE_TRIGGER_WORDS,
  promptWordBudgetForModel,
} from '../prompts/promptBudget';
import { kreaCondenseTimeoutMs, legacyLatencyProfile } from '../providers/cliproxyText.config';
import { aiFillTextProviderForConfig } from '../providers/textRouting';
import { resolveTextBackend, resolveTextBackendEffort } from '../routing/textBackendPreference';
import { enhancePool } from './llmAdmission';

export interface CondenseDeps {
  readonly db: Database;
  readonly config: Config;
  readonly logger: AppLogger;
  readonly userId: string;
  /** Batch controller signal — user cancel, DELETE /history, SIGTERM drain. */
  readonly signal: AbortSignal;
}

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
 * Fail-open at EVERY step: refused admission, provider failure, timeout,
 * cancellation, empty output, a refusal, an over-length result, or a result
 * that is not strictly shorter all return the original prompt and log
 * `krea_prompt_condense_skipped`. A condense failure must never fail a batch
 * the user already paid queue time for.
 */
export async function condenseBatchPrompt(
  prompt: string,
  modelId: string,
  deps: CondenseDeps,
): Promise<string> {
  const wordBudget = promptWordBudgetForModel(modelId);
  const beforeWords = countPromptWords(prompt);
  if (wordBudget === null || beforeWords <= KREA_PROMPT_CONDENSE_TRIGGER_WORDS) return prompt;

  const skip = (reason: string, afterWords?: number): string => {
    deps.logger.info(
      {
        event: 'krea_prompt_condense_skipped',
        reason,
        beforeWords,
        ...(afterWords === undefined ? {} : { afterWords }),
      },
      'Krea prompt condensation skipped',
    );
    return prompt;
  };
  // Condensation runs only for Krea rows, whose automatic backend is Kimi.
  // A user override can move it to any selectable backend; the system prompt
  // follows below. Resolved before the timer so the deadline follows the backend.
  let backend: AiFillBackend;
  let reasoningEffort: TextReasoningEffort | undefined;
  try {
    backend = resolveTextBackend(deps.db, deps.userId, 'condense', 'kimi', { targetPool: 'local' });
    reasoningEffort = resolveTextBackendEffort(deps.db, deps.userId, 'condense', backend);
  } catch {
    return skip('error');
  }
  const timeoutSignal = AbortSignal.timeout(kreaCondenseTimeoutMs(legacyLatencyProfile(backend), deps.config.KREA_CONDENSE_TIMEOUT_MS));
  const signal = AbortSignal.any([deps.signal, timeoutSignal]);
  let releaseEnhanceSlot: (() => void) | null = null;

  try {
    const slot = enhancePool.acquire(deps.userId);
    if (!slot.ok) return skip(`admission-${slot.reason}`);
    releaseEnhanceSlot = () => { slot.release(); };

    const provider = aiFillTextProviderForConfig(deps.config, backend);
    const systemPrompt = buildCondensePromptSystemPrompt(wordBudget);
    let condensed = '';
    let completed = false;

    const enhanceOpts = reasoningEffort === undefined ? {} : { reasoningEffort };

    for await (const chunk of provider.enhance(prompt, [], signal, systemPrompt, enhanceOpts)) {
      if (signal.aborted) break;
      if (chunk.type === 'delta') condensed += chunk.text;
      else if (chunk.type === 'done') completed = true;
      else if (chunk.type === 'failed') return skip('provider-failed');
    }

    if (timeoutSignal.aborted) return skip('timeout');
    if (deps.signal.aborted) return skip('batch-canceled');
    if (!completed) return skip('truncated');

    const candidate = condensed.trim();
    if (candidate.length === 0) return skip('empty');
    if (isLikelyModelRefusal(candidate)) return skip('refusal');
    const afterWords = countPromptWords(candidate);
    if (candidate.length > MAX_PROMPT_CHARS) return skip('over-char-limit', afterWords);
    if (afterWords >= beforeWords) return skip('not-shorter', afterWords);

    deps.logger.info(
      { event: 'krea_prompt_condensed', beforeWords, afterWords },
      'Krea prompt condensed',
    );
    return candidate;
  } catch {
    if (timeoutSignal.aborted) return skip('timeout');
    if (deps.signal.aborted) return skip('batch-canceled');
    return skip('error');
  } finally {
    releaseEnhanceSlot?.();
  }
}

/**
 * Persist the rendered prompt back onto the batch row.
 *
 * The row is created with the prompt as submitted, so between acceptance and
 * this write `/api/history` shows the raw text. That window is the price of
 * returning the batch id immediately; what the row settles on is still exactly
 * what the provider was handed.
 */
export function persistCondensedPrompt(db: Database, batchId: string, prompt: string): void {
  db.query('UPDATE batches SET prompt = ? WHERE id = ?').run(prompt, batchId);
}
