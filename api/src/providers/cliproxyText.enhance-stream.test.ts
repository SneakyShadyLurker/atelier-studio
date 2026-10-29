import { describe, expect, test } from 'bun:test';
import { buildResilientPolicy } from '../lifecycle/resilient-call';
import { createCliproxyTextProvider } from './cliproxyText';
import { testTextPolicies } from '../test/textPolicies';

function sseResponse(deltas: readonly string[]): Response {
  const payload =
    deltas
      .map((d) => `data: {"choices":[{"delta":{"content":${JSON.stringify(d)}}}]}\n\n`)
      .join('') + `data: [DONE]\n\n`;
  return new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function signalReasonAsError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

describe('/enhance open-policy and drain', () => {
  test('retries the open phase, then emits every delta after the policy returns', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response('boom', { status: 500 }));
      return Promise.resolve(sseResponse(['Hello, ', 'world', '!']));
    }) as unknown as typeof fetch;
    try {
      const provider = createCliproxyTextProvider({ ...testTextPolicies(),
        baseUrl: 'http://x',
        token: 't',
        model: 'm',
        maxResponseBytes: 1_000_000,
        enhanceOpenTimeoutMs: 30_000,
        enhancePolicy: buildResilientPolicy({
          timeoutPerAttemptMs: 0,
          maxAttempts: 2,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          breakerThreshold: 8,
          halfOpenAfterMs: 30_000,
          noTimeout: true,
        }),
      });

      const out: string[] = [];
      for await (const chunk of provider.enhance('hi', [], new AbortController().signal)) {
        if (chunk.type === 'delta') out.push(chunk.text);
        if (chunk.type === 'done' || chunk.type === 'failed') break;
      }

      expect(calls).toBe(2);
      expect(out.join('')).toBe('Hello, world!');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('retries a per-attempt open timeout before failing the stream', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    const stalledFetch = ((_input: unknown, init?: { readonly signal?: AbortSignal | null }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signalReasonAsError(signal));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(signalReasonAsError(signal));
          }, { once: true });
        });
      }
      return Promise.resolve(sseResponse(['Recovered']));
    }) as unknown as typeof fetch;
    globalThis.fetch = stalledFetch;
    try {
      const provider = createCliproxyTextProvider({ ...testTextPolicies(),
        baseUrl: 'http://x',
        token: 't',
        model: 'm',
        maxResponseBytes: 1_000_000,
        enhanceOpenTimeoutMs: 5,
        enhancePolicy: buildResilientPolicy({
          timeoutPerAttemptMs: 0,
          maxAttempts: 2,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          breakerThreshold: 8,
          halfOpenAfterMs: 30_000,
          noTimeout: true,
        }),
      });

      const out: string[] = [];
      for await (const chunk of provider.enhance('hi', [], new AbortController().signal)) {
        if (chunk.type === 'delta') out.push(chunk.text);
        if (chunk.type === 'done' || chunk.type === 'failed') break;
      }

      expect(calls).toBe(2);
      expect(out.join('')).toBe('Recovered');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('sends images as image_url parts on the user message', async () => {
    const original = globalThis.fetch;
    let capturedBody: unknown;
    globalThis.fetch = ((_input: unknown, init?: { body?: string }) => {
      capturedBody = JSON.parse(init?.body ?? '{}');
      return Promise.resolve(sseResponse(['ok']));
    }) as unknown as typeof fetch;
    try {
      const provider = createCliproxyTextProvider({ ...testTextPolicies(),
        baseUrl: 'http://x',
        token: 't',
        model: 'm',
        maxResponseBytes: 1_000_000,
        enhanceOpenTimeoutMs: 30_000,
      });
      const images = [{ bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }];
      for await (const chunk of provider.enhance('hi', images, new AbortController().signal)) {
        if (chunk.type === 'done' || chunk.type === 'failed') break;
      }
      const body = capturedBody as { messages: { role: string; content: unknown }[] };
      const user = body.messages.find((m) => m.role === 'user');
      expect(Array.isArray(user?.content)).toBe(true);
      const parts = user?.content as { type: string; text?: string; image_url?: { url: string } }[];
      expect(parts[0]).toEqual({ type: 'text', text: 'hi' });
      expect(parts[1]?.type).toBe('image_url');
      expect(parts[1]?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('sends a plain-string user message when no images', async () => {
    const original = globalThis.fetch;
    let capturedBody: unknown;
    globalThis.fetch = ((_input: unknown, init?: { body?: string }) => {
      capturedBody = JSON.parse(init?.body ?? '{}');
      return Promise.resolve(sseResponse(['ok']));
    }) as unknown as typeof fetch;
    try {
      const provider = createCliproxyTextProvider({ ...testTextPolicies(),
        baseUrl: 'http://x', token: 't', model: 'm', maxResponseBytes: 1_000_000, enhanceOpenTimeoutMs: 30_000,
      });
      for await (const chunk of provider.enhance('hi', [], new AbortController().signal)) {
        if (chunk.type === 'done' || chunk.type === 'failed') break;
      }
      const body = capturedBody as { messages: { role: string; content: unknown }[] };
      const user = body.messages.find((m) => m.role === 'user');
      expect(user?.content).toBe('hi');
    } finally {
      globalThis.fetch = original;
    }
  });
});
