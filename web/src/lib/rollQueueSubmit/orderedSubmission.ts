import type { GenerateRequest } from '@atelier/shared';
import { markDrainOwned } from '../drainOwnership';
import { classifySubmissionFailure, uncertainSubmissionItem } from './request';
import { delay, IDLE_BACKPRESSURE_BUDGET_MS, jitterRetryDelayMs, nextBackpressureDelayMs } from '../../api/queueFullRetry';
import type { FireItem } from './types';

// Press-order admission for composer presses submitted outside the drain pump.
// Each press reserves a turn synchronously, before any await, so its POST
// follows every earlier press however its preparation finishes. A turn is held
// until the server answers the POST (acceptance, or a refusal before any batch
// existed), never until the generation stream ends. A press that does not POST
// hands its turn on at once, so a failure never blocks the presses behind it.

export interface AdmissionTurn {
  /** Settles once every earlier turn has been released. */
  readonly ready: Promise<void>;
  /** Lets the next turn go. Idempotent. */
  readonly release: () => void;
}

export interface AdmissionSequencer {
  readonly reserve: () => AdmissionTurn;
  /** Turns reserved and not yet released. */
  readonly pending: () => number;
}

export function createAdmissionSequencer(): AdmissionSequencer {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    reserve: () => {
      const ready = tail;
      const released = Promise.withResolvers<undefined>();
      // The next turn needs this one released AND every earlier one: a turn
      // released before its own turn came must not let a later one pass.
      tail = ready.then(() => released.promise);
      pending += 1;
      let done = false;
      return {
        ready,
        release: () => {
          if (done) return;
          done = true;
          pending -= 1;
          released.resolve(undefined);
        },
      };
    },
    pending: () => pending,
  };
}

/**
 * Settles when the turn opens or `signal` aborts, whichever is first. A press
 * retired by Stop stops waiting at once and releases its turn, so it never
 * holds the presses behind it; their turns still follow every earlier one.
 */
export function turnOrAbort(turn: AdmissionTurn, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const aborted = Promise.withResolvers<undefined>();
  const onAbort = (): void => { aborted.resolve(undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([turn.ready, aborted.promise]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

type Generate = (request: GenerateRequest, options?: { onAccepted?: (batchId: string) => void }) => Promise<unknown>;

/** How the server answered a POST. Known at acceptance, before the stream ends. */
export type PostAnswer =
  | { readonly kind: 'started' }
  | { readonly kind: 'backpressure'; readonly retryAfterMs: number }
  | { readonly kind: 'uncertain' }
  | { readonly kind: 'failed' };

const STARTED: PostAnswer = { kind: 'started' };

/**
 * POSTs one request and settles once it is answered: at acceptance, or when
 * the stream settles without one. A StreamTruncatedError carrying a batch id,
 * and an AbortError after firing, both count as started, because a batch may
 * exist and requeueing it could bill twice. The stream itself keeps running.
 */
export function postUntilAnswered(generate: Generate, request: GenerateRequest): Promise<PostAnswer> {
  const answered = Promise.withResolvers<PostAnswer>();
  const stream = generate(request, { onAccepted: () => { answered.resolve(STARTED); } });
  void stream.then(() => { answered.resolve(STARTED); }, (error: unknown) => {
    const failure = classifySubmissionFailure(error);
    if (failure.kind === 'started' || failure.kind === 'aborted') {
      answered.resolve(STARTED);
      return;
    }
    // useGenerate toasts a genuine failure itself.
    answered.resolve(failure);
  });
  return answered.promise;
}

export interface AdmissionContext {
  readonly generate: Generate;
  /** The wire request under the item's own press settings. */
  readonly makeRequest: (item: FireItem) => GenerateRequest;
  /** A drain owns the roll queue: running, or a stopped one still settling. */
  readonly queueOwned: () => boolean;
  /**
   * Puts the item at the end of the roll queue, keeping its key and settings.
   * `paid` is a system requeue that bypasses the admission cap; false when
   * the queue refused the item or the press no longer owns the queue (Clear,
   * a template switch, unmount).
   */
  readonly enqueue: (item: FireItem, paid: boolean) => boolean;
  /** Runs before the POST: composer collapse and feed scope. */
  readonly onFire: () => void;
  /** Offers an explicit queue-only retry after an unacknowledged POST. */
  readonly onSaved?: () => void;
}

export interface PreparedPress {
  /**
   * The fully prepared item to POST. It is also what enters the queue, so its
   * prepared text is kept; the model's formatting may still run again.
   */
  readonly item: FireItem;
  /**
   * Preparation paid for work: joining a drain's queue is then a system
   * requeue past the admission cap. An unpaid press obeys the cap.
   */
  readonly paid: boolean;
}

/**
 * - started:  the server took it (or may have);
 * - failed:   refused before any batch, already toasted by useGenerate;
 * - queued:   joined the queue a drain owns, behind every roll it holds;
 * - capacity: refused with QUEUE_FULL and requeued for the drain to retry;
 * - refused:  the queue did not admit it.
 */
export type Admission = 'started' | 'failed' | 'queued' | 'capacity' | 'refused' | 'saved';

/**
 * Admits a prepared press at its turn. While a drain owns the queue, POSTing
 * would pass the rolls it still holds, so the press joins the queue instead.
 * Otherwise it POSTs and returns once the server answers. The caller holds
 * the turn for the whole call and must start a drain for a queued result
 * before releasing it, so the next press sees that drain.
 */
export async function admitPrepared(ctx: AdmissionContext, press: PreparedPress): Promise<Admission> {
  if (ctx.queueOwned()) return ctx.enqueue(press.item, press.paid) ? 'queued' : 'refused';
  ctx.onFire();
  const request = ctx.makeRequest(press.item);
  // A QUEUE_FULL refusal is requeued here, so useGenerate does not toast it.
  markDrainOwned(request);
  const answer = await postUntilAnswered(ctx.generate, request);
  if (answer.kind === 'uncertain') {
    if (!ctx.enqueue(uncertainSubmissionItem(press.item, request), true)) return 'refused';
    ctx.onSaved?.();
    return 'saved';
  }
  if (answer.kind !== 'backpressure') return answer.kind;
  // System recovery of a press already admitted: past the cap, prepared text kept.
  return ctx.enqueue(press.item, true) ? 'capacity' : 'refused';
}

interface StandaloneAdmissionContext extends AdmissionContext {
  readonly signal: AbortSignal;
  /** Clear, template switch or unmount retires this click's queue authority. */
  readonly owned: () => boolean;
  /** Once saved, explicit removal of this row retires further retries. */
  readonly savedItemExists: (key: string) => boolean;
  /** Remove only this click's durable retry copy, including late acceptance after Stop. */
  readonly retire: (key: string) => void;
  readonly onBackpressure: () => void;
}

/**
 * A historical click authorizes itself, never a paused queue. Its caller holds
 * the shared admission turn until answered; capacity retries save only this
 * item and keep that turn, so a later Generate cannot overtake its POST.
 * Stop interrupts backoff, but a sent POST keeps its answer before releasing
 * the turn and retiring its saved copy. Accepted streams keep running.
 */
export async function admitStandalonePrepared(ctx: StandaloneAdmissionContext, item: FireItem): Promise<Admission> {
  let saved = false;
  let backoffMs = 0;
  const startedAt = Date.now();
  const interrupted = () => !ctx.owned() || ctx.signal.aborted;
  for (;;) {
    if (saved && !ctx.savedItemExists(item.key)) return 'refused';
    if (interrupted()) return saved ? 'capacity' : 'refused';
    // Only an already-authorized live drain may adopt this click. A stopped
    // drain's unanswered POST was awaited by the caller before entering here.
    if (ctx.queueOwned()) return saved || ctx.enqueue(item, false) ? 'queued' : 'refused';
    if (!saved) ctx.onFire();
    const request = ctx.makeRequest(item);
    markDrainOwned(request);
    const answer = await postUntilAnswered(ctx.generate, request);
    if (answer.kind === 'uncertain') {
      if (!ctx.enqueue(uncertainSubmissionItem(item, request), true)) return 'refused';
      ctx.onSaved?.();
      return 'saved';
    }
    if (answer.kind !== 'backpressure') {
      if (saved && answer.kind === 'started') ctx.retire(item.key);
      return answer.kind;
    }
    if (saved && !ctx.savedItemExists(item.key)) return 'refused';
    // Save before another POST, even if Stop arrived while the previous one
    // was unanswered. Unlike Stop, Clear/unmount makes enqueue refuse it.
    if (!saved) {
      if (!ctx.enqueue(item, true)) return 'refused';
      saved = true;
      ctx.onBackpressure();
    }
    if (!ctx.savedItemExists(item.key)) return 'refused';
    if (interrupted() || Date.now() - startedAt >= IDLE_BACKPRESSURE_BUDGET_MS) return 'capacity';
    backoffMs = nextBackpressureDelayMs(backoffMs, answer.retryAfterMs, false);
    const waitMs = Math.min(15_000, Math.max(answer.retryAfterMs, jitterRetryDelayMs(backoffMs)));
    await delay(waitMs, ctx.signal).catch(() => undefined);
  }
}
