import { afterEach, describe, expect, test } from 'bun:test';
import { resolveAiFill, resolveAiFillBatch, type AiFillModel } from './aiFill';
import { QuotaExhaustedError } from './sse';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sseResponse(text: string, status = 200): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

async function rejects(p: Promise<unknown>): Promise<boolean> {
  try { await p; return false; } catch { return true; }
}

const REQ = { staticSegments: ['A woman, ', ', golden hour.'], instructions: ['her swimsuit'], modelId: 'gpt-image-2.5-sunburst' };
const BATCH_REQ = { items: [{ staticSegments: REQ.staticSegments, instructions: REQ.instructions }], modelId: REQ.modelId };

describe('resolveAiFill', () => {
  test('reports the announced model, including one outside the migrated set', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(sseResponse(
        'event: backend\ndata: {"modelId":"ollama-llama-4-scout","label":"Llama 4 Scout"}\n\nevent: result\ndata: {"prompt":"A woman, a red bikini, golden hour.","fills":["a red bikini"]}\n\n',
      ))) as unknown as typeof fetch;
    const announced: AiFillModel[] = [];
    const out = await resolveAiFill(REQ, undefined, (model) => { announced.push(model); });
    expect(announced).toEqual([{ modelId: 'ollama-llama-4-scout', label: 'Llama 4 Scout' }]);
    expect(out.prompt).toBe('A woman, a red bikini, golden hour.');
    expect(out.fills).toEqual(['a red bikini']);
  });

  test('reports only id and label from a frame that also carries a legacy backend key', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(sseResponse(
        'event: backend\ndata: {"modelId":"kimi","label":"Kimi K3","backend":"kimi"}\n\nevent: result\ndata: {"prompt":"p","fills":["f"]}\n\n',
      ))) as unknown as typeof fetch;
    const announced: AiFillModel[] = [];
    await resolveAiFill(REQ, undefined, (model) => { announced.push(model); });
    expect(announced).toEqual([{ modelId: 'kimi', label: 'Kimi K3' }]);
  });

  test('drops a malformed backend frame and still resolves the result', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(sseResponse(
        'event: backend\ndata: {"backend":"kimi"}\n\nevent: backend\ndata: {"modelId":"","label":"x"}\n\nevent: backend\ndata: {"modelId":"kimi","label":7}\n\nevent: result\ndata: {"prompt":"A woman, a red bikini, golden hour.","fills":["a red bikini"]}\n\n',
      ))) as unknown as typeof fetch;
    const announced: AiFillModel[] = [];
    const out = await resolveAiFill(REQ, undefined, (model) => { announced.push(model); });
    expect(announced).toEqual([]);
    expect(out.prompt).toBe('A woman, a red bikini, golden hour.');
    expect(out.fills).toEqual(['a red bikini']);
  });

  test('returns the prompt + fills from a result frame', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(sseResponse(
        'event: result\ndata: {"prompt":"A woman, a red bikini, golden hour.","fills":["a red bikini"]}\n\n',
      ))) as unknown as typeof fetch;
    const out = await resolveAiFill(REQ);
    expect(out.prompt).toBe('A woman, a red bikini, golden hour.');
    expect(out.fills).toEqual(['a red bikini']);
  });

  test('throws on an error frame', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(sseResponse(
        'event: error\ndata: {"message":"Couldn\'t fill the prompt. Please try again.","code":"provider-error"}\n\n',
      ))) as unknown as typeof fetch;
    expect(await rejects(resolveAiFill(REQ))).toBe(true);
  });

  test('throws when the stream ends without a terminal event', async () => {
    globalThis.fetch = (() => Promise.resolve(sseResponse(': keepalive\n\n'))) as unknown as typeof fetch;
    expect(await rejects(resolveAiFill(REQ))).toBe(true);
  });

  test('retries a 429 (QUEUE_FULL) and succeeds when a slot frees', async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'queue full', code: 'QUEUE_FULL', retry_after_seconds: 1 }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ));
      }
      return Promise.resolve(sseResponse(
        'event: result\ndata: {"prompt":"A woman, a red bikini, golden hour.","fills":["a red bikini"]}\n\n',
      ));
    }) as unknown as typeof fetch;
    const out = await resolveAiFill(REQ);
    expect(calls).toBe(2);
    expect(out.prompt).toBe('A woman, a red bikini, golden hour.');
  });

  test('does not retry a routing quota 429 and preserves its retry hint', async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response(
        JSON.stringify({
          error: 'text quota exhausted',
          code: 'QUOTA_EXHAUSTED',
          retry_after_seconds: 900,
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ));
    }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await resolveAiFill(REQ);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QuotaExhaustedError);
    expect((caught as QuotaExhaustedError).retryAfterSeconds).toBe(900);
    expect(calls).toBe(1);
  });

  test('a 429 wait aborts immediately when the signal fires (no hang)', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ retry_after_seconds: 1 }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }))) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = resolveAiFill(REQ, ac.signal);
    ac.abort();
    expect(await rejects(p)).toBe(true);
  });
});

describe('resolveAiFillBatch', () => {
  test('reports every valid model group and returns guarded ordered items', async () => {
    globalThis.fetch = (() => Promise.resolve(sseResponse(
      'event: backend\ndata: {"modelId":"kimi","label":"Kimi K3"}\n\nevent: backend\ndata: {"modelId":"grok","label":"Grok 4.7"}\n\nevent: backend\ndata: {"backend":"bogus"}\n\nevent: result\ndata: {"items":[{"ok":true,"prompt":"filled","fills":["fill"]}]}\n\n',
    ))) as unknown as typeof fetch;
    const announced: AiFillModel[] = [];
    const result = await resolveAiFillBatch(BATCH_REQ, undefined, (model) => { announced.push(model); });
    // A malformed backend frame is dropped, never thrown.
    expect(announced).toEqual([{ modelId: 'kimi', label: 'Kimi K3' }, { modelId: 'grok', label: 'Grok 4.7' }]);
    expect(result.items).toEqual([{ ok: true, prompt: 'filled', fills: ['fill'] }]);
  });

  test('rejects a malformed or wrong-cardinality result payload', async () => {
    globalThis.fetch = (() => Promise.resolve(sseResponse(
      'event: result\ndata: {"items":[{"ok":true,"prompt":"filled"}]}\n\n',
    ))) as unknown as typeof fetch;
    expect(await rejects(resolveAiFillBatch(BATCH_REQ))).toBe(true);

    globalThis.fetch = (() => Promise.resolve(sseResponse(
      'event: result\ndata: {"items":[]}\n\n',
    ))) as unknown as typeof fetch;
    expect(await rejects(resolveAiFillBatch(BATCH_REQ))).toBe(true);
  });

  test('retries typed QUEUE_FULL and succeeds when a batch slot frees', async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'queue full', code: 'QUEUE_FULL', retry_after_seconds: 0 }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ));
      }
      return Promise.resolve(sseResponse(
        'event: result\ndata: {"items":[{"ok":false}]}\n\n',
      ));
    }) as unknown as typeof fetch;
    expect((await resolveAiFillBatch(BATCH_REQ)).items).toEqual([{ ok: false }]);
    expect(calls).toBe(2);
  });
});
