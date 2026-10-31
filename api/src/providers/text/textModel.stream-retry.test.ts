import { describe, expect, test } from 'bun:test';
import { buildResilientPolicy } from '../../lifecycle/resilient-call';
import { genericTextModel, testTextModelProvider } from '../../test/textModelProvider';

function sseJsonResponse(value: unknown): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) } }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function erroredBodyResponse(error: Error): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('textModel stream retry', () => {
  test('retries a 200 SSE body socket failure before parsing draftList output', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(erroredBodyResponse(new TypeError('connection reset')));
      return Promise.resolve(sseJsonResponse({ kind: 'entries', entries: ['navy'] }));
    }) as unknown as typeof fetch;
    try {
      const provider = testTextModelProvider({ origin: 'http://x', token: 't', model: genericTextModel('m'), maxResponseBytes: 1_000_000, draftListPolicy: buildResilientPolicy({
          timeoutPerAttemptMs: 5_000,
          maxAttempts: 2,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          breakerThreshold: 8,
          halfOpenAfterMs: 30_000,
        }) });

      const result = await provider.draftList(
        { name: 'Colours', existing: [], target: 5 },
        new AbortController().signal,
      );

      expect(calls).toBe(2);
      expect(result).toEqual({ type: 'ok', payload: { kind: 'entries', entries: ['navy'] } });
    } finally {
      globalThis.fetch = original;
    }
  });
});

test('repeated length finishes are one-attempt permanent failures and leave the real breaker closed', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(() => {
    calls++;
    const data = JSON.stringify({ choices: [{ delta: { content: '{"ops":[]}' }, finish_reason: 'length' }] });
    return Promise.resolve(new Response(`data: ${data}\n\ndata: [DONE]\n\n`));
  }, { preconnect: original.preconnect });
  try {
    const policy = buildResilientPolicy({ timeoutPerAttemptMs: 5_000, maxAttempts: 3,
      initialBackoffMs: 1, maxBackoffMs: 1, breakerThreshold: 2, halfOpenAfterMs: 30_000 });
    const provider = testTextModelProvider({ origin: 'http://x', token: 't', model: genericTextModel('m'), maxResponseBytes: 1_000_000, inferPolicy: policy, aiFillPolicy: policy });
    for (let index = 0; index < 5; index++) {
      const result = await provider.inferDimensions('{}', new AbortController().signal);
      expect(result).toMatchObject({ type: 'failed', kind: 'permanent', detail: 'length' });
      expect(provider.inferBreakerState?.()).toBe('closed');
    }
    const fill = await provider.aiFill({ systemPrompt: 'fill', userContent: 'blank' }, new AbortController().signal);
    expect(fill).toMatchObject({ type: 'failed', kind: 'permanent', detail: 'length' });
    expect(provider.inferBreakerState?.()).toBe('closed');
    expect(calls).toBe(6);
  } finally { globalThis.fetch = original; }
});

test('EOF without a successful terminal remains transient and retries before returning text', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(() => {
    if (++calls > 1) return Promise.resolve(sseJsonResponse({ kind: 'entries', entries: ['navy'] }));
    return Promise.resolve(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
  }, { preconnect: original.preconnect });
  try {
    const provider = testTextModelProvider({ origin: 'http://x', token: 't', model: genericTextModel('m'), maxResponseBytes: 1_000_000, draftListPolicy: buildResilientPolicy({ timeoutPerAttemptMs: 5_000, maxAttempts: 2, initialBackoffMs: 1,
        maxBackoffMs: 1, breakerThreshold: 8, halfOpenAfterMs: 30_000 }) });
    expect(await provider.draftList({ name: 'Colours', existing: [], target: 5 }, new AbortController().signal))
      .toEqual({ type: 'ok', payload: { kind: 'entries', entries: ['navy'] } });
    expect(calls).toBe(2);
  } finally { globalThis.fetch = original; }
});
