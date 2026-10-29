import { describe, expect, test } from 'bun:test';
import {
  MAX_CONCURRENT_THUMB_GEN,
  MAX_PENDING_THUMB_REQUESTS,
  resetThumbRuntimeForTests,
  ThumbQueueFullError,
  withSingleFlightAndCap,
} from '../storage/thumbRuntime';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve: () => {
      if (!resolve) throw new Error('deferred resolver missing');
      resolve();
    },
  };
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('thumb runtime single-flight and cap', () => {
  test('collapses concurrent generation for the same tile key', async () => {
    resetThumbRuntimeForTests();
    let calls = 0;
    const gate = deferred();
    const requests = Array.from({ length: 10 }, () =>
      withSingleFlightAndCap('user/tile', async () => {
        calls += 1;
        await gate.promise;
        return new Uint8Array([9]);
      }),
    );

    await Bun.sleep(0);
    expect(calls).toBe(1);
    gate.resolve();
    const results = await Promise.all(requests);
    expect(results).toHaveLength(10);
    expect(results.every((result) => result[0] === 9)).toBe(true);
  });

  test('limits concurrent generation across distinct keys to four', async () => {
    resetThumbRuntimeForTests();
    let current = 0;
    let max = 0;
    const gates = Array.from({ length: 8 }, () => deferred());
    const requests = gates.map((gate, index) =>
      withSingleFlightAndCap(`user/tile-${index}`, async () => {
        current += 1;
        max = Math.max(max, current);
        await gate.promise;
        current -= 1;
        return new Uint8Array([index]);
      }),
    );

    await Bun.sleep(0);
    expect(max).toBe(4);
    expect(current).toBe(4);

    for (const gate of gates) gate.resolve();
    const results = await Promise.all(requests);
    expect(results.map((result) => result[0]).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test('rejects new distinct requests when the pending thumbnail queue is full', async () => {
    resetThumbRuntimeForTests();
    let calls = 0;
    const gate = deferred();
    const acceptedCount = MAX_CONCURRENT_THUMB_GEN + MAX_PENDING_THUMB_REQUESTS;
    const accepted = Array.from({ length: acceptedCount }, (_, index) =>
      withSingleFlightAndCap(`user/tile-${index}`, async () => {
        calls += 1;
        await gate.promise;
        return new Uint8Array([index % 256]);
      }),
    );

    await Bun.sleep(0);
    expect(calls).toBe(MAX_CONCURRENT_THUMB_GEN);

    const overLimit = withSingleFlightAndCap('user/tile-over-limit', () => Promise.resolve(new Uint8Array([1])));
    expect(await rejectedValue(overLimit)).toBeInstanceOf(ThumbQueueFullError);

    resetThumbRuntimeForTests();
    gate.resolve();
    const settled = await Promise.allSettled(accepted);
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
  });

  test('drops aborted pending distinct requests from the bounded queue', async () => {
    resetThumbRuntimeForTests();
    const gate = deferred();
    const controllers = Array.from({ length: MAX_PENDING_THUMB_REQUESTS }, () => new AbortController());

    const running = Array.from({ length: MAX_CONCURRENT_THUMB_GEN }, (_, index) =>
      withSingleFlightAndCap(`user/running-${index}`, async () => {
        await gate.promise;
        return new Uint8Array([index]);
      }),
    );

    const pending = controllers.map((controller, index) =>
      withSingleFlightAndCap(
        `user/pending-${index}`,
        () => Promise.resolve(new Uint8Array([index])),
        controller.signal,
      ),
    );

    await Bun.sleep(0);
    for (const controller of controllers) controller.abort(new Error('caller left'));
    await Promise.all(pending.map((promise) => rejectedValue(promise)));

    const acceptedAfterAbort = withSingleFlightAndCap(
      'user/accepted-after-abort',
      () => Promise.resolve(new Uint8Array([7])),
    );

    gate.resolve();
    await Promise.all(running);
    expect((await acceptedAfterAbort)[0]).toBe(7);
  });
});
