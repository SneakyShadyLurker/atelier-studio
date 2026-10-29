import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { delay, IDLE_BACKPRESSURE_BUDGET_MS, jitterRetryDelayMs, nextBackpressureDelayMs } from '../../api/queueFullRetry';
import { holdSubmissionUploads, useAtelierStore } from '../../store/atelier';
import { isAbortError } from '../abort';
import { markDrainOwned } from '../drainOwnership';
import { mapWithConcurrency } from '../mapWithConcurrency';
import { buildPreparationUnits, filledItem, prepareBatch, prepareItem } from './prepare';
import {
  carryFill,
  invalidateRecords,
  isTerminal,
  markAccepted,
  markDropped,
  markRefused,
  markRetired,
  markSingleFillOnly,
  markSubmitting,
  pruneSettled,
  restoreRecords,
  settleRecords,
  takeRecords,
  type RollRecords,
} from './records';
import { batchAlreadyStarted, generateBackpressure } from './request';
import type { DrainPumpContext, FillOutcome, FireItem, PassItem, PrepareContext, RollRecord } from './types';

// Max concurrent ai-fill units when a burst of queued rolls is submitted at
// once. ai-fill is the herd-prone reformatting step: many simultaneous calls
// can balloon upstream latency and truncate the answer, silently dropping rolls
// (the "only 4 of 10 generate" bug, observed on an earlier direct text
// channel). The server-side draft-pool split guarantees ai-fill admission
// headroom, so the cap was raised from 3 (5 was also retested clean; 4 is kept
// as the more conservative setting). The caption-format
// step is NOT throttled — it is robust under concurrency and is the slow
// long-pole, so serialising it would needlessly inflate time-to-first-tile.
const REFORMAT_FILL_CONCURRENCY = 4;

/** How a submitted POST answered. Known at answer time, before the stream ends. */
type Answer =
  | { readonly kind: 'started' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'backpressure'; readonly retryAfterMs: number }
  | { readonly kind: 'failed' };

interface Submission {
  readonly record: RollRecord;
  answer: Answer | null;
  /** Settles once answered. */
  readonly whenAnswered: Promise<undefined>;
}

/**
 * Generation streams the pump has started. Admission never waits for them;
 * a completion only wakes an idle or backing-off pump, and every rejection is
 * swallowed here (streams reconcile through useGenerate and history).
 */
export interface CompletionTracker {
  track: (stream: Promise<unknown>) => void;
  running: () => number;
  /** Pending `whenAnyCompletes` waiters. */
  waiting: () => number;
  /** True at the next completion; false, and unregistered, once `signal` aborts. */
  whenAnyCompletes: (signal: AbortSignal) => Promise<boolean>;
}

export function createCompletionTracker(): CompletionTracker {
  let running = 0;
  const waiters = new Set<() => void>();
  return {
    track: (stream) => {
      running += 1;
      const completed = (): void => {
        running -= 1;
        for (const wake of [...waiters]) wake();
      };
      void stream.then(completed, completed);
    },
    running: () => running,
    waiting: () => waiters.size,
    whenAnyCompletes: (signal) => new Promise<boolean>((resolve) => {
      if (signal.aborted) { resolve(false); return; }
      const finish = (completed: boolean): void => {
        waiters.delete(wake);
        signal.removeEventListener('abort', onAbort);
        resolve(completed);
      };
      const wake = (): void => { finish(true); };
      const onAbort = (): void => { finish(false); };
      waiters.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  };
}

type StoreState = ReturnType<typeof useAtelierStore.getState>;

const queueChanged = (state: StoreState, previous: StoreState): boolean => (
  state.draft.rollQueue !== previous.draft.rollQueue || state.queueEpoch !== previous.queueEpoch
);
const epochChanged = (state: StoreState, previous: StoreState): boolean => state.queueEpoch !== previous.queueEpoch;

/** True at the next matching store change; false, and unsubscribed, once `signal` aborts. */
function nextStoreChange(
  signal: AbortSignal,
  changed: (state: StoreState, previous: StoreState) => boolean,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    let done = false;
    const finish = (changed: boolean): void => {
      if (done) return;
      done = true;
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      resolve(changed);
    };
    const onAbort = (): void => { finish(false); };
    const unsubscribe = useAtelierStore.subscribe((state, previous) => {
      if (changed(state, previous)) finish(true);
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Waits for the first of `sources`, each bound to its own wait signal. Stop
 * ends the wait; every source is disposed whichever way it ends, so repeated
 * wake-ups leave no subscriber or waiter behind.
 */
async function raceWake(stop: AbortSignal, sources: (wait: AbortSignal) => Promise<unknown>[]): Promise<void> {
  const wait = new AbortController();
  const onStop = (): void => { wait.abort(); };
  stop.addEventListener('abort', onStop, { once: true });
  if (stop.aborted) wait.abort();
  try {
    await Promise.race(sources(wait.signal));
  } finally {
    wait.abort();
    stop.removeEventListener('abort', onStop);
  }
}

/** A cancellable sleep that resolves (never rejects) when its wait ends. */
function sleep(ms: number, wait: AbortSignal): Promise<void> {
  return delay(ms, wait).catch(() => undefined);
}

/**
 * The durable single-owner drain. Works the queue (queued rolls + the active
 * composer prompt) in repeated passes until it is empty. Each pass prepares
 * items at bounded concurrency (ai-fill → model-format) and submits them in
 * display order, one unanswered POST at a time; a pass ends when its last row
 * is answered, never when its streams complete, so a roll stashed meanwhile is
 * submitted at once. The pump stays the owner while its accepted streams run,
 * idling until the queue changes, a stream completes or Stop. QUEUE_FULL at
 * ANY stage — ai-fill, format, or the /api/generate per-user queued-batch cap
 * — is BACKPRESSURE, never a drop: the roll is kept and retried on the next pass,
 * carrying its resolved text forward so the retry never re-runs ai-fill.
 * Genuine failures (refusal, invalid caption, a non-QUEUE_FULL refusal) keep
 * the roll in the queue but skip it for the rest of the drain; only
 * over-length prompts drop. Stop aborts in-flight preparation and the
 * inter-pass wait, leaving every unconfirmed roll back in the queue.
 */
export async function runDrainPump(ctx: DrainPumpContext): Promise<void> {
  const { signal, addToast } = ctx;
  const store = useAtelierStore.getState;
  const records: RollRecords = new Map();
  const tracker = createCompletionTracker();
  // Clear or a template switch ends the pump: rolls stashed afterwards belong
  // to the next press, never to this owner.
  const pumpEpoch = store().queueEpoch;
  // Keys of rolls that reached a terminal fate this drain (pruned records).
  const settledKeys = new Set<string>();
  // The head's actionable fill error. On an object so closure writes are not
  // control-flow-narrowed to the initial null.
  const headError: { message: string | null } = { message: null };
  const prep: PrepareContext = {
    ...ctx.prepareContext(signal),
    recordHeadError: (message) => { headError.message = message; },
    onDeferSingle: (rollId) => { markSingleFillOnly(records, rollId); },
    onFilled: (item) => {
      if (store().queueEpoch !== pumpEpoch) return;
      const record = records.get(item.key);
      if (record) carryFill(record, item);
    },
  };
  let preparingRemaining = 0;
  // Clear or a template switch discards the consumed rolls at once, so a reload
  // while a pass still waits on a POST or a stream cannot bring them back.
  const unwatchQueueEpoch = useAtelierStore.subscribe((state, previous) => {
    if (state.queueEpoch !== previous.queueEpoch) invalidateRecords(records.values());
  });
  // Read through a call so control-flow analysis can't narrow `aborted` to
  // false after the loop-top guard — it flips asynchronously when Stop fires.
  const aborted = (): boolean => signal.aborted;
  // Settles when `pending` does or when Stop is pressed, whichever is first.
  const untilStopped = async (pending: Promise<unknown>): Promise<void> => {
    if (aborted()) return;
    const stopped = Promise.withResolvers<undefined>();
    const onStop = (): void => { stopped.resolve(undefined); };
    signal.addEventListener('abort', onStop, { once: true });
    try {
      await Promise.race([pending, stopped.promise]);
    } finally {
      signal.removeEventListener('abort', onStop);
    }
  };

  // The head was pressed after these rolls and before any queued later, set
  // at the press rather than here: a roll stashed while the press waited for
  // its turn never goes ahead of it. Every pass keeps it there, so a head held
  // back by capacity is never passed by a press that joined the drain meanwhile.
  const { queuedBeforeHead } = ctx;
  // The current pass's hold on its consumed rolls' uploads.
  let releasePassUploads: () => void = () => undefined;

  try {
    let pendingHead: FireItem | null = ctx.pendingHead;
    let lastProgressAt = Date.now();
    let idleBackoffMs = 0;
    // Cross-pass tallies, on an object for the same CFA reason as headError.
    const totals = { fired: 0, failed: 0, overLength: 0 };

    for (;;) {
      if (aborted()) break;
      if (store().queueEpoch !== pumpEpoch) break;
      // Eligible this pass: the active head (until it fires) + the LIVE queue
      // MINUS rolls that already genuinely failed this drain, so they neither
      // re-fire nor block completion, and minus any key already settled, so
      // accepted work is never submitted twice. Rolls stashed mid-drain are
      // picked up.
      const liveRolls = store().draft.rollQueue.filter((r) => (
        ctx.canTake(r) && records.get(r.id)?.failedThisDrain !== true && !settledKeys.has(r.id)
      ));
      const queuedItems: PassItem[] = liveRolls.map((r) => {
        // A roll keeps the settings of the press that queued it. A library roll
        // binds to the drain-starting press's when first taken; its source
        // carries them, so the saved in-flight copy and a restored roll keep
        // the same model, references and count.
        const roll = r.submission === undefined && ctx.defaultSubmission !== undefined
          ? { ...r, submission: ctx.defaultSubmission }
          : r;
        return {
          item: { key: roll.id, text: roll.text, provenance: roll.provenance, ...(roll.submission ? { submission: roll.submission } : {}) },
          sourceRoll: roll,
        };
      });
      // The head trails the rolls queued before its press, matching the
      // pre-drain fire order, and leads every roll queued after it.
      const headAt = queuedItems.findLastIndex(({ item }) => queuedBeforeHead.has(item.key)) + 1;
      const passItems: PassItem[] = pendingHead
        ? [...queuedItems.slice(0, headAt), { item: pendingHead, sourceRoll: null }, ...queuedItems.slice(headAt)]
        : queuedItems;
      if (passItems.length === 0) {
        // Nothing eligible: done once no accepted stream still runs. Otherwise
        // stay the owner and wait for a queue change, a completion or Stop.
        if (tracker.running() === 0) break;
        await raceWake(signal, (wait) => [nextStoreChange(wait, queueChanged), tracker.whenAnyCompletes(wait)]);
        // Waiting on streams is not backpressure: the idle budget restarts.
        lastProgressAt = Date.now();
        continue;
      }

      const preparationUnits = buildPreparationUnits(prep, passItems, (rollId) => records.get(rollId)?.singleFillOnly === true);

      // Snapshot the queue epoch at consume time. If the user clears the queue or
      // switches template while this pass is in flight, the epoch bumps and we must
      // NOT restore the consumed rolls (they were intentionally discarded).
      const passEpoch = store().queueEpoch;
      // Consumed rolls leave the queue that holds their uploads: hold them,
      // bound settings included, for the pass, until a roll is accepted or
      // restored to the queue.
      releasePassUploads = holdSubmissionUploads(queuedItems.map(({ sourceRoll }) => sourceRoll?.submission));
      // Optimistic-consume the queued rolls (synchronous, before any await) so
      // they cannot be double-processed; each is RESTORED below unless it fires
      // or drops. A restored roll re-enters with its carried text (no re-fill).
      if (liveRolls.length > 0) store().removeQueuedRolls(liveRolls.map((r) => r.id));
      const passRecords = takeRecords(records, passItems);
      const recordOf = new Map(passItems.map((passItem, index) => [passItem, passRecords[index]] as const));

      store().addPreparing(passItems.length);
      preparingRemaining += passItems.length;
      const settlePreparingOne = () => {
        if (preparingRemaining <= 0) return;
        preparingRemaining -= 1;
        store().settlePreparing(1);
      };

      const submissions: Submission[] = [];
      // Pass-local mutables on an object so closure writes aren't CFA-narrowed.
      const m = {
        backoffMs: 0,
        firedThisPass: 0,
        // Items that reached a TERMINAL fate this pass (fired, genuinely failed,
        // or over-length-dropped) — i.e. real forward progress. A pass with zero
        // progress and only backpressure is an "idle" pass (anti-spin counter).
        progressThisPass: 0,
        sawBackpressure: false,
        quotaStop: false,
        submissionsBlocked: false,
      };

      const failPrepared = (record: RollRecord): void => {
        if (record.source === null) {
          markDropped(record, { kind: 'failed' });
          addToast(headError.message ?? "Couldn't prepare the prompt — nothing to generate from the composer.", 'error');
        } else {
          markRefused(record, { kind: 'failed' });
          totals.failed += 1;
        }
        m.progressThisPass += 1;
      };

      const submit = async (record: RollRecord, item: FireItem): Promise<void> => {
        ctx.onFirstFire();
        const request = ctx.makeRequest(item);
        markDrainOwned(request);
        const answered = Promise.withResolvers<undefined>();
        const submission: Submission = { record, answer: null, whenAnswered: answered.promise };
        submissions.push(submission);
        const answer = (value: Answer): void => {
          submission.answer ??= value;
          answered.resolve(undefined);
        };
        markSubmitting(record, null);
        const stream = ctx.generate(request, {
          // Known acceptance means a billable batch exists: settle the consumed
          // roll now so a reload while other units are pending cannot re-fire it.
          onAccepted: (batchId) => {
            markAccepted(record, batchId);
            answer({ kind: 'started' });
          },
        });
        record.stream = stream;
        tracker.track(stream);
        // A POST that settles without a reported acceptance decides the roll.
        // Fulfilled, or a StreamTruncatedError carrying a batchId → a batch
        // started. An AbortError on a FIRED generate may have landed AFTER the
        // batch was created (deliberate cancel / unmount); restoring would
        // double-fire, so it is treated as removed. A QUEUE_FULL 429 (the
        // queued-batch cap) → backpressure (keep, retry) that blocks later rows.
        // Any other failure is genuine — useGenerate already toasted — so the
        // roll is KEPT (no loss) but skipped for the rest of this drain.
        void stream.then(() => {
          record.stream = null;
          if (submission.answer === null) markAccepted(record, null);
          answer({ kind: 'started' });
        }, (error: unknown) => {
          record.stream = null;
          if (submission.answer !== null) return;
          if (batchAlreadyStarted(error)) {
            markAccepted(record, null);
            answer({ kind: 'started' });
            return;
          }
          if (isAbortError(error)) {
            markDropped(record, { kind: 'aborted' });
            answer({ kind: 'aborted' });
            return;
          }
          const retryAfterMs = generateBackpressure(error);
          if (retryAfterMs !== null) {
            m.submissionsBlocked = true;
            markRefused(record, { kind: 'backpressure', retryAfterMs });
            answer({ kind: 'backpressure', retryAfterMs });
            return;
          }
          if (record.source === null) markDropped(record, { kind: 'failed' });
          else markRefused(record, { kind: 'failed' });
          answer({ kind: 'failed' });
        });
        // POSTs can themselves finish out of order (for example while checking
        // reference artifacts). Wait for acceptance, not the generation stream,
        // before admitting the next row. Stop ends this wait at once; the
        // stopped drain decides the unit once its POST answers.
        await untilStopped(answered.promise);
      };

      const handleOutcome = async (record: RollRecord, outcome: FillOutcome): Promise<void> => {
        if (store().queueEpoch !== passEpoch) return;
        // Stop submits nothing more; a fill already made was carried at
        // preparation, so a resume never re-bills it.
        if (aborted()) return;
        if (outcome === null) { failPrepared(record); return; }
        if ('preserve' in outcome) {
          m.quotaStop = true;
          m.submissionsBlocked = true;
          markRefused(record, { kind: 'quota' });
          return;
        }
        if ('backpressure' in outcome) {
          m.submissionsBlocked = true;
          m.sawBackpressure = true;
          m.backoffMs = Math.max(m.backoffMs, outcome.retryAfterMs);
          markRefused(record, { kind: 'backpressure', retryAfterMs: outcome.retryAfterMs });
          return;
        }
        if ('deferSingle' in outcome) {
          m.submissionsBlocked = true;
          markRefused(record, { kind: 'deferSingle' });
          return;
        }
        if (outcome.text.length > MAX_PROMPT_CHARS && record.source !== null) {
          markDropped(record, { kind: 'overLength' });
          totals.overLength += 1;
          m.progressThisPass += 1;
          return;
        }
        // Already-prepared text is carried into the next pass without letting a
        // later row pass a head that still needs capacity or a single-fill retry.
        if (m.submissionsBlocked) return;
        await submit(record, outcome);
      };

      const prepared = new Map(passItems.map((passItem) => {
        const { promise: ready, resolve: complete } = Promise.withResolvers<FillOutcome | undefined>();
        return [passItem, { ready, complete }] as const;
      }));
      const preparing = mapWithConcurrency(preparationUnits, REFORMAT_FILL_CONCURRENCY, async (unit) => {
        const entries = unit.kind === 'batch'
          ? unit.entries.map(({ passItem }) => passItem)
          : [unit.entry];
        try {
          if (signal.aborted) return;
          const outcomes = unit.kind === 'batch'
            ? await prepareBatch(prep, unit.entries)
            : [await prepareItem(prep, unit.entry.item, unit.entry.sourceRoll)];
          outcomes.forEach((outcome, index) => {
            const entry = entries[index];
            if (!entry) return;
            // A row may wait behind earlier submissions; carry and save its fill
            // now so a reload meanwhile never bills that fill again.
            const filled = filledItem(outcome);
            const record = recordOf.get(entry);
            if (filled && record && record.item !== filled) carryFill(record, filled);
            prepared.get(entry)?.complete(outcome);
          });
        } catch (error) {
          if (!isAbortError(error)) {
            for (const entry of entries) {
              const record = recordOf.get(entry);
              if (record) failPrepared(record);
            }
          }
        } finally {
          for (const entry of entries) {
            // Also release the ordered consumer on failure or Stop. Completed
            // promises keep their original outcome.
            prepared.get(entry)?.complete(undefined);
            settlePreparingOne();
          }
        }
      });

      // Preparation groups batchable rolls ahead of singles and completes in
      // arbitrary order. Only the original pass order owns submission order.
      for (const passItem of passItems) {
        const outcome = await prepared.get(passItem)?.ready;
        const record = recordOf.get(passItem);
        if (outcome !== undefined && record) await handleOutcome(record, outcome);
      }
      await preparing;

      // Submissions made before Stop whose POST is still unanswered. The ordered
      // consumer admits one at a time, so there is at most one.
      const unanswered = aborted() ? submissions.filter((s) => s.answer === null) : [];
      if (!aborted()) {
        for (const { record, answer } of submissions) {
          if (answer === null) continue;
          if (answer.kind === 'started') {
            m.firedThisPass += 1;
            m.progressThisPass += 1;
          } else if (answer.kind === 'aborted') {
            m.progressThisPass += 1;
          } else if (answer.kind === 'backpressure') {
            m.sawBackpressure = true;
            m.backoffMs = Math.max(m.backoffMs, answer.retryAfterMs);
          } else {
            if (record.source !== null) totals.failed += 1;
            m.progressThisPass += 1;
          }
        }
      }

      // If the user cleared the queue or switched template mid-pass, the consumed
      // rolls were intentionally discarded — do NOT restore them (and stop the
      // drain; the head, if any, also no longer belongs to the current context).
      if (store().queueEpoch !== passEpoch) {
        invalidateRecords(passRecords);
        totals.fired += m.firedThisPass;
        break;
      }

      // Restore every consumed roll that did NOT fire or drop, carrying forward
      // its resolved text. Runs even on abort so Stop never loses work. An
      // unanswered roll goes back too, in its place, and is decided once its
      // POST answers.
      const restore = restoreRecords(passRecords);
      if (restore.length > 0) store().restoreRollQueue(restore);
      // Restored rolls are held by the queue again.
      releasePassUploads();
      releasePassUploads = () => undefined;

      // Head disposition for the next pass: gone once fired or dropped,
      // otherwise it keeps any text already prepared.
      const headRecord = passRecords.find((record) => record.source === null);
      if (headRecord) pendingHead = isTerminal(headRecord) ? null : headRecord.item;

      totals.fired += m.firedThisPass;
      pruneSettled(records, settledKeys);

      if (m.progressThisPass > 0) {
        lastProgressAt = Date.now();
        idleBackoffMs = 0;
      }

      if (aborted()) {
        // The stopped drain keeps the queue until the unanswered POST answers
        // (bounded by the stream's stall watchdog; offline fails at once), the
        // next drain waits for it, and a roll the server took leaves the queue
        // again. The composer prompt's POST is waited for too, but stays in
        // the composer.
        await Promise.all(unanswered.map((s) => s.whenAnswered));
        store().retireQueuedRolls(unanswered.flatMap((s) => {
          const kind = s.answer?.kind;
          if (kind !== 'started' && kind !== 'aborted') return [];
          const id = markRetired(s.record);
          return id === null ? [] : [id];
        }));
        break;
      }
      if (m.quotaStop) break;            // 5h budget — rolls restored, stop retrying
      if (!m.sawBackpressure) continue;

      const madeProgress = m.progressThisPass > 0;
      if (!madeProgress && Date.now() - lastProgressAt >= IDLE_BACKPRESSURE_BUDGET_MS) {
        addToast(
          'Still at capacity — your queue is saved. Press Generate to resume.',
          'soft',
          30_000,
          { label: 'Resume', onClick: ctx.submitQueueOnly },
        );
        break;
      }
      idleBackoffMs = nextBackpressureDelayMs(idleBackoffMs, m.backoffMs, madeProgress);
      // A finished batch is what frees the per-user queued-batch cap, so a
      // stream completion may end the wait early, but only as a hint: the
      // retry never fires before the base backoff floor. Clear or a template
      // switch ends the wait, and with it the pump.
      const backoffMs = Math.min(15_000, jitterRetryDelayMs(idleBackoffMs));
      const floorMs = Math.min(backoffMs, nextBackpressureDelayMs(0, m.backoffMs, true));
      await raceWake(signal, (wait) => {
        const completed = tracker.whenAnyCompletes(wait);
        return [
          nextStoreChange(wait, epochChanged),
          sleep(floorMs, wait).then(() => (
            wait.aborted ? undefined : Promise.race([completed, sleep(backoffMs - floorMs, wait)])
          )),
        ];
      });
    }

    if (totals.overLength > 0) {
      addToast(`Dropped ${totals.overLength} prompt${totals.overLength === 1 ? '' : 's'} over ${MAX_PROMPT_CHARS} chars.`, 'error');
    }
    if (totals.failed > 0) {
      addToast(
        // Counts preparation failures and refused submissions alike, so the
        // copy names neither: the roll did not start and is still queued.
        `Couldn't start ${totals.failed} prompt${totals.failed === 1 ? '' : 's'} — left in the queue to retry.`,
        'error',
        10_000,
        { label: 'Retry', onClick: ctx.submitQueueOnly },
      );
    }
    if (totals.fired > 0) {
      addToast(`Queued ${totals.fired} prompt${totals.fired === 1 ? '' : 's'}`, 'success');
    }
  } finally {
    releasePassUploads();
    // Drain any items not yet settled (a throw mid-pipeline) so the
    // "Preparing N more…" counter never leaks.
    if (preparingRemaining > 0) {
      store().settlePreparing(preparingRemaining);
      preparingRemaining = 0;
    }
    unwatchQueueEpoch();
    settleRecords(records.values());
  }
}
