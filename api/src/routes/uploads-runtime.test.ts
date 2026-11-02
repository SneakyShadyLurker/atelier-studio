import { afterEach, describe, expect, test } from 'bun:test';
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_CONCURRENT_UPLOADS_PER_USER,
  MAX_PENDING_UPLOADS_PER_USER,
  UploadQueueFullError,
  resetUploadsRuntimeForTests,
  withUploadSlot,
} from './uploads-runtime';

afterEach(() => {
  resetUploadsRuntimeForTests();
});

function deferred(): { promise: Promise<undefined>; resolve: () => void } {
  let resolveFn: () => void = () => undefined;
  const promise = new Promise<undefined>((resolve) => {
    resolveFn = () => { resolve(undefined); };
  });
  return { promise, resolve: resolveFn };
}

describe('withUploadSlot per-user fairness', () => {
  test('a single user can queue more than MAX_CONCURRENT_UPLOADS_PER_USER without 503', async () => {
    // Burst representative of the worst-case Composer dispatch (Gemini accepts
    // up to 10 reference images). The per-user layer must serialize, not
    // reject, so every accepted upload eventually completes.
    const burst = 10;
    const gates = Array.from({ length: burst }, () => deferred());
    const completed: number[] = [];

    const runs = gates.map((gate, index) =>
      withUploadSlot('alice', () => gate.promise.then(() => { completed.push(index); })),
    );

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(completed.length).toBe(burst);
  });

  test('rejects with UploadQueueFullError once a user exceeds MAX_PENDING_UPLOADS_PER_USER + in-flight', async () => {
    // Fill in-flight slots with held tasks so the per-user counter cannot
    // advance, then push the pending list to its cap and prove the next
    // attempt 503s instead of queueing without bound.
    const inFlightGates = Array.from({ length: MAX_CONCURRENT_UPLOADS_PER_USER }, () => deferred());
    const pendingGates = Array.from({ length: MAX_PENDING_UPLOADS_PER_USER }, () => deferred());
    const inFlight = inFlightGates.map((gate) =>
      withUploadSlot('alice', () => gate.promise),
    );
    const pending = pendingGates.map((gate) =>
      withUploadSlot('alice', () => gate.promise),
    );

    let overflowError: unknown;
    try {
      await withUploadSlot('alice', () => Promise.resolve());
    } catch (err) {
      overflowError = err;
    }
    expect(overflowError).toBeInstanceOf(UploadQueueFullError);

    for (const gate of inFlightGates) gate.resolve();
    for (const gate of pendingGates) gate.resolve();
    await Promise.all([...inFlight, ...pending]);
  });

  test('one user cannot starve another (cross-user fairness)', async () => {
    // alice saturates her per-user slots; bob's upload must still proceed
    // (subject only to the global pool, which has free slots here).
    const aliceGates = Array.from({ length: MAX_CONCURRENT_UPLOADS_PER_USER }, () => deferred());
    const aliceRuns = aliceGates.map((gate) =>
      withUploadSlot('alice', () => gate.promise),
    );

    let bobCompleted = false;
    const bobRun = withUploadSlot('bob', () => {
      bobCompleted = true;
      return Promise.resolve();
    });
    await Promise.resolve();
    await bobRun;
    expect(bobCompleted).toBe(true);

    for (const gate of aliceGates) gate.resolve();
    await Promise.all(aliceRuns);
  });

  test('aborting a queued caller removes it from the per-user waiter list and rejects with signal.reason', async () => {
    // Saturate alice's in-flight slots so the next call has to queue.
    const inFlightGates = Array.from({ length: MAX_CONCURRENT_UPLOADS_PER_USER }, () => deferred());
    const inFlight = inFlightGates.map((gate) => withUploadSlot('alice', () => gate.promise));

    const controller = new AbortController();
    const reason = new Error('caller went away');
    const queued = withUploadSlot('alice', () => Promise.resolve('should-not-run'), controller.signal);

    // Give the event loop a tick so the waiter is actually parked in the FIFO.
    await Promise.resolve();
    controller.abort(reason);

    let caught: unknown;
    try {
      await queued;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(reason);

    // A subsequent same-user call should be admitted immediately on the next
    // release: the aborted waiter must not be holding a slot.
    let nextRan = false;
    inFlightGates[0]?.resolve();
    await withUploadSlot('alice', () => {
      nextRan = true;
      return Promise.resolve();
    });
    expect(nextRan).toBe(true);

    for (let i = 1; i < inFlightGates.length; i += 1) inFlightGates[i]?.resolve();
    await Promise.all(inFlight);
  });

  test('global cap still bounds parallel work across users', async () => {
    // MAX_CONCURRENT_UPLOADS distinct users each holding one slot saturates
    // the global pool; any further request from a fresh user must wait for
    // one of them to release.
    const heldGates = Array.from({ length: MAX_CONCURRENT_UPLOADS }, () => deferred());
    const held = heldGates.map((gate, index) =>
      withUploadSlot(`user-${index}`, () => gate.promise),
    );

    let queuedStarted = false;
    const queued = withUploadSlot('latecomer', () => {
      queuedStarted = true;
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(queuedStarted).toBe(false);

    heldGates[0]?.resolve();
    await queued;
    expect(queuedStarted).toBe(true);

    for (let index = 1; index < heldGates.length; index += 1) heldGates[index]?.resolve();
    await Promise.all(held);
  });
});
