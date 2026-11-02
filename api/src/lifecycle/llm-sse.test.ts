import { describe, expect, test } from 'bun:test';
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
});
