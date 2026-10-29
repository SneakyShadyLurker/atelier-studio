import { abortReason } from '../lifecycle/abort';
import { createBoundedQueue } from '../lifecycle/boundedQueue';

export const MAX_CONCURRENT_THUMB_GEN = 4;
export const MAX_PENDING_THUMB_REQUESTS = 100;

export class ThumbQueueFullError extends Error {
  constructor() {
    super('thumb queue full');
    this.name = 'ThumbQueueFullError';
  }
}

const queue = createBoundedQueue({
  maxInFlight: MAX_CONCURRENT_THUMB_GEN,
  maxPending: MAX_PENDING_THUMB_REQUESTS,
  queueFullError: () => new ThumbQueueFullError(),
});

interface ThumbFlight {
  promise: Promise<Uint8Array>;
  admissionController: AbortController;
  callers: number;
  admitted: boolean;
}

const inFlightByTile = new Map<string, ThumbFlight>();

export function withSingleFlightAndCap(
  tileKey: string,
  gen: () => Promise<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // Two concurrent thumb requests for the same tile share one decode +
  // sharp pass — only one slot is acquired. The `inFlightByTile` set is
  // populated synchronously after `queue.run` schedules; subsequent
  // callers in the same microtask join the existing promise.
  //
  // The per-caller `signal` is NOT propagated into
  // the shared `queue.run` or `gen()`. If the leader aborted (e.g.,
  // navigated away) the shared work used to cancel mid-encode and reject
  // every follower with a 500 — leaving the on-disk cache empty. The
  // shared decode/encode now runs to completion regardless of any single
  // caller's lifetime; per-caller cancellation is satisfied by racing the
  // shared promise against the caller's signal, so followers stay
  // unaffected by the leader's abort and the cache is populated for the
  // next request.
  let flight = inFlightByTile.get(tileKey);
  if (!flight) {
    const admissionController = new AbortController();
    const runWork = (): Promise<Uint8Array> => {
      const current = inFlightByTile.get(tileKey);
      if (current) current.admitted = true;
      return gen();
    };
    flight = {
      admissionController,
      callers: 0,
      admitted: false,
      promise: Promise.reject(new Error('thumbnail flight not scheduled')),
    };
    flight.promise.catch(() => undefined);
    flight.promise = queue.run(runWork, admissionController.signal).finally(() => {
      // Identity-guarded: only evict if THIS promise still owns the key. A
      // stale cleanup from a settled promise must never delete a fresh entry
      // a later request (or, in tests, a later case) inserted for the same key.
      if (inFlightByTile.get(tileKey) === flight) inFlightByTile.delete(tileKey);
    });
    inFlightByTile.set(tileKey, flight);
  }
  flight.callers += 1;
  const releaseCaller = (): void => {
    flight.callers = Math.max(0, flight.callers - 1);
    if (flight.callers === 0 && !flight.admitted) {
      flight.admissionController.abort(new Error('all thumbnail callers aborted before admission'));
    }
  };
  if (!signal) {
    flight.promise.finally(releaseCaller).catch(() => undefined);
    return flight.promise;
  }
  if (signal.aborted) {
    // Don't let an already-aborted caller cancel a freshly-scheduled
    // shared promise; just reject locally.
    releaseCaller();
    return Promise.reject(abortReason(signal));
  }
  // Race the shared work against the per-caller signal so the caller's
  // abort surfaces to them without affecting siblings.
  return new Promise<Uint8Array>((resolve, reject) => {
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      releaseCaller();
    };
    const onAbort = (): void => {
      releaseOnce();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        releaseOnce();
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        releaseOnce();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function resetThumbRuntimeForTests(): void {
  queue.resetForTests();
  inFlightByTile.clear();
}
