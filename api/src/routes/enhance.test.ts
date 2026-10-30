import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import { allowJevForProviderTests, resetJevForProviderTests } from '../test/jev-fixture';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { addTestTextModel, legacyTextModelId, parseSse, restoreFetch, testRuntime, legacyTextUpstreamIds, pickLegacyTextModel } from '../test/helpers';
import { resetLlmAdmissionForTests } from '../orchestrator/llmAdmission';
import { writeAtomic } from '../storage/files';
import { type TestCliproxyTextProvider, type EnhanceChunk } from '../providers/cliproxyText';
import {
  ENHANCE_SYSTEM_PROMPT,
  KREA_ENHANCE_SYSTEM_PROMPT,
} from '../prompts/enhanceSystemPrompt';
import { SUNBURST_ENHANCE_SYSTEM_PROMPT } from '../prompts/gptSystemPrompt';

const TEXT_MODELS = legacyTextUpstreamIds();

// The api workspace runs every *.test.ts in one bun process; sibling suites
// (google/byok/keys/etc.) mock `globalThis.fetch`, and routes/keys.test.ts
// does so without restoring. This suite drives the real provider against
// local Bun.serve upstreams, so pin the genuinely-pristine fetch (captured at
// helpers' first import) before AND after each test.
const servers: Bun.Server<unknown>[] = [];
beforeEach(() => {
  allowJevForProviderTests();
  restoreFetch();
});
afterEach(async () => {
  resetJevForProviderTests();
  restoreFetch();
  resetLlmAdmissionForTests();
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});
function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
function chatSse(frames: readonly string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
function streamingChat(): { readonly response: Response; finish(): void } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    finish() {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\n`));
      controller?.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller?.close();
    },
  };
}
function post(app: ReturnType<typeof testRuntime>['app'], prompt: unknown, init: RequestInit = {}) {
  return app.fetch(new Request('http://local/api/enhance-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
    body: JSON.stringify({ prompt }),
    ...init,
  }));
}

async function seedUpload(
  runtime: ReturnType<typeof testRuntime>,
  userId: string,
  opts: { corrupt?: boolean } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  // 2x2 red PNG (valid) unless corrupt is requested.
  const png = await (await import('sharp')).default({
    create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
  const bytes = opts.corrupt ? new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]) : new Uint8Array(png);
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  runtime.db.query(
    "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', ?, 2, 2, ?, ?)",
  ).run(id, userId, bytes.byteLength, `sha-${id}`, now);
  await writeAtomic(runtime.config.DATA_DIR, 'uploads', userId, id, 'png', bytes);
  return id;
}

describe('POST /api/enhance-prompt', () => {
  test('400 on empty prompt', async () => {
    const { app } = testRuntime({ seedLegacyText: true });
    expect((await post(app, '   ')).status).toBe(400);
  });

  test('400 on oversized prompt', async () => {
    const { app } = testRuntime({ seedLegacyText: true });
    expect((await post(app, 'x'.repeat(MAX_PROMPT_CHARS + 1))).status).toBe(400);
  });

  test('streams delta events then done', async () => {
    const upstream = serve(() => chatSse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'a fluffy ' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'cat' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ]));
    const { app } = testRuntime({ seedLegacyText: true, CLIPROXY_BASE_URL: upstream, CLIPROXY_TOKEN: 'sk-x' });
    const res = await post(app, 'cat');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await parseSse(res);
    expect(events.map((e) => e.event)).toEqual(['delta', 'delta', 'done']);
    expect(events[0]?.data).toEqual({ text: 'a fluffy ' });
    expect(events[1]?.data).toEqual({ text: 'cat' });
    expect(events[2]?.data).toEqual({});
  });

  test('rejects concurrent enhance streams for the same user until the first releases', async () => {
    const pending = streamingChat();
    let upstreamRequestCount = 0;
    const upstream = serve(() => {
      upstreamRequestCount += 1;
      if (upstreamRequestCount === 1) return pending.response;
      return chatSse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'retry' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ]);
    });
    const { app } = testRuntime({
      seedLegacyText: true,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1',
    });

    const first = await post(app, 'cat');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');

    const blocked = await post(app, 'dog');
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: 'queue full',
      code: 'QUEUE_FULL',
      reason: 'per-user',
      retry_after_seconds: 5,
    });

    pending.finish();
    const firstEvents = await parseSse(first);
    expect(firstEvents.at(-1)?.event).toBe('done');

    const retry = await post(app, 'dog');
    expect(retry.status).toBe(200);
    const retryEvents = await parseSse(retry);
    expect(retryEvents.at(-1)?.event).toBe('done');
  });

  test('upstream non-200 emits a single safe error event and logs detail', async () => {
    const upstream = serve(() => new Response(JSON.stringify({ error: { message: 'leaky upstream detail' } }), { status: 500 }));
    const { app, logs } = testRuntime({ seedLegacyText: true, CLIPROXY_BASE_URL: upstream, CLIPROXY_TOKEN: 'sk-x', LOG_LEVEL: 'info' });
    const events = await parseSse(await post(app, 'cat'));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('error');
    expect((events[0]?.data as { message: string }).message).not.toContain('leaky upstream detail');
    expect(logs.join('\n')).toContain('leaky upstream detail');
  });

  test('route-level oversize maps to a single safe error event', async () => {
    const huge = 'z'.repeat(4000);
    const upstream = serve(() => chatSse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: huge }, finish_reason: null }] }),
    ]));
    const { app } = testRuntime({
      seedLegacyText: true,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
      CLIPROXY_TEXT_MAX_RESPONSE_BYTES: '256',
    });
    const events = await parseSse(await post(app, 'cat'));
    expect(events.some((e) => e.event === 'error')).toBe(true);
    expect(events.some((e) => e.event === 'done')).toBe(false);
  });

  test('a stalled upstream is bounded by the server-side timeout and surfaces a safe error', async () => {
    const upstream = serve(async () => {
      await Bun.sleep(5000); // never delivers within the test timeout window
      return chatSse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'too late' }, finish_reason: 'stop' }] }), '[DONE]']);
    });
    const { app, logs } = testRuntime({
      seedLegacyText: true,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
      CLOUD_TIMEOUT_MS: '60',
      LOG_LEVEL: 'info',
    });
    const events = await parseSse(await post(app, 'cat'));
    expect(events.some((e) => e.event === 'error')).toBe(true);
    expect(events.some((e) => e.event === 'done')).toBe(false);
    expect((events.find((e) => e.event === 'error')?.data as { message: string }).message)
      .not.toContain('timeout');
    expect(logs.join('\n')).toContain('enhance_timeout');
  });

  test('400 on non-uuid refImageIds', async () => {
    const { app } = testRuntime({ seedLegacyText: true });
    const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat', refImageIds: ['not-a-uuid'] }),
    }));
    expect(res.status).toBe(400);
  });

  test('400 on duplicate refImageIds', async () => {
    const { app } = testRuntime({ seedLegacyText: true });
    const id = crypto.randomUUID();
    const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat', refImageIds: [id, id] }),
    }));
    expect(res.status).toBe(400);
  });

  test('400 on more than 10 refImageIds', async () => {
    const { app } = testRuntime({ seedLegacyText: true });
    const ids = Array.from({ length: 11 }, () => crypto.randomUUID());
    const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat', refImageIds: ids }),
    }));
    expect(res.status).toBe(400);
  });

  test('empty refImageIds behaves like text-only (streams, no 400)', async () => {
    const upstream = serve(() => chatSse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'cat' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ]));
    const { app } = testRuntime({ seedLegacyText: true, CLIPROXY_BASE_URL: upstream, CLIPROXY_TOKEN: 'sk-x' });
    const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat', refImageIds: [] }),
    }));
    expect(res.status).toBe(200);
    expect((await parseSse(res)).at(-1)?.event).toBe('done');
  });

  test('attaches reference images as image_url parts to the upstream user message', async () => {
    let capturedBody: unknown;
    const upstream = serve(async (req) => {
      capturedBody = await req.json();
      return chatSse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'rewritten' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ]);
    });
    const runtime = testRuntime({ seedLegacyText: true, CLIPROXY_BASE_URL: upstream, CLIPROXY_TOKEN: 'sk-x' });
    const uploadId = await seedUpload(runtime, 'test');
    const res = await runtime.app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat', refImageIds: [uploadId] }),
    }));
    const events = await parseSse(res);
    expect(events.at(-1)?.event).toBe('done');
    const body = capturedBody as { messages: { role: string; content: unknown }[] };
    const user = body.messages.find((m) => m.role === 'user');
    const parts = user?.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toEqual({ type: 'text', text: 'cat' });
    expect(parts[1]?.type).toBe('image_url');
    expect(parts[1]?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  test('preserves refImageIds order across multiple image_url parts', async () => {
    let capturedBody: unknown;
    const upstream = serve(async (req) => {
      capturedBody = await req.json();
      return chatSse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'rewritten' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ]);
    });
    const runtime = testRuntime({ seedLegacyText: true, CLIPROXY_BASE_URL: upstream, CLIPROXY_TOKEN: 'sk-x' });
    const idA = await seedUpload(runtime, 'test');
    const idB = await seedUpload(runtime, 'test');
    const res = await runtime.app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat', refImageIds: [idA, idB] }),
    }));
    expect((await parseSse(res)).at(-1)?.event).toBe('done');
    const body = capturedBody as { messages: { role: string; content: unknown }[] };
    const parts = body.messages.find((m) => m.role === 'user')?.content as { type: string }[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'image_url']);
  });

  test('400 when a refImageId is not owned by the user', async () => {
    const upstream = serve(() => chatSse(['[DONE]']));
    const runtime = testRuntime({ seedLegacyText: true, CLIPROXY_BASE_URL: upstream, CLIPROXY_TOKEN: 'sk-x' });
    await seedUpload(runtime, 'alice');
    const bobId = await seedUpload(runtime, 'bob');
    const res = await runtime.app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ prompt: 'cat', refImageIds: [bobId] }),
    }));
    expect(res.status).toBe(400);
  });

  test('400 when the ref byte-total exceeds MAX_REF_BYTES_PER_BATCH', async () => {
    const upstream = serve(() => chatSse(['[DONE]']));
    const runtime = testRuntime({ seedLegacyText: true, CLIPROXY_BASE_URL: upstream, CLIPROXY_TOKEN: 'sk-x', MAX_REF_BYTES_PER_BATCH: '10' });
    const uploadId = await seedUpload(runtime, 'test'); // PNG > 10 bytes
    const res = await runtime.app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat', refImageIds: [uploadId] }),
    }));
    expect(res.status).toBe(400);
  });

  test('validates refs BEFORE the pool slot (invalid ref returns 400, not 429, while slot is held)', async () => {
    const pending = streamingChat();
    const upstream = serve(() => pending.response);
    const runtime = testRuntime({
      seedLegacyText: true,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1',
    });
    const bobId = await seedUpload(runtime, 'bob');
    // Occupy alice's single slot with a held stream.
    const first = await runtime.app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ prompt: 'cat' }),
    }));
    expect(first.status).toBe(200);
    // A not-owned ref must 400 from pre-slot validation, NOT 429 from the full pool.
    const blocked = await runtime.app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ prompt: 'dog', refImageIds: [bobId] }),
    }));
    expect(blocked.status).toBe(400);
    pending.finish();
    expect((await parseSse(first)).at(-1)?.event).toBe('done');
  });

  test('corrupt ref artifact emits a single safe error event (downscale failure)', async () => {
    const upstream = serve(() => chatSse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'unused' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ]));
    const runtime = testRuntime({ seedLegacyText: true, CLIPROXY_BASE_URL: upstream, CLIPROXY_TOKEN: 'sk-x' });
    const uploadId = await seedUpload(runtime, 'test', { corrupt: true });
    const res = await runtime.app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat', refImageIds: [uploadId] }),
    }));
    const events = await parseSse(res);
    expect(events.map((e) => e.event)).toEqual(['error']);
  });

  test('client abort tears the stream down cleanly (deliberate disconnect is silent)', async () => {
    const upstream = serve(async () => {
      await Bun.sleep(1000);
      return chatSse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'late' }, finish_reason: 'stop' }] }), '[DONE]']);
    });
    const { app, logs } = testRuntime({ seedLegacyText: true, CLIPROXY_BASE_URL: upstream, CLIPROXY_TOKEN: 'sk-x', LOG_LEVEL: 'info' });
    const ctrl = new AbortController();
    // app.fetch resolves with the streaming Response immediately; the abort
    // propagates via c.req.raw.signal to the upstream fetch + the route loop.
    const res = await post(app, 'cat', { signal: ctrl.signal });
    expect(res.status).toBe(200);
    ctrl.abort();
    let collected = '';
    try {
      collected = await res.text();
    } catch {
      // An AbortError surfacing here is acceptable — the point is no crash.
    }
    // Deliberate disconnect: the route must NOT log a crash and must NOT emit
    // a spurious `error` frame (mirrors useGenerate's silent-on-abort policy).
    expect(logs.join('\n')).not.toContain('enhance_stream_error');
    expect(collected).not.toContain('event: error');
  });
});

describe('POST /api/enhance-prompt — quota error surfacing', () => {
  afterEach(() => {
    setTextModelProviderForTests(null);
    resetLlmAdmissionForTests();
  });

  function fakeEnhanceProvider(chunks: AsyncGenerator<EnhanceChunk>): TestCliproxyTextProvider {
    return {
      async *enhance() {
        for await (const c of chunks) yield c;
      },
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
    };
  }

  async function* quotaChunk(): AsyncGenerator<EnhanceChunk> {
    await Promise.resolve();
    yield { type: 'failed', kind: 'quota', status: 429, detail: 'quota', retryAfterSeconds: 900 };
  }

  async function* providerErrorChunk(): AsyncGenerator<EnhanceChunk> {
    await Promise.resolve();
    yield { type: 'failed', kind: 'permanent', status: 400, detail: 'bad' };
  }

  test('quota failure on enhance → quota-exhausted code + retryAfterSeconds', async () => {
    setTextModelProviderForTests(fakeEnhanceProvider(quotaChunk()));
    const { app } = testRuntime({ seedLegacyText: true });
    const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat' }),
    }));
    const events = await parseSse(res);
    expect(events.map((e) => e.event)).toEqual(['error']);
    const err = events[0]?.data as { code?: string; retryAfterSeconds?: number; message?: string };
    expect(err.code).toBe('quota-exhausted');
    expect(err.retryAfterSeconds).toBe(900);
    expect(err.message).toBe('Codex quota exhausted');
  });

  test('modelId routes the system prompt: gpt-image and Krea get variants, gemini / missing keep provider default', async () => {
    const seen: (string | undefined)[] = [];
    setTextModelProviderForTests({
      async *enhance(_prompt, _images, _signal, systemPrompt) {
        seen.push(systemPrompt);
        await Promise.resolve();
        yield { type: 'delta', text: 'ok' } satisfies EnhanceChunk;
        yield { type: 'done' } satisfies EnhanceChunk;
      },
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
    });
    const { app } = testRuntime({ seedLegacyText: true, LOCAL_MODELS_USERS: 'test' });
    const call = async (body: Record<string, unknown>): Promise<void> => {
      const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify(body),
      }));
      await parseSse(res);
    };
    await call({ prompt: 'cat', modelId: 'gpt-image-2.5-sunburst' });
    await call({ prompt: 'cat', modelId: 'gemini-3-pro-image-preview' });
    await call({ prompt: 'cat' });
    await call({ prompt: 'cat', modelId: 'krea-2-gonzalomo' });
    await call({ prompt: 'portrait of an 18-year-old woman', modelId: 'krea-2-gonzalomo' });
    expect(seen[0]).toBe(SUNBURST_ENHANCE_SYSTEM_PROMPT);
    expect(seen[1]).toBeUndefined();
    expect(seen[2]).toBeUndefined();
    expect(seen[3]).toBe(KREA_ENHANCE_SYSTEM_PROMPT);
    expect(seen[4]).toBe(KREA_ENHANCE_SYSTEM_PROMPT);
  });

  // A Grok override reaches the non-Krea branch and behaves exactly like
  // every other backend: the gpt-image target names its variant, and a non-gpt
  // target sends NO system prompt so the provider substitutes its own default.
  test('an enhance override to Grok sends the same prompts as every other backend', async () => {
    const seen: (string | undefined)[] = [];
    setTextModelProviderForTests({
      async *enhance(_prompt, _images, _signal, systemPrompt) {
        seen.push(systemPrompt);
        await Promise.resolve();
        yield { type: 'delta', text: 'ok' } satisfies EnhanceChunk;
        yield { type: 'done' } satisfies EnhanceChunk;
      },
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
    });
    const { app, db } = testRuntime({ seedLegacyText: true, LOCAL_MODELS_USERS: 'test' });
    pickLegacyTextModel(db, 'test', 'enhance', 'grok');
    const call = async (body: Record<string, unknown>): Promise<void> => {
      const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify(body),
      }));
      await parseSse(res);
    };
    await call({ prompt: 'cat', modelId: 'gemini-3-pro-image-preview' });
    await call({ prompt: 'cat' });
    await call({ prompt: 'cat', modelId: 'gpt-image-2.5-sunburst' });
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBeUndefined();
    expect(seen[2]).toBe(SUNBURST_ENHANCE_SYSTEM_PROMPT);
  });

  // A Gemini override keeps the same system prompts on the wire, with the
  // provider resolved to the Gemini alias and its own default effort.
  test('an enhance override to Gemini Argon sends the stock prompts and the Gemini alias', async () => {
    const original = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
      return Promise.resolve(new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    try {
      const { app, db } = testRuntime({ seedLegacyText: true, LOCAL_MODELS_USERS: 'test' });
      pickLegacyTextModel(db, 'test', 'enhance', 'gemini-argon');
      const call = async (body: Record<string, unknown>): Promise<void> => {
        const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
          body: JSON.stringify(body),
        }));
        await parseSse(res);
      };
      await call({ prompt: 'cat', modelId: 'krea-2-gonzalomo' });
      await call({ prompt: 'cat' });
      expect(bodies.length).toBe(2);
      const [first, second] = bodies as [{ model: string }, Record<string, unknown>];
      const systemOf = (body: Record<string, unknown>): string =>
        ((body.messages as { role: string; content: string }[])[0] as { content: string }).content;
      expect(first).toMatchObject({ model: 'gemini-4-argon', reasoning_effort: 'low' });
      expect(systemOf(first)).toBe(
        KREA_ENHANCE_SYSTEM_PROMPT,
      );
      expect(systemOf(second)).toBe(
        ENHANCE_SYSTEM_PROMPT,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  // The Kimi/auto path must stay byte-identical to pre-override behaviour: a
  // non-gpt target still sends NO system prompt, not a named default.
  test('an enhance override to Kimi leaves the non-gpt system prompt undefined', async () => {
    const seen: (string | undefined)[] = [];
    setTextModelProviderForTests({
      async *enhance(_prompt, _images, _signal, systemPrompt) {
        seen.push(systemPrompt);
        await Promise.resolve();
        yield { type: 'delta', text: 'ok' } satisfies EnhanceChunk;
        yield { type: 'done' } satisfies EnhanceChunk;
      },
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
    });
    const { app, db } = testRuntime({ seedLegacyText: true, LOCAL_MODELS_USERS: 'test' });
    pickLegacyTextModel(db, 'test', 'enhance', 'kimi');
    const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat', modelId: 'gemini-3-pro-image-preview' }),
    }));
    await parseSse(res);
    expect(seen[0]).toBeUndefined();
  });

  test('a pinned enhance effort reaches the provider only for its pinned backend', async () => {
    const efforts: unknown[] = [];
    setTextModelProviderForTests({
      async *enhance(_prompt, _images, _signal, _systemPrompt, opts) {
        efforts.push(opts?.reasoningEffort);
        await Promise.resolve();
        yield { type: 'delta', text: 'ok' } satisfies EnhanceChunk;
        yield { type: 'done' } satisfies EnhanceChunk;
      },
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
    });
    const { app, db } = testRuntime({ seedLegacyText: true, LOCAL_MODELS_USERS: 'test' });
    pickLegacyTextModel(db, 'test', 'enhance', 'kimi', 'max');
    const call = async (modelId: string): Promise<void> => {
      await parseSse(await app.fetch(new Request('http://local/api/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'cat', modelId }),
      })));
    };
    await call('gemini-3-pro-image-preview');
    await call('krea-2-gonzalomo');
    await call('gpt-image-2.5-sunburst');
    expect(efforts).toEqual(['max', 'max', undefined]);
  });

  test('enhance uses GPT for gpt-image and Kimi for Krea with or without images, preserving vision', async () => {
    const requests: Record<string, unknown>[] = [];
    const upstream = serve(async (req) => {
      requests.push((await req.json()) as Record<string, unknown>);
      return chatSse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'enhanced' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ]);
    });
    const runtime = testRuntime({
      seedLegacyText: true,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
      LOCAL_MODELS_USERS: 'test',
    });
    const call = async (body: Record<string, unknown>): Promise<void> => {
      const res = await runtime.app.fetch(new Request('http://local/api/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ modelId: 'krea-2-gonzalomo', ...body }),
      }));
      expect((await parseSse(res)).at(-1)?.event).toBe('done');
    };
    const uploadId = await seedUpload(runtime, 'test');

    await call({ prompt: 'portrait without references' });
    await call({ prompt: 'portrait with a reference', refImageIds: [uploadId] });
    await call({ prompt: 'portrait without references', modelId: 'gpt-image-2.5-sunburst' });
    await call({ prompt: 'portrait with a reference', refImageIds: [uploadId], modelId: 'gpt-image-2.5-sunburst' });

    expect(requests.map((body) => body.model)).toEqual([
      TEXT_MODELS.kimi,
      TEXT_MODELS.kimi,
      'gpt-6.1-sol',
      'gpt-6.1-sol',
    ]);
    expect(requests[0]).toMatchObject({ reasoning_effort: 'low' });
    expect(requests[0]).not.toHaveProperty('thinking');
    expect(requests[1]).toMatchObject({ reasoning_effort: 'low' });
    expect(requests[1]).not.toHaveProperty('thinking');
    const systemPrompts = requests.map((body) => (
      body.messages as { role: string; content: unknown }[]
    ).find((message) => message.role === 'system')?.content);
    expect(systemPrompts).toEqual([
      KREA_ENHANCE_SYSTEM_PROMPT,
      KREA_ENHANCE_SYSTEM_PROMPT,
      SUNBURST_ENHANCE_SYSTEM_PROMPT,
      SUNBURST_ENHANCE_SYSTEM_PROMPT,
    ]);
    const userContent = (requests[1]?.messages as { role: string; content: unknown }[])
      .find((message) => message.role === 'user')?.content;
    expect(userContent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url' }),
    ]));
    const gptContent = (requests[3]?.messages as { role: string; content: unknown }[])
      .find((message) => message.role === 'user')?.content;
    expect(gptContent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url' }),
    ]));
  });

  // MiMo reads images (verified), so an image-carrying enhance stays
  // on a MiMo pin. DeepSeek Abliterated's vision is not yet verified, so the
  // same call on its pin yields to Kimi and the image never reaches it.
  test('an image-carrying enhance stays on a vision-capable pin and never reaches DeepSeek Abliterated', async () => {
    const requests: Record<string, unknown>[] = [];
    const upstream = serve(async (req) => {
      requests.push((await req.json()) as Record<string, unknown>);
      return chatSse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'enhanced' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ]);
    });
    const runtime = testRuntime({
      seedLegacyText: true,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
      LOCAL_MODELS_USERS: 'test',
    });
    const uploadId = await seedUpload(runtime, 'test');
    const call = async (prompt: string, refImageIds?: string[]): Promise<void> => {
      const res = await runtime.app.fetch(new Request('http://local/api/enhance-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt, modelId: 'krea-2-gonzalomo', ...(refImageIds ? { refImageIds } : {}) }),
      }));
      expect((await parseSse(res)).at(-1)?.event).toBe('done');
    };
    pickLegacyTextModel(runtime.db, 'test', 'enhance', 'mimo');
    await call('portrait with a reference', [uploadId]);
    pickLegacyTextModel(runtime.db, 'test', 'enhance', 'deepseek-abliterated');
    await call('portrait with a reference', [uploadId]);
    await call('portrait without references');

    expect(requests.map((body) => [body.model, body.reasoning_effort])).toEqual([
      ['mimo-v2.6-pro', 'none'],
      [TEXT_MODELS.kimi, 'low'],
      ['abliterated-model-large-flash', 'none'],
    ]);
    const userContentOf = (body: Record<string, unknown> | undefined): unknown =>
      (body?.messages as { role: string; content: unknown }[]).find((message) => message.role === 'user')?.content;
    for (const body of requests.slice(0, 2)) {
      expect(userContentOf(body)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'image_url' }),
      ]));
    }
    expect(typeof userContentOf(requests[2])).toBe('string');
    const systemOf = (body: Record<string, unknown> | undefined): unknown =>
      (body?.messages as { role: string; content: unknown }[]).find((message) => message.role === 'system')?.content;
    for (const body of requests) expect(systemOf(body)).toBe(KREA_ENHANCE_SYSTEM_PROMPT);
  });

  test('non-quota provider failure on enhance → provider-error code', async () => {
    setTextModelProviderForTests(fakeEnhanceProvider(providerErrorChunk()));
    const { app } = testRuntime({ seedLegacyText: true });
    const res = await app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify({ prompt: 'cat' }),
    }));
    const events = await parseSse(res);
    expect(events.map((e) => e.event)).toEqual(['error']);
    const err = events[0]?.data as { code?: string };
    expect(err.code).toBe('provider-error');
  });
});

describe('enhance text model routing failures', () => {
  function postEnhance(app: ReturnType<typeof testRuntime>['app'], body: Record<string, unknown>): Promise<Response> {
    return Promise.resolve(app.fetch(new Request('http://local/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
      body: JSON.stringify(body),
    })));
  }

  test('no text model → 409 TEXT_MODEL_NOT_CONFIGURED', async () => {
    const { app } = testRuntime();
    const res = await postEnhance(app, { prompt: 'a cat' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'No text model is set up. An admin can add one under Text models.',
      code: 'TEXT_MODEL_NOT_CONFIGURED',
    });
  });

  test('reference images with only text-only models → 409 TEXT_MODEL_NO_VISION', async () => {
    const runtime = testRuntime();
    const model = await addTestTextModel(runtime.text.store, { modelId: 'text-only', vision: false });
    runtime.text.store.setDefault('default', model.id);
    const res = await postEnhance(runtime.app, { prompt: 'a cat', refImageIds: [crypto.randomUUID()] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'None of the available text models accepts images. Remove the reference images or ask an admin to enable image input on a model.',
      code: 'TEXT_MODEL_NO_VISION',
    });
    // Without images the same model serves the call.
    expect((await postEnhance(runtime.app, { prompt: 'a cat' })).status).toBe(200);
  });

  test('a turned-off locked writer → 409 TEXT_MODEL_UNAVAILABLE', async () => {
    const runtime = testRuntime({ seedLegacyText: true });
    runtime.text.store.updateModel(legacyTextModelId(runtime.db, 'gpt'), { enabled: false });
    const res = await postEnhance(runtime.app, { prompt: 'a cat', modelId: 'gpt-image-2.5-sunburst' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('TEXT_MODEL_UNAVAILABLE');
  });
});
