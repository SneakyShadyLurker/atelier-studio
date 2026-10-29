import { afterEach, describe, expect, test } from 'bun:test';
import { buildResilientPolicy } from '../lifecycle/resilient-call';
import { createCliproxyTextProvider } from './cliproxyText';
import { testTextPolicies } from '../test/textPolicies';

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

function sse(content: string): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('provider.inferDimensions', () => {
  test('returns parsed ops on success', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      return Promise.resolve(sse('{"ops":[{"op":"createDimension","name":"F","tags":["a"]}]}'));
    }) as unknown as typeof fetch;
    const p = createCliproxyTextProvider({ ...testTextPolicies(), baseUrl: 'http://x', token: 't', model: 'kimi-latest', backend: 'kimi', maxResponseBytes: 1e6 });
    const r = await p.inferDimensions('SNAPSHOT_JSON', new AbortController().signal);
    expect(r).toEqual({ type: 'ok', ops: [{ op: 'createDimension', name: 'F', tags: ['a'] }] });
    expect(body).toMatchObject({
      model: 'kimi-latest',
      reasoning_effort: 'low',
      max_completion_tokens: 36000,
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('verbosity');
  });

  test('rescue sends the Kimi JSON request shape', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      return Promise.resolve(sse('{"ops":[]}'));
    }) as unknown as typeof fetch;
    const p = createCliproxyTextProvider({ ...testTextPolicies(), baseUrl: 'http://x', token: 't', model: 'kimi-latest', backend: 'kimi', maxResponseBytes: 1e6 });
    await p.rescueDimension({
      previewSnapshot: { dimensions: [], lists: [] },
      templateLists: [],
      targetListName: 'missing',
      conflictReason: 'test',
    }, new AbortController().signal);
    expect(body).toMatchObject({
      model: 'kimi-latest',
      reasoning_effort: 'low',
      max_completion_tokens: 36000,
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('verbosity');
  });

  test('unparseable -> failed', async () => {
    globalThis.fetch = (() => Promise.resolve(sse('not json'))) as unknown as typeof fetch;
    const p = createCliproxyTextProvider({ ...testTextPolicies(), baseUrl: 'http://x', token: 't', model: 'kimi-latest', backend: 'kimi', maxResponseBytes: 1e6 });
    const r = await p.inferDimensions('S', new AbortController().signal);
    expect(r.type).toBe('failed');
  });
});

describe('provider.inferTaxonomy', () => {
  test('is implemented and returns parsed ops on success', async () => {
    globalThis.fetch = (() => Promise.resolve(sse('{"ops":[{"op":"createDimension","name":"F","tags":["a"]}]}'))) as unknown as typeof fetch;
    const p = createCliproxyTextProvider({ ...testTextPolicies(), baseUrl: 'http://x', token: 't', model: 'kimi-latest', backend: 'kimi', maxResponseBytes: 1e6 });
    expect(typeof p.inferTaxonomy).toBe('function');
    const r = await p.inferTaxonomy('SNAPSHOT_JSON', new AbortController().signal);
    expect(r).toEqual({ type: 'ok', ops: [{ op: 'createDimension', name: 'F', tags: ['a'] }] });
  });

  test('routes through the taxonomy policy, not inferPolicy (distinct retry budget)', async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response('boom', { status: 500 }));
    }) as unknown as typeof fetch;
    const p = createCliproxyTextProvider({ ...testTextPolicies(),
      baseUrl: 'http://x',
      token: 't',
      model: 'kimi-latest',
      maxResponseBytes: 1e6,
      // inferPolicy retries 3x on transient 5xx; taxonomyPolicy is single-shot.
      inferPolicy: buildResilientPolicy({
        timeoutPerAttemptMs: 5_000, maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 1, breakerThreshold: 8, halfOpenAfterMs: 30_000,
      }),
      taxonomyPolicy: buildResilientPolicy({
        timeoutPerAttemptMs: 5_000, maxAttempts: 1, initialBackoffMs: 1, maxBackoffMs: 1, breakerThreshold: 8, halfOpenAfterMs: 30_000,
      }),
    });
    await p.inferTaxonomy('{}', new AbortController().signal);
    expect(calls).toBe(1);
    calls = 0;
    await p.inferDimensions('{}', new AbortController().signal);
    expect(calls).toBe(3);
  });

  test('infer path honors inferMaxResponseBytes, not the smaller maxResponseBytes', async () => {
    globalThis.fetch = (() => Promise.resolve(sse('{"ops":[]}'))) as unknown as typeof fetch;
    // The SSE frame is ~80 raw bytes — far over a 10-byte global cap, but well
    // under the larger infer cap. Proves infer/taxonomy use inferMaxResponseBytes.
    const big = createCliproxyTextProvider({ ...testTextPolicies(), baseUrl: 'http://x', token: 't', model: 'kimi-latest', backend: 'kimi', maxResponseBytes: 10, inferMaxResponseBytes: 1_000_000 });
    expect(await big.inferDimensions('S', new AbortController().signal)).toEqual({ type: 'ok', ops: [] });
    expect(await big.inferTaxonomy('S', new AbortController().signal)).toEqual({ type: 'ok', ops: [] });

    // Without the override, infer falls back to the tiny global cap and trips.
    const small = createCliproxyTextProvider({ ...testTextPolicies(), baseUrl: 'http://x', token: 't', model: 'kimi-latest', backend: 'kimi', maxResponseBytes: 10 });
    expect((await small.inferDimensions('S', new AbortController().signal)).type).toBe('failed');
  });

  test('a per-attempt timeout is classified transient (so the route retries, not aborts)', async () => {
    // fetch never settles → the policy's aggressive per-attempt timeout fires
    // and cockatiel rejects with TaskCancelledError ("Operation timed out…").
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const p = createCliproxyTextProvider({ ...testTextPolicies(),
      baseUrl: 'http://x', token: 't', model: 'kimi-latest', backend: 'kimi', maxResponseBytes: 1e6,
      inferPolicy: buildResilientPolicy({
        timeoutPerAttemptMs: 60, maxAttempts: 1, initialBackoffMs: 1, maxBackoffMs: 1, breakerThreshold: 8, halfOpenAfterMs: 30_000,
      }),
    });
    const r = await p.inferDimensions('S', new AbortController().signal);
    expect(r.type).toBe('failed');
    expect((r as { kind?: string }).kind).toBe('transient');
  });
});
