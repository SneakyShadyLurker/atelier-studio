import { Hono, type Context } from 'hono';
import {
  MAX_PROMPT_CHARS,
  type AiFillBackendFrame,
  type AiFillBatchSseEvent,
} from '@atelier/shared';
import {
  AI_FILL_FIELD_SEPARATOR,
  AI_FILL_RECORD_SEPARATOR,
  assembleAiFillPrompt,
  buildAiFillSkeleton,
  staticSegmentsLength,
} from '@atelier/shared/ai-fill';
import type { AppLogger } from '../../observability/logger';
import type { AppEnv } from '../../server-env';
import { withLlmSlot } from '../../lifecycle/withLlmSlot';
import { enhancePool } from '../../orchestrator/llmAdmission';
import { imageModelRouting, textModelFailureBody, textProviderForResolved } from '../../providers/textRouting';
import type { ResolvedTextModel } from '../../routing/textModelResolver';
import {
  aiFillBatchRouteTimeoutMs,
  aiFillPerAttemptTimeoutMs,
  aiFillRouteTimeoutMs,
} from '../../providers/text/textBudgets';
import { parseBody } from '../_http';
import { AiFillBatchRequestSchema, AiFillRequestSchema } from './aiFill.schema';
import {
  buildAiFillBatchSystemPrompt,
  buildAiFillBatchUserContent,
  buildAiFillSystemPrompt,
  buildAiFillUserContent,
  buildKimiAiFillBatchSystemPrompt,
  buildKimiAiFillSystemPrompt,
} from '../../prompts/aiFillSystemPrompt';
import { isLikelyModelRefusal } from '../../prompts/modelOutput';
import { failedToSseError } from '../../lifecycle/llm-error';
import { promptCharBudgetForModel, promptMinPerSlotWordsForModel } from '../../prompts/promptBudget';
import type { TextModelRecord } from '../../db/textProviders';

const SAFE_ERROR_MESSAGE = "Couldn't fill the prompt. Please try again.";
const REFUSAL_ERROR_MESSAGE = 'The writer refused this prompt. Nothing was sent to the image model.';

function splitFills(text: string): string[] {
  return text.split(AI_FILL_FIELD_SEPARATOR).map((s) => s.trim());
}

/**
 * A fill that is really the writer refusing. Left unchecked it is assembled into
 * the prompt and rendered as unreadable paragraphs of prose by the image model.
 * Refusals are deterministic, not a transient format miss, so they are never
 * retried — the roll fails and the attempt is logged for moderation review.
 */
function refusedFillIndex(fills: readonly string[]): number {
  return fills.findIndex((fill) => isLikelyModelRefusal(fill));
}

/** Operational counts only; refused prompts must never enter logs. */
function logRefusal(
  logger: AppLogger,
  input: {
    readonly event: 'ai_fill_refusal' | 'ai_fill_batch_refusal';
    readonly userId: string;
    readonly textModelId: string;
    readonly modelId: string;
    readonly slot: number;
    readonly itemIndex?: number;
    readonly skeleton: string;
    readonly instructions: readonly string[];
    readonly refusal: string;
  },
): void {
  const { event, refusal, instructions, skeleton, ...rest } = input;
  logger.warn(
    {
      event,
      ...rest,
      skeletonChars: skeleton.length,
      instructionCount: instructions.length,
      refusalChars: refusal.length,
    },
    'ai-fill refused — prompt withheld from the image model',
  );
}

interface ParsedBatchItem {
  readonly fills: string[];
  readonly mismatched: boolean;
  /** Index of the refused fill, or -1. Kept apart from `mismatched` so a refusal never triggers the group retry. */
  readonly refusedSlot: number;
}

function parseBatchResponse(
  text: string,
  items: readonly { readonly instructions: readonly string[] }[],
): ParsedBatchItem[] | null {
  const records = text.split(AI_FILL_RECORD_SEPARATOR);
  if (records.length > items.length) return null;
  return items.map((item, index) => {
    const record = records[index];
    if (record === undefined) return { fills: [], mismatched: true, refusedSlot: -1 };
    const fills = splitFills(record);
    const wanted = item.instructions.length;
    return {
      fills,
      mismatched: fills.length !== wanted || fills.some((fill) => fill.length === 0),
      refusedSlot: refusedFillIndex(fills),
    };
  });
}

type BatchItemResult = Extract<AiFillBatchSseEvent, { event: 'result' }>['data']['items'][number];

// The ai-fill text model for an image-model target: its prompt writer when
// one is set, else the user's pick, the task assignment or the default.
function resolveAiFillModel(c: Context<AppEnv>, modelId: string): ResolvedTextModel {
  return c.var.text.resolve({ userId: c.var.userId, task: 'ai-fill', ...imageModelRouting(c.var.config, modelId) });
}

/** The advisory `backend` frame naming the serving row. */
function backendFrame(model: TextModelRecord): AiFillBackendFrame {
  return { modelId: model.id, label: model.displayName };
}

// Words each slot may use: the model's prompt budget left after the static
// text, split across the slots (~6 chars per word), floored at the model's
// per-slot minimum.
function perSlotWordBudgetFor(modelId: string, staticSegments: readonly string[], slotCount: number): number {
  return Math.max(
    promptMinPerSlotWordsForModel(modelId),
    Math.floor((promptCharBudgetForModel(modelId) - staticSegmentsLength(staticSegments)) / Math.max(1, slotCount) / 6),
  );
}

export const aiFillRoutes = new Hono<AppEnv>().post('/prompts/ai-fill', async (c) => {
  const parsed = await parseBody(c, AiFillRequestSchema);
  if (!parsed.ok) return parsed.response;
  const { staticSegments, instructions, modelId, simulate } = parsed.value;

  const config = c.var.config;
  const logger = c.var.logger;
  const userId = c.var.userId;
  const skeleton = buildAiFillSkeleton(staticSegments);
  const resolved = resolveAiFillModel(c, modelId);
  if (!resolved.ok) return c.json(textModelFailureBody(resolved.reason), 409);
  const textModel = resolved.model;
  const reasoningEffort = resolved.effort;
  const usesGenericPrompt = textModel.promptVariant === 'generic';
  // Generate and Simulate use the same centralized route. One provider owns
  // the full fill request and its format retry; it never falls through to
  // another model.
  const provider = textProviderForResolved(config, c.var.text, textModel);
  const perSlotWordBudget = perSlotWordBudgetFor(modelId, staticSegments, instructions.length);
  const buildSystemPrompt = usesGenericPrompt
    ? buildAiFillSystemPrompt
    : buildKimiAiFillSystemPrompt;
  const systemPrompt = buildSystemPrompt({
    modelId,
    slotCount: instructions.length,
    perSlotWordBudget,
  });
  const userContent = buildAiFillUserContent({ skeleton, instructions });
  const perAttemptTimeoutMs = aiFillPerAttemptTimeoutMs(textModel.latencyProfile, config.AI_FILL_PER_ATTEMPT_TIMEOUT_MS);
  const timeoutMs = aiFillRouteTimeoutMs(
    [perAttemptTimeoutMs, perAttemptTimeoutMs],
    config.RESILIENT_MAX_BACKOFF_MS,
  );

  // The client retries QUEUE_FULL transparently (multi-submit backpressure).
  // Keep the SSE owner alive through both policy-wrapped provider calls (the
  // second is the format retry); CLOUD_TIMEOUT_MS governs image tiles instead.
  return withLlmSlot(c, enhancePool, userId, 2, () => ({
    timeoutMs,
    disconnect: c.req.raw.signal,
    run: async ({ send, signal, timedOut, clientDisconnected }) => {
        try {
          send('backend', backendFrame(textModel));
          // Either path can come back malformed — wrong field count or an empty
          // blank — most often when a reasoning run truncated the answer before
          // the field separator (finish_reason:'length' → got:1).
          // A successful-but-malformed response is NOT a transient error, so the
          // resilience policy never retries it; we retry once HERE instead so a
          // single bad roll self-heals rather than being silently dropped.
          // Both attempts stay on the selected model with the same prompt and
          // request knobs. Bounded to one extra call either way.
          const mismatched = (fills: readonly string[]): boolean =>
            fills.length !== instructions.length || fills.some((f) => f.length === 0);
          const aborted = (): boolean => signal.aborted || clientDisconnected();

          let result = await provider.aiFill(
            {
              systemPrompt,
              userContent,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            },
            signal,
          );
          if (aborted()) return;

          let fills: string[] = result.type === 'ok' ? splitFills(result.text) : [];
          // A refusal is a deliberate, deterministic decision — retrying only
          // burns a second upstream call on the same answer. Fail the roll the
          // moment one appears so the prose never reaches the image model, and
          // record the attempt. Checked again after the format retry, which can
          // come back refusing where the first answer was merely malformed.
          const refusedAndReported = (): boolean => {
            const slot = refusedFillIndex(fills);
            if (slot < 0) return false;
            const refusal = fills[slot] ?? '';
            logRefusal(logger, {
              event: 'ai_fill_refusal',
              userId,
              textModelId: textModel.id,
              modelId,
              slot,
              skeleton,
              instructions,
              refusal,
            });
            send('error', { message: REFUSAL_ERROR_MESSAGE, code: 'refusal' });
            return true;
          };
          if (refusedAndReported()) return;
          if (result.type === 'ok' && mismatched(fills)) {
            const retryReason = fills.length !== instructions.length
              ? 'count-mismatch'
              : 'empty-fill';
            logger.info(
              {
                event: simulate ? 'ai_fill_simulate_retry' : 'ai_fill_mismatch_retry',
                reason: retryReason,
                ...(fills.length !== instructions.length ? { got: fills.length } : {}),
                want: instructions.length,
                userId,
              },
              'ai-fill format miss — retrying',
            );
            result = await provider.aiFill({
              systemPrompt,
              userContent,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            }, signal);
            if (aborted()) return;
            fills = result.type === 'ok' ? splitFills(result.text) : [];
          }

          if (result.type === 'failed') {
            logger.warn(
              { event: 'ai_fill_upstream', kind: result.kind, status: result.status, userId },
              'ai-fill upstream error',
            );
            send('error', failedToSseError(result));
            return;
          }
          // Before the mismatch return, mirroring the first pass: a refusal
          // collapses several slots into one paragraph, so it reads as a count
          // mismatch and would otherwise exit unlogged and mislabelled.
          if (refusedAndReported()) return;
          if (mismatched(fills)) {
            logger.warn(
              { event: 'ai_fill_count_mismatch', got: fills.length, want: instructions.length, userId },
              'ai-fill count mismatch',
            );
            send('error', { message: SAFE_ERROR_MESSAGE, code: 'count-mismatch' });
            return;
          }
          const prompt = assembleAiFillPrompt(staticSegments, fills);
          if (prompt.length > MAX_PROMPT_CHARS) {
            send('error', {
              message: `Filled prompt is too long — ${prompt.length} / ${MAX_PROMPT_CHARS} chars.`,
              code: 'over-length',
            });
            return;
          }
          send('result', { prompt, fills });
        } catch (error) {
          if (clientDisconnected()) return;
          logger[timedOut() ? 'warn' : 'error'](
            { err: error, event: timedOut() ? 'ai_fill_timeout' : 'ai_fill_crash', userId },
            'ai-fill failed',
          );
          send('error', { message: SAFE_ERROR_MESSAGE, code: 'provider-error' });
        }
    },
  }));
}).post('/prompts/ai-fill/batch', async (c) => {
  const parsed = await parseBody(c, AiFillBatchRequestSchema);
  if (!parsed.ok) return parsed.response;
  const { items, modelId } = parsed.value;
  const config = c.var.config;
  const logger = c.var.logger;
  const userId = c.var.userId;

  const prepared = items.map((item, index) => ({
    index,
    item,
    skeleton: buildAiFillSkeleton(item.staticSegments),
    perSlotWordBudget: perSlotWordBudgetFor(modelId, item.staticSegments, item.instructions.length),
  }));
  // The whole batch shares one image-model target, so one model serves it.
  const resolved = resolveAiFillModel(c, modelId);
  if (!resolved.ok) return c.json(textModelFailureBody(resolved.reason), 409);
  const textModel = resolved.model;
  const reasoningEffort = resolved.effort;
  const timeoutMs = aiFillBatchRouteTimeoutMs(textModel.latencyProfile, config.RESILIENT_MAX_BACKOFF_MS);

  return withLlmSlot(c, enhancePool, userId, 2, () => ({
    timeoutMs,
    disconnect: c.req.raw.signal,
    run: async ({ send, signal, timedOut, clientDisconnected }) => {
      try {
        const outcomes: BatchItemResult[] = items.map(() => ({ ok: false }));
        const aborted = (): boolean => signal.aborted || clientDisconnected();
        let refusals = 0;

        if (aborted()) return;
        const usesGenericPrompt = textModel.promptVariant === 'generic';
        const provider = textProviderForResolved(config, c.var.text, textModel);
        const systemPrompt = (usesGenericPrompt
          ? buildAiFillBatchSystemPrompt
          : buildKimiAiFillBatchSystemPrompt)({
          modelId,
          items: prepared.map(({ item, perSlotWordBudget }) => ({
            slotCount: item.instructions.length,
            perSlotWordBudget,
          })),
        });
        const userContent = buildAiFillBatchUserContent({
          items: prepared.map(({ item, skeleton }) => ({ skeleton, instructions: item.instructions })),
        });
        const providerInput = {
          systemPrompt,
          userContent,
          batchSize: prepared.length,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        };

        send('backend', backendFrame(textModel));
        let result = await provider.aiFill(providerInput, signal);
        if (aborted()) return;
        let parsedResponse = result.type === 'ok'
          ? parseBatchResponse(result.text, prepared.map(({ item }) => item))
          : null;
        // A refusal collapses an item's slots into one paragraph, so a
        // multi-slot item reads as mismatched too. Check `refusedSlot`
        // explicitly or the deterministic-refusal rule leaks: the group would
        // be re-sent upstream to buy the same answer twice.
        const groupRefused = parsedResponse?.some((item) => item.refusedSlot >= 0) === true;
        if (
          result.type === 'ok'
          && !groupRefused
          && (parsedResponse === null || parsedResponse.every((item) => item.mismatched))
        ) {
          logger.info(
            {
              event: 'ai_fill_batch_mismatch_retry',
              textModelId: textModel.id,
              reason: parsedResponse === null ? 'record-count-mismatch' : 'every-item-mismatch',
              ...(parsedResponse === null
                ? { got: result.text.split(AI_FILL_RECORD_SEPARATOR).length, want: prepared.length }
                : {}),
              userId,
            },
            'ai-fill batch format miss — retrying group',
          );
          result = await provider.aiFill(providerInput, signal);
          if (aborted()) return;
          parsedResponse = result.type === 'ok'
            ? parseBatchResponse(result.text, prepared.map(({ item }) => item))
            : null;
        }

        if (result.type === 'failed') {
          logger.warn(
            {
              event: 'ai_fill_batch_upstream',
              textModelId: textModel.id,
              kind: result.kind,
              status: result.status,
              userId,
            },
            'ai-fill batch upstream error',
          );
          if (result.moderation) {
            send('error', failedToSseError(result));
            return;
          }
        }
        // A failed or unparseable response leaves every item `{ ok: false }`.
        parsedResponse?.forEach((batchItem, groupIndex) => {
          const source = prepared[groupIndex];
          if (!source) return;
          // Ahead of the mismatch return: a multi-slot refusal is also a count
          // miss, and exiting there would lose the moderation record. The item
          // stays `{ ok: false }`; the client's next-drain fallback re-drives
          // it as a single, which refuses again and surfaces the real reason.
          if (batchItem.refusedSlot >= 0) {
            refusals += 1;
            logRefusal(logger, {
              event: 'ai_fill_batch_refusal',
              userId,
              textModelId: textModel.id,
              modelId,
              slot: batchItem.refusedSlot,
              itemIndex: source.index,
              skeleton: source.skeleton,
              instructions: source.item.instructions,
              refusal: batchItem.fills[batchItem.refusedSlot] ?? '',
            });
            return;
          }
          if (batchItem.mismatched) return;
          const prompt = assembleAiFillPrompt(source.item.staticSegments, batchItem.fills);
          if (prompt.length > MAX_PROMPT_CHARS) return;
          outcomes[source.index] = { ok: true, prompt, fills: batchItem.fills };
        });

        if (outcomes.every((item) => !item.ok)) {
          send(
            'error',
            refusals > 0
              ? { message: REFUSAL_ERROR_MESSAGE, code: 'refusal' }
              : { message: SAFE_ERROR_MESSAGE, code: 'provider-error' },
          );
          return;
        }
        send('result', { items: outcomes });
      } catch (error) {
        if (clientDisconnected()) return;
        logger[timedOut() ? 'warn' : 'error'](
          { err: error, event: timedOut() ? 'ai_fill_batch_timeout' : 'ai_fill_batch_crash', userId },
          'ai-fill batch failed',
        );
        send('error', { message: SAFE_ERROR_MESSAGE, code: 'provider-error' });
      }
    },
  }));
});
