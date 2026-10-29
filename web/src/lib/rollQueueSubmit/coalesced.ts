import { MAX_PROMPT_CHARS, type AiFillBackend, type AiFillBatchItem } from '@atelier/shared';
import { resolveAiFillBatch } from '../../api/aiFill';
import { QueueFullError } from '../../api/queueFullRetry';
import { QuotaExhaustedError } from '../../api/sse';
import { quotaToastMessage, useAtelierStore } from '../../store/atelier';
import { isAbortError } from '../abort';
import { buildAiFillRequest, type AiFillRequestBuild } from '../resolveAiFillItem';
import { nextSeed } from '../seed';
import { admitPrepared, turnOrAbort, type AdmissionContext } from './orderedSubmission';
import { formatItem, groupAiFillEntriesByModel, itemModelId, prepareItem } from './prepare';
import type { BufferedFireItem, PrepareContext, SingleFillOutcome } from './types';

export interface CoalescedFlushContext {
  readonly library: PrepareContext['library'];
  readonly addToast: PrepareContext['addToast'];
  /** Preparation bound to the flush's own abort signal; each item's own settings override its model fields. */
  readonly prepareContext: (signal: AbortSignal) => PrepareContext;
  /** POSTs an item at its turn, or queues it behind a drain that owns the queue. */
  readonly admission: AdmissionContext;
  /** Stop and unmount abort every registered flush. */
  readonly registerFlushController: (controller: AbortController) => void;
  readonly unregisterFlushController: (controller: AbortController) => void;
  /**
   * Starts a queue-only drain for the items this flush queued, unless one
   * runs. It pins the feed only as the queued press would, never by the view
   * current at restart.
   */
  readonly ensureDrain: (pinFeedScope: () => void) => void;
}

interface FastBatchReadyItem {
  readonly build: AiFillRequestBuild;
  readonly buffered: BufferedFireItem;
}

const CAPACITY_TOAST = 'At capacity — queued, will generate automatically.';
const PREPARE_FAILED_TOAST = "Couldn't prepare the prompt — nothing to generate.";

/**
 * Prepares and submits coalesced composer presses without entering the drain.
 * Batchable fills go out grouped per model, the rest singly, and preparation
 * may finish in any order; each item then waits for its own turn, so POSTs
 * follow press order with one unanswered at a time. Capacity at any stage
 * queues the item behind earlier work (paid fills kept) and starts a
 * queue-only drain; quota stops the remaining preparation. Every item settles
 * and releases its turn exactly once.
 */
export async function runCoalescedFlush(
  ctx: CoalescedFlushContext,
  items: readonly BufferedFireItem[],
): Promise<void> {
  let resolvingEnded = false;
  let firstFired = false;
  let capacityToastShown = false;
  const fast = { quotaStopped: false };
  const flushController = new AbortController();
  const flushSignal = flushController.signal;
  const flushCtx = ctx.prepareContext(flushSignal);
  ctx.registerFlushController(flushController);
  const quotaWasStopped = () => fast.quotaStopped;
  const endResolvingOnce = () => {
    if (resolvingEnded) return;
    resolvingEnded = true;
    useAtelierStore.getState().endResolving();
  };
  // Each press pins the feed scope it was made in, never the flush's, and
  // queues only while it is still owned: a POST refused after Clear, a
  // template switch or unmount puts nothing back.
  const admissionFor = (buffered: BufferedFireItem): AdmissionContext => ({
    ...ctx.admission,
    enqueue: (item, paid) => buffered.owned() && ctx.admission.enqueue(item, paid),
    onFire: () => {
      buffered.pinFeedScope();
      if (firstFired) return;
      firstFired = true;
      ctx.admission.onFire();
      endResolvingOnce();
    },
  });
  const onQueued = (buffered: BufferedFireItem, capacity: boolean) => {
    if (capacity && !capacityToastShown) {
      capacityToastShown = true;
      ctx.addToast(CAPACITY_TOAST, 'soft');
    }
    // After Stop the item stays queued for the next press, as a stopped drain leaves it.
    if (!flushSignal.aborted) ctx.ensureDrain(buffered.pinFeedScope);
  };

  // undefined: never prepared (Stop, quota, unmount), so nothing is submitted.
  const prepared = new Map(items.map((buffered) => [buffered, Promise.withResolvers<SingleFillOutcome | undefined>()] as const));
  const complete = (buffered: BufferedFireItem, outcome: SingleFillOutcome | undefined) => {
    prepared.get(buffered)?.resolve(outcome);
  };

  // A lone press surfaces its actionable fill error, as an unbatched press
  // always has; a group keeps the generic toast per item.
  const failureMessages = new Map<BufferedFireItem, string>();
  const prepareSingle = async (buffered: BufferedFireItem) => {
    const itemCtx: PrepareContext = items.length === 1
      ? { ...flushCtx, recordHeadError: (message) => { failureMessages.set(buffered, message); } }
      : flushCtx;
    try {
      const outcome = await prepareItem(itemCtx, buffered.item, null);
      if (outcome !== null && 'preserve' in outcome) fast.quotaStopped = true;
      complete(buffered, outcome);
    } catch (error) {
      complete(buffered, isAbortError(error) ? undefined : null);
    }
  };
  const resolveFastBatch = async (entries: readonly FastBatchReadyItem[]) => {
    const announced = new Set<AiFillBackend>();
    const [first] = entries;
    try {
      const requestItems: AiFillBatchItem[] = entries.map(({ build }) => ({
        staticSegments: build.request.staticSegments,
        instructions: build.request.instructions,
      }));
      return await resolveAiFillBatch(
        { items: requestItems, modelId: first ? itemModelId(flushCtx, first.buffered.item) : flushCtx.effectiveModelId },
        flushSignal,
        (backend) => {
          if (announced.has(backend)) return;
          announced.add(backend);
          useAtelierStore.getState().beginAiFill(backend);
        },
      );
    } finally {
      for (const backend of announced) useAtelierStore.getState().endAiFill(backend);
    }
  };

  const prepareAll = async () => {
    try {
      // A lone press fills singly, as an unbatched press always has.
      const [only] = items;
      if (items.length === 1 && only) {
        await prepareSingle(only);
        return;
      }
      const batchReady: FastBatchReadyItem[] = [];
      const singles: BufferedFireItem[] = [];
      for (const buffered of items) {
        const build = ctx.library !== undefined
          ? buildAiFillRequest(buffered.item.text, ctx.library, nextSeed(), itemModelId(flushCtx, buffered.item))
          : null;
        if (build) {
          if (build.warnings.length > 0) {
            ctx.addToast(build.warnings[0] ?? 'Some prompt tokens could not be resolved', 'soft');
          }
          batchReady.push({ buffered, build });
        } else {
          singles.push(buffered);
        }
      }

      for (const entries of groupAiFillEntriesByModel(batchReady, ({ buffered }) => itemModelId(flushCtx, buffered.item))) {
        if (flushSignal.aborted) break;
        let resolved: Awaited<ReturnType<typeof resolveAiFillBatch>>;
        try {
          resolved = await resolveFastBatch(entries);
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (error instanceof QueueFullError) {
            for (const entry of entries) {
              complete(entry.buffered, { backpressure: true, roll: null, retryAfterMs: error.retryAfterMs });
            }
            continue;
          }
          if (error instanceof QuotaExhaustedError) {
            ctx.addToast(quotaToastMessage(error.retryAfterSeconds), 'soft');
            fast.quotaStopped = true;
            break;
          }
          for (const entry of entries) {
            await prepareSingle(entry.buffered);
            if (quotaWasStopped()) break;
          }
          if (quotaWasStopped()) break;
          continue;
        }

        for (const [index, outcome] of resolved.items.entries()) {
          const entry = entries[index];
          if (!entry) continue;
          if (!outcome.ok) {
            await prepareSingle(entry.buffered);
          } else {
            complete(entry.buffered, await formatItem(flushCtx, { ...entry.buffered.item, text: outcome.prompt }));
          }
          if (quotaWasStopped()) break;
        }
        if (quotaWasStopped()) break;
      }

      if (!quotaWasStopped()) {
        for (const buffered of singles) {
          if (flushSignal.aborted) break;
          await prepareSingle(buffered);
          if (quotaWasStopped()) break;
        }
      }
    } catch (error) {
      // Stop or unmount leaves the rest unprepared; anything else is a failure.
      if (!isAbortError(error)) {
        for (const buffered of items) complete(buffered, null);
      }
    } finally {
      for (const buffered of items) complete(buffered, undefined);
    }
  };

  const admit = async (buffered: BufferedFireItem): Promise<void> => {
    try {
      const outcome = await prepared.get(buffered)?.promise;
      // Stop retires a press still waiting for its turn at once.
      await turnOrAbort(buffered.turn, flushSignal);
      // Stop, Clear or a template switch since the press: nothing is sent or queued.
      if (flushSignal.aborted || outcome === undefined || !buffered.live()) return;
      if (outcome === null) {
        ctx.addToast(failureMessages.get(buffered) ?? PREPARE_FAILED_TOAST, 'error');
        return;
      }
      if ('preserve' in outcome) return;
      if ('backpressure' in outcome) {
        // Capacity at fill: the drain retries it, keeping any fill already paid.
        if (admissionFor(buffered).enqueue(outcome.advancedItem ?? buffered.item, true)) onQueued(buffered, true);
        return;
      }
      if (outcome.text.length > MAX_PROMPT_CHARS) {
        ctx.addToast(`Prompt is too long — ${outcome.text.length} / ${MAX_PROMPT_CHARS} chars.`, 'error');
        return;
      }
      // Preparation is over; waiting for the server's answer is not.
      buffered.settle();
      // A coalesced press carries ai-fill: a queued copy keeps the fill paid for.
      const admitted = await admitPrepared(admissionFor(buffered), { item: outcome, paid: true });
      if (admitted === 'capacity') onQueued(buffered, true);
      else if (admitted === 'queued') {
        ctx.addToast('Added to the queue.', 'soft');
        onQueued(buffered, false);
      }
    } finally {
      buffered.settle();
      buffered.turn.release();
    }
  };

  try {
    useAtelierStore.getState().beginResolving();
    await Promise.all([prepareAll(), ...items.map(admit)]);
  } finally {
    ctx.unregisterFlushController(flushController);
    endResolvingOnce();
    for (const buffered of items) {
      buffered.settle();
      buffered.turn.release();
    }
  }
}
