// In-process concurrency queue with a pending-list ceiling. Two routes (thumb
// generation, upload parsing) need the exact same shape: cap N in-flight, queue
// up to M pending, throw past M, fair FIFO release. Previously cloned across
// `thumbs-runtime.ts` and `uploads-runtime.ts` with subtly different test
// hooks; centralizing here keeps the queue mechanics in one place.

import { abortReason } from './abort';

export interface BoundedQueueOptions {
  maxInFlight: number;
  maxPending: number;
  /** Thrown synchronously when both the in-flight and pending slots are saturated. */
  queueFullError: () => Error;
}

export interface BoundedQueue {
  /**
   * Run `fn` once a slot is free; returns its result or the queue-full error.
   * If `signal` is provided and fires while still waiting in `pending`, the
   * waiter is removed from the queue and the call rejects with `signal.reason`
   * without ever invoking `fn` or consuming an in-flight slot.
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Test-only teardown: drain the pending queue so every queued task is
   * admitted and runs to completion (callers gate on a deferred they resolve
   * right after, so nothing leaks). It must NOT zero `inFlightCount` first:
   * the previous code did, which discarded the slot accounting of tasks that
   * were ALREADY in-flight at reset time. Their later `releaseSlot()` then
   * decremented a counter rebuilt purely from the re-admitted pending tasks,
   * driving it below the true value so a subsequent test could over-admit
   * past maxInFlight (masking the cap regression this queue exists to catch).
   * Leaving `inFlightCount` intact keeps every acquire(+1) paired with its
   * release(-1); once all tasks settle the counter returns to 0 on its own.
   */
  resetForTests(): void;
  /** Current in-flight count; exposed for assertions. */
  readonly inFlightCount: number;
  /** Current pending-queue depth; exposed for assertions. */
  readonly pendingCount: number;
}

export function createBoundedQueue(opts: BoundedQueueOptions): BoundedQueue {
  let inFlightCount = 0;
  // Live waiters only: an aborting waiter splices itself out, so
  // `pending.length` is the real queue depth the maxPending gate checks.
  const pending: (() => void)[] = [];

  function acquireSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (inFlightCount < opts.maxInFlight) {
      inFlightCount += 1;
      return Promise.resolve();
    }
    if (pending.length >= opts.maxPending) {
      throw opts.queueFullError();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        inFlightCount += 1;
        resolve();
      };
      const onAbort = (): void => {
        const idx = pending.indexOf(waiter);
        if (idx !== -1) pending.splice(idx, 1);
        if (signal) reject(abortReason(signal));
      };
      pending.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function releaseSlot(): void {
    inFlightCount = Math.max(0, inFlightCount - 1);
    pending.shift()?.();
  }

  return {
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquireSlot(signal);
      // One more abort check between acquire and fn: if signal fires
      // during the microtask gap, surface signal.reason and release the
      // slot we just took rather than entering fn().
      if (signal?.aborted) {
        releaseSlot();
        throw abortReason(signal);
      }
      try {
        return await fn();
      } finally {
        releaseSlot();
      }
    },
    resetForTests(): void {
      const queued = pending.splice(0);
      for (const next of queued) next();
    },
    get inFlightCount() {
      return inFlightCount;
    },
    get pendingCount() {
      return pending.length;
    },
  };
}
