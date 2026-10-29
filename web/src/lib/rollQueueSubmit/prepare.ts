import { MAX_PROMPT_CHARS, type AiFillBackend, type AiFillBatchItem } from '@atelier/shared';
import {
  AI_FILL_BATCH_MAX,
  AI_FILL_MAX_INPUT_CHARS,
  hasAiFillTokens,
  staticSegmentsLength,
  stripCardNotesToken,
} from '@atelier/shared/ai-fill';
import { resolveAiFill, resolveAiFillBatch } from '../../api/aiFill';
import { formatPromptForModel } from '../../api/formatPrompt';
import { QueueFullError } from '../../api/queueFullRetry';
import { QuotaExhaustedError } from '../../api/sse';
import { quotaToastMessage, useAtelierStore, type QueuedRoll } from '../../store/atelier';
import { isAbortError } from '../abort';
import { buildAiFillRequest } from '../resolveAiFillItem';
import { nextSeed } from '../seed';
import type {
  AiFillGroupEntry,
  BatchReadyItem,
  FillOutcome,
  FireItem,
  PassItem,
  PrepareContext,
  PreparationUnit,
  SingleFillOutcome,
} from './types';

/** Splits batchable entries by the server's per-batch item and input caps, in order. */
export function groupAiFillEntries<T extends AiFillGroupEntry>(entries: readonly T[]): T[][] {
  const groups: T[][] = [];
  let group: T[] = [];
  let inputChars = 0;
  const flushGroup = () => {
    if (group.length === 0) return;
    groups.push(group);
    group = [];
    inputChars = 0;
  };
  for (const entry of entries) {
    const entryInputChars = staticSegmentsLength(entry.build.request.staticSegments) + entry.build.request.instructions.reduce(
      (total, instruction) => total + instruction.length,
      0,
    );
    if (
      group.length > 0
      && (
        group.length >= AI_FILL_BATCH_MAX
        || inputChars + entryInputChars >= AI_FILL_MAX_INPUT_CHARS
      )
    ) {
      flushGroup();
    }
    group.push(entry);
    inputChars += entryInputChars;
  }
  flushGroup();
  return groups;
}

/**
 * Groups batchable entries per target model, in order of first appearance,
 * then by the server caps: one batch fill request names a single model.
 */
export function groupAiFillEntriesByModel<T extends AiFillGroupEntry>(
  entries: readonly T[],
  modelIdOf: (entry: T) => string,
): T[][] {
  const byModel = new Map<string, T[]>();
  for (const entry of entries) {
    const modelId = modelIdOf(entry);
    const group = byModel.get(modelId);
    if (group) group.push(entry);
    else byModel.set(modelId, [entry]);
  }
  return [...byModel.values()].flatMap((group) => groupAiFillEntries(group));
}

/** The model an item is prepared and submitted for: its press's, else the context's. */
export function itemModelId(ctx: Pick<PrepareContext, 'effectiveModelId'>, item: FireItem): string {
  return item.submission?.request.modelId ?? ctx.effectiveModelId;
}

/** Preparation settings for one item: its own press's model and motion settings when it carries them. */
export function itemContext(ctx: PrepareContext, item: FireItem): PrepareContext {
  const { submission } = item;
  if (!submission) return ctx;
  return {
    ...ctx,
    effectiveModelId: submission.request.modelId,
    wantsMotion: submission.wantsMotion,
    motionFields: submission.motionFields,
  };
}

/** The text an outcome already paid a fill for, if any. */
export function filledItem(outcome: FillOutcome): FireItem | undefined {
  if (outcome === null || 'preserve' in outcome || 'deferSingle' in outcome) return undefined;
  return 'backpressure' in outcome ? outcome.advancedItem : outcome;
}

// Fill an item's ai-fill blanks (if any) via the server. No tokens → no call.
// Gated (no library) → keep the literal token (matches {{var}}-when-gated).
export async function fillItem(
  pressCtx: PrepareContext,
  item: FireItem,
  sourceRoll: QueuedRoll | null = null,
): Promise<SingleFillOutcome> {
  const ctx = itemContext(pressCtx, item);
  const stripped = stripCardNotesToken(item.text);
  const strippedItem: FireItem = stripped === item.text ? item : { ...item, text: stripped };
  if (!hasAiFillTokens(stripped) || ctx.library === undefined) return strippedItem;
  const build = buildAiFillRequest(item.text, ctx.library, nextSeed(), ctx.effectiveModelId);
  if (!build) return strippedItem;
  if (build.warnings.length > 0) ctx.addToast(build.warnings[0] ?? 'Some prompt tokens could not be resolved', 'soft');
  let announced: AiFillBackend | null = null;
  const announcedBackend = (): AiFillBackend | null => announced;
  try {
    const filled = await resolveAiFill(build.request, ctx.signal, (backend) => {
      if (announced !== null) return;
      announced = backend;
      useAtelierStore.getState().beginAiFill(backend);
    });
    return { ...item, text: filled.prompt };
  } catch (err) {
    // Stop pressed mid-fill: propagate the abort so the drain treats it as
    // cancelled (leave the roll consumed → restored), NOT a genuine failure.
    if (isAbortError(err)) throw err;
    // QUEUE_FULL: pool busy, no slot acquired, no LLM call — keep the roll and
    // retry on the next drain pass. NEVER a drop. (No advancedItem: ai-fill
    // never ran, so the retry re-fills from the original token.)
    if (err instanceof QueueFullError) {
      return { backpressure: true, roll: sourceRoll, retryAfterMs: err.retryAfterMs };
    }
    if (err instanceof QuotaExhaustedError) {
      ctx.addToast(quotaToastMessage(err.retryAfterSeconds), 'soft');
      return { preserve: true, roll: sourceRoll };
    }
    // Only the head (sourceRoll === null) records its message; see recordHeadError.
    if (sourceRoll === null && err instanceof Error && err.message) ctx.recordHeadError(err.message);
    return null;
  } finally {
    const backend = announcedBackend();
    if (backend !== null) useAtelierStore.getState().endAiFill(backend);
  }
}

// MiniMax H3 I2V motion-prompt enhancement. Best-effort: ANY failure (provider
// error, quota, the 409 skip when motion enhancement is unavailable, over-length) falls
// back to the RAW motion text — the raw prompt is already valid + required, so
// there is no drop/preserve path (unlike the caption format). When animating a
// generated tile, the draft's i2vSourcePrompt anchors subject identity.
export async function formatItem(pressCtx: PrepareContext, item: FireItem): Promise<FireItem> {
  const ctx = itemContext(pressCtx, item);
  if (ctx.wantsMotion) {
    try {
      const enhanced = await formatPromptForModel(
        {
          prompt: item.text,
          modelId: ctx.effectiveModelId,
          // The enhancer paces beats and dialogue to the clip the user
          // picked — a 5 s script on a 15 s clip stalls half the shot.
          ...ctx.motionFields,
        },
        'h3-motion',
        ctx.signal,
      );
      if (enhanced.length > MAX_PROMPT_CHARS) return item;
      return { ...item, text: enhanced };
    } catch (err) {
      // A user Stop must NOT silently fire the raw motion prompt — propagate
      // the abort so the drain treats it as cancelled, not a best-effort fall.
      if (isAbortError(err)) throw err;
      console.warn('motion_enhance_fallback_raw');
      return item;
    }
  }
  return item;
}

// The full per-item LLM pipeline: ai-fill blanks, then model-format.
export async function prepareItem(
  ctx: PrepareContext,
  item: FireItem,
  sourceRoll: QueuedRoll | null = null,
): Promise<SingleFillOutcome> {
  if (item.submission?.prepared) return item;
  const filled = await fillItem(ctx, item, sourceRoll);
  if (filled === null || 'preserve' in filled || 'backpressure' in filled) return filled;
  if (filled !== item) ctx.onFilled?.(filled);
  return formatItem(ctx, filled);
}

// A queued roll whose batch fill missed retries through a single fill on the
// next pass; the head has no next pass to wait for, so it fills singly now.
function deferOrPrepareSingle(ctx: PrepareContext, passItem: PassItem): Promise<FillOutcome> {
  if (passItem.sourceRoll !== null) {
    ctx.onDeferSingle(passItem.sourceRoll.id);
    return Promise.resolve({ deferSingle: true, roll: passItem.sourceRoll });
  }
  return prepareItem(ctx, passItem.item, null);
}

/** Fills one batch unit, whose entries share one model; outcomes keep the order of `entries`. */
export async function prepareBatch(ctx: PrepareContext, entries: readonly BatchReadyItem[]): Promise<FillOutcome[]> {
  const announced = new Set<AiFillBackend>();
  const [first] = entries;
  try {
    const requestItems: AiFillBatchItem[] = entries.map(({ build }) => ({
      staticSegments: build.request.staticSegments,
      instructions: build.request.instructions,
    }));
    const resolved = await resolveAiFillBatch(
      { items: requestItems, modelId: first ? itemModelId(ctx, first.passItem.item) : ctx.effectiveModelId },
      ctx.signal,
      (backend) => {
        if (announced.has(backend)) return;
        announced.add(backend);
        useAtelierStore.getState().beginAiFill(backend);
      },
    );
    return await Promise.all(resolved.items.map((outcome, index) => {
      const entry = entries[index];
      if (!entry) return Promise.resolve(null);
      if (!outcome.ok) return deferOrPrepareSingle(ctx, entry.passItem);
      const filled = { ...entry.passItem.item, text: outcome.prompt };
      ctx.onFilled?.(filled);
      return formatItem(ctx, filled);
    }));
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof QueueFullError) {
      return entries.map(({ passItem }) => ({
        backpressure: true,
        roll: passItem.sourceRoll,
        retryAfterMs: error.retryAfterMs,
      }));
    }
    if (error instanceof QuotaExhaustedError) {
      ctx.addToast(quotaToastMessage(error.retryAfterSeconds), 'soft');
      return entries.map(({ passItem }) => ({ preserve: true, roll: passItem.sourceRoll }));
    }
    return await Promise.all(entries.map(({ passItem }) => deferOrPrepareSingle(ctx, passItem)));
  } finally {
    for (const backend of announced) useAtelierStore.getState().endAiFill(backend);
  }
}

/**
 * Splits a pass into preparation units: batchable ai-fill items grouped per
 * model and by the server caps first, then single units in pass order. Rolls
 * that missed a batch earlier this drain (`singleFillOnly`) stay single.
 * Preparation order never decides submission order: the pump submits in pass order.
 */
export function buildPreparationUnits(
  ctx: Pick<PrepareContext, 'library' | 'effectiveModelId' | 'addToast'>,
  passItems: readonly PassItem[],
  singleFillOnly: (rollId: string) => boolean,
): PreparationUnit[] {
  const batchReady: BatchReadyItem[] = [];
  const singles: PassItem[] = [];
  for (const passItem of passItems) {
    if (
      ctx.library !== undefined
      && passItem.item.submission?.prepared !== true
      && hasAiFillTokens(stripCardNotesToken(passItem.item.text))
      && (passItem.sourceRoll === null || !singleFillOnly(passItem.sourceRoll.id))
    ) {
      const build = buildAiFillRequest(passItem.item.text, ctx.library, nextSeed(), itemModelId(ctx, passItem.item));
      if (build) {
        if (build.warnings.length > 0) {
          ctx.addToast(build.warnings[0] ?? 'Some prompt tokens could not be resolved', 'soft');
        }
        batchReady.push({ passItem, build });
        continue;
      }
    }
    singles.push(passItem);
  }
  return [
    ...groupAiFillEntriesByModel(batchReady, ({ passItem }) => itemModelId(ctx, passItem.item))
      .map((entries) => ({ kind: 'batch' as const, entries })),
    ...singles.map((entry) => ({ kind: 'single' as const, entry })),
  ];
}
