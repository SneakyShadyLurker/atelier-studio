import { describe, expect, test } from 'bun:test';
import { readBytesBounded } from './_http';

function neverOversize(): never {
  throw new Error('oversize should not fire in this test');
}

describe('readBytesBounded', () => {
  test('throws AbortError when the signal aborts between chunks', async () => {
    // Audit 01-concurrency MED: the read loop used to rely on Bun's
    // fetch-to-body signal propagation. We now explicitly check the caller's
    // AbortSignal between chunks so a future runtime change can't strand
    // the loop buffering bytes after a parent abort.
    //
    // Simulate a slow-streaming upstream by feeding small chunks on a timer.
    // The signal aborts before the stream closes — the loop's per-iteration
    // signal check must throw an AbortError, NOT wait for end-of-stream.
    let pushIdx = 0;
    const chunks = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
      new Uint8Array([9, 10]),
    ];
    const streamHandle: { controller: ReadableStreamDefaultController<Uint8Array> | null } = {
      controller: null,
    };
    let closed = false;
    let pushTimer: ReturnType<typeof setTimeout> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamHandle.controller = controller;
        const pushNext = () => {
          if (closed) return;
          const chunk = chunks[pushIdx];
          if (chunk !== undefined) {
            controller.enqueue(chunk);
            pushIdx += 1;
            // 30ms between chunks so the read loop spins through iterations.
            pushTimer = setTimeout(pushNext, 30);
          }
          // Never close — only abort or the finally cancel teardown ends the read.
        };
        pushNext();
      },
    });

    const abortController = new AbortController();
    const start = Date.now();
    const promise = readBytesBounded(stream, 1024 * 1024, {
      onOversize: neverOversize,
      signal: abortController.signal,
    });

    // Wait long enough for the loop to consume at least one chunk and be
    // blocking on the next reader.read() — then abort. The reader.cancel()
    // in the finally unblocks the pending read and the signal check throws.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    abortController.abort();

    let threw: unknown;
    try {
      await promise;
    } catch (error) {
      threw = error;
    }

    const elapsed = Date.now() - start;
    expect(threw).toBeDefined();
    expect((threw as { name?: string }).name).toBe('AbortError');
    // Bails promptly — orders of magnitude less than the simulated stream's
    // total duration (3 chunks × 30ms = 90ms minimum to drain naturally).
    expect(elapsed).toBeLessThan(500);
    // Defensive: end the source stream so the timer chain stops scheduling.
    closed = true;
    // pushTimer is reassigned inside the source-stream's setTimeout callback; narrowing forgets this across closure boundaries.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (pushTimer !== null) clearTimeout(pushTimer);
    try { streamHandle.controller?.close(); } catch { /* may already be closed */ }
  });

  test('cancels a pending read when the signal aborts mid-flight (no in-flight stall)', async () => {
    // Audit T2-003: a stream that never produces another chunk used to pin
    // the loop on `await reader.read()` past the abort budget. The fix
    // attaches an abort listener that calls reader.cancel() so the pending
    // read rejects/settles promptly.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        // intentionally never close, never enqueue again
      },
    });
    const controller = new AbortController();
    const start = Date.now();
    const promise = readBytesBounded(stream, 1024, {
      onOversize: neverOversize,
      signal: controller.signal,
    });

    // Give the loop one tick to consume the initial chunk and block on the
    // next read, then abort. With the fix, reader.cancel() unblocks the
    // pending read; without it the call would hang.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    controller.abort();

    let threw: unknown;
    let resolved = false;
    try {
      await promise;
      resolved = true;
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - start;
    // Settled means either resolved normally OR threw — both are acceptable
    // here; the load-bearing assertion is that it didn't pin on the never-
    // closing stream.
    expect(resolved || threw !== undefined).toBe(true);
    // Either the cancelled read returns done (no throw — the loop exits
    // normally and the post-loop throwIfAborted catches the abort) or the
    // pending read rejects with the abort reason. Both are acceptable; the
    // load-bearing assertion is that the call settles promptly rather than
    // pinning on the never-closing stream.
    if (threw) {
      expect((threw as { name?: string }).name).toBe('AbortError');
    }
    // Promptly: well under 100ms even on a slow CI runner.
    expect(elapsed).toBeLessThan(100);
  });

  test('refuses to start when the signal is already aborted at entry', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const controller = new AbortController();
    controller.abort();

    let threw: unknown;
    try {
      await readBytesBounded(stream, 1024, {
        onOversize: neverOversize,
        signal: controller.signal,
      });
    } catch (error) {
      threw = error;
    }

    expect(threw).toBeDefined();
    expect((threw as { name?: string }).name).toBe('AbortError');
  });

  test('completes normally when the signal is never aborted', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    const controller = new AbortController();
    const out = await readBytesBounded(stream, 1024, {
      onOversize: neverOversize,
      signal: controller.signal,
    });
    expect(out).toEqual(data);
  });

  test('honors the oversize callback (signal-aware path does not bypass byte cap)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2048));
        controller.close();
      },
    });
    const captured: { args: { lim: number; total: number } | null } = { args: null };
    let threw: unknown;
    try {
      await readBytesBounded(stream, 100, {
        onOversize: (lim, total) => {
          captured.args = { lim, total };
          throw new Error(`oversize ${lim}/${total}`);
        },
      });
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeDefined();
    expect(captured.args).not.toBeNull();
    expect(captured.args?.lim).toBe(100);
  });
});
