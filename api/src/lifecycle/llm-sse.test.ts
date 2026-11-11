import { describe, expect, spyOn, test } from 'bun:test';
import { createLlmSseStream } from './llm-sse';

describe('createLlmSseStream', () => {
  test('reader cancellation aborts the composed route signal', async () => {
    let routeSignal: AbortSignal | undefined;
    const stream = createLlmSseStream(
      { timeoutMs: 30_000, disconnect: new AbortController().signal },
      async ({ signal }) => {
        routeSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve(); }, { once: true });
        });
      },
    );

    const reader = stream.getReader();
    const cancelSettled = reader.cancel('test cancellation').then(() => true);
    const settled = await Promise.race([
      cancelSettled,
      new Promise<false>((resolve) => {
        setTimeout(() => { resolve(false); }, 50);
      }),
    ]);

    expect(settled).toBe(true);
    expect(routeSignal?.aborted).toBe(true);
  });

  async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
  }

  test('a slow reader never loses data frames below the abort threshold', async () => {
    const payload = 'x'.repeat(1024);
    let aborted = false;
    let release: (() => void) | undefined;
    const sent = new Promise<void>((resolve) => { release = resolve; });
    const stream = createLlmSseStream(
      { timeoutMs: 30_000, disconnect: new AbortController().signal },
      async ({ send, signal }) => {
        // 1 MiB of deltas with nobody reading: past the 256 KiB mark, far
        // below the overflow that ends the route.
        for (let i = 0; i < 1024; i += 1) send('delta', { i, payload });
        aborted = signal.aborted;
        release?.();
        await Promise.resolve();
      },
    );
    await sent;
    const text = await readAll(stream);
    expect(aborted).toBe(false);
    const indexes = [...text.matchAll(/"i":(\d+)/g)].map((match) => Number(match[1]));
    expect(indexes).toEqual(Array.from({ length: 1024 }, (_unused, i) => i));
  });

  test('keepalive comments are skipped while the queue is past its mark', async () => {
    const ticks: (() => void)[] = [];
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void) => {
      ticks.push(handler);
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);
    let finish: (() => void) | undefined;
    try {
      const stream = createLlmSseStream(
        { timeoutMs: 30_000, disconnect: new AbortController().signal },
        async ({ send }) => {
          const keepalive = (): void => { for (const tick of ticks) tick(); };
          keepalive();
          for (let i = 0; i < 300; i += 1) send('delta', { payload: 'y'.repeat(1024) });
          keepalive();
          await new Promise<void>((resolve) => { finish = resolve; });
        },
      );
      await Bun.sleep(0);
      finish?.();
      const text = await readAll(stream);
      // The idle keepalive went out; the one behind 300 KiB of deltas did not.
      expect(text.match(/^:keepalive$/gm)).toHaveLength(1);
      expect(text.startsWith(':keepalive')).toBe(true);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  test('a reader stalled far past the mark ends the route as a disconnect', async () => {
    let routeSignal: AbortSignal | undefined;
    let disconnected: (() => boolean) | undefined;
    let sentFrames = 0;
    const stream = createLlmSseStream(
      { timeoutMs: 30_000, disconnect: new AbortController().signal },
      async ({ send, signal, clientDisconnected }) => {
        routeSignal = signal;
        disconnected = clientDisconnected;
        const payload = 'z'.repeat(64 * 1024);
        while (!signal.aborted && sentFrames < 200) {
          send('delta', { payload });
          sentFrames += 1;
        }
        await Promise.resolve();
      },
    );
    await Bun.sleep(0);
    expect(routeSignal?.aborted).toBe(true);
    expect(disconnected?.()).toBe(true);
    // 256 KiB mark + 4 MiB overflow at 64 KiB per frame: about 70 frames.
    expect(sentFrames).toBeLessThan(80);
    await stream.getReader().cancel().catch(() => undefined);
  });
});
