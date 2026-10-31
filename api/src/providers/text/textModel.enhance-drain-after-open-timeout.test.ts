import { describe, expect, test } from 'bun:test';
import { buildResilientPolicy } from '../../lifecycle/resilient-call';
import { genericTextModel, testTextModelProvider } from '../../test/textModelProvider';

function delayedSseResponse(signal: AbortSignal | null | undefined): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => {
        controller.error(signal?.reason ?? new DOMException('aborted', 'AbortError'));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"delta1"}}]}\n\n'));
      setTimeout(() => {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"delta2"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }, 25);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('/enhance open timeout isolation', () => {
  test('open timeout does not abort body draining after headers are received', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: { readonly signal?: AbortSignal | null }) =>
      Promise.resolve(delayedSseResponse(init?.signal))) as unknown as typeof fetch;
    try {
      const provider = testTextModelProvider({ origin: 'http://x', token: 't', model: genericTextModel('m'), maxResponseBytes: 1_000_000, enhanceOpenTimeoutMs: 5, enhancePolicy: buildResilientPolicy({
          timeoutPerAttemptMs: 0,
          maxAttempts: 1,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          breakerThreshold: 8,
          halfOpenAfterMs: 30_000,
          noTimeout: true,
        }) });

      const chunks: string[] = [];
      let terminal = '';
      for await (const chunk of provider.enhance('hi', [], new AbortController().signal)) {
        if (chunk.type === 'delta') chunks.push(chunk.text);
        else {
          terminal = chunk.type;
          break;
        }
      }

      expect(chunks).toEqual(['delta1', 'delta2']);
      expect(terminal).toBe('done');
    } finally {
      globalThis.fetch = original;
    }
  });
});
