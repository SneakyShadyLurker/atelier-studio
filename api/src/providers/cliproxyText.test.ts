import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createCliproxyTextProvider, type EnhanceCallOptions } from './cliproxyText';
import { restoreFetch } from '../test/helpers';
import { testTextPolicies } from '../test/textPolicies';

// Sibling api suites mock globalThis.fetch in the shared bun process (and
// routes/keys.test.ts does not restore it); this suite drives the real
// provider against local Bun.serve upstreams, so pin the genuinely-pristine
// fetch (captured at helpers' first import) before AND after each test.
const servers: Bun.Server<unknown>[] = [];
beforeEach(() => {
  restoreFetch();
});
afterEach(async () => {
  restoreFetch();
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

function collect(baseUrl: string, opts?: {
  maxResponseBytes?: number;
  model?: string;
  callOptions?: EnhanceCallOptions;
}) {
  const provider = createCliproxyTextProvider({ ...testTextPolicies(),
    baseUrl,
    token: 'sk-test',
    model: opts?.model ?? 'kimi-latest',
    backend: 'kimi',
    maxResponseBytes: opts?.maxResponseBytes ?? 1024 * 1024,
  });
  return (async () => {
    const out: unknown[] = [];
    for await (const c of provider.enhance(
      'a cat',
      [],
      new AbortController().signal,
      undefined,
      opts?.callOptions,
    )) out.push(c);
    return out as { type: string; text?: string; detail?: string; status?: number | null }[];
  })();
}

describe('cliproxyText provider', () => {
  // The CoT text itself is still discarded — `reasoning` carries no payload,
  // it only marks that the model started thinking.
  test('signals reasoning once, forwards only delta.content, then done', async () => {
    const baseUrl = serve(() => chatSse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking...' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'still thinking...' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'a ' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'fluffy cat' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ]));
    expect(await collect(baseUrl)).toEqual([
      { type: 'reasoning' },
      { type: 'delta', text: 'a ' },
      { type: 'delta', text: 'fluffy cat' },
      { type: 'done' },
    ]);
  });

  test('sends Bearer auth, chat path, and the locked request body', async () => {
    let auth: string | undefined;
    let path = '';
    let body: Record<string, unknown> = {};
    const baseUrl = serve(async (req) => {
      auth = req.headers.get('authorization') ?? undefined;
      path = new URL(req.url).pathname;
      body = (await req.json()) as Record<string, unknown>;
      return chatSse([JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] }), '[DONE]']);
    });
    await collect(baseUrl);
    expect(auth).toBe('Bearer sk-test');
    expect(path).toBe('/v1/chat/completions');
    expect(body).toMatchObject({
      model: 'kimi-latest',
      stream: true,
      reasoning_effort: 'low',
      max_completion_tokens: 36_000,
    });
    expect(body).not.toHaveProperty('verbosity');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('thinking');
    const messages = body.messages as { role: string }[];
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]).toMatchObject({ role: 'user', content: 'a cat' });
  });

  test('Kimi preserves vision and strict schema without host cache fields or affinity headers', async () => {
    let body: Record<string, unknown> = {};
    let affinity = null as string | null;
    const baseUrl = serve(async (req) => {
      body = await req.json() as Record<string, unknown>;
      affinity = req.headers.get('x-session-affinity');
      return chatSse([
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'private reasoning' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '{"color":"red"}' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ]);
    });
    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'color', strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          properties: { color: { type: 'string', enum: ['red', 'blue'] } }, required: ['color'],
        },
      },
    };
    const provider = createCliproxyTextProvider({ ...testTextPolicies(),
      baseUrl, token: 'sk-test', model: 'kimi-latest', backend: 'kimi', maxResponseBytes: 1_000_000,
    });
    const chunks = [];
    for await (const chunk of provider.enhance('identify the color', [
      { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' },
    ], new AbortController().signal, 'inspect the image', {
      responseFormat,
    })) chunks.push(chunk);
    expect(body).toMatchObject({
      model: 'kimi-latest', stream: true, reasoning_effort: 'low',
      max_completion_tokens: 36_000, response_format: responseFormat,
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'inspect the image' },
      { role: 'user', content: [
        { type: 'text', text: 'identify the color' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      ] },
    ]);
    for (const key of ['verbosity', 'thinking', 'prompt_cache_key', 'perf_metrics_in_response', 'safe_tokenization']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(affinity).toBeNull();
    expect(chunks).toEqual([
      { type: 'reasoning' }, { type: 'delta', text: '{"color":"red"}' }, { type: 'done' },
    ]);
  });

  for (const reason of [undefined, 'length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'stop', 'DONE']) {
    test(`enhance requires a successful terminal after text: ${reason ?? 'EOF'}`, async () => {
      let calls = 0;
      const baseUrl = serve(() => {
        calls++;
        return chatSse([
          JSON.stringify({ choices: [{ delta: { content: 'partial text' }, finish_reason: reason === 'DONE' ? null : reason }] }),
          ...(reason === undefined ? [] : ['[DONE]']),
        ]);
      });
      const chunks = await collect(baseUrl);
      expect(chunks[0]).toEqual({ type: 'delta', text: 'partial text' });
      if (reason === 'stop' || reason === 'DONE') expect(chunks.at(-1)).toEqual({ type: 'done' });
      else {
        expect(chunks.at(-1)).toMatchObject({ type: 'failed' });
        expect(chunks).not.toContainEqual({ type: 'done' });
      }
      expect(calls).toBe(1);
    });
  }

  test('finish_reason terminates even without [DONE]', async () => {
    const baseUrl = serve(() => chatSse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'done text' }, finish_reason: 'stop' }] }),
    ]));
    expect(await collect(baseUrl)).toEqual([{ type: 'delta', text: 'done text' }, { type: 'done' }]);
  });

  test('clean EOF with zero content is a failure', async () => {
    const baseUrl = serve(() => chatSse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'only thinking' }, finish_reason: null }] }),
    ]));
    // Reasoning alone never satisfies the content requirement.
    expect(await collect(baseUrl)).toEqual([
      { type: 'reasoning' },
      { type: 'failed', status: null, detail: 'stream ended without content' },
    ]);
  });

  test('finish_reason with zero content is a failure, not a silent done', async () => {
    const baseUrl = serve(() => chatSse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thought but said nothing' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ]));
    expect(await collect(baseUrl)).toEqual([
      { type: 'reasoning' },
      { type: 'failed', status: null, detail: 'stream ended without content' },
    ]);
  });

  test('in-stream {error} payload yields failed with detail (after any partial)', async () => {
    const baseUrl = serve(() => chatSse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] }),
      JSON.stringify({ error: { message: 'context length exceeded' } }),
    ]));
    const out = await collect(baseUrl);
    expect(out[0]).toEqual({ type: 'delta', text: 'partial' });
    expect(out[1]).toMatchObject({ type: 'failed', status: null });
    expect((out[1] as { detail: string }).detail).toContain('context length exceeded');
  });

  test('event: error frame yields failed', async () => {
    const baseUrl = serve(() => new Response(
      `event: error\ndata: ${JSON.stringify({ message: 'upstream blew up' })}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const out = await collect(baseUrl);
    expect(out[0]).toMatchObject({ type: 'failed' });
    expect((out[0] as { detail: string }).detail).toContain('upstream blew up');
  });

  // CLIProxyAPI 7.2.50 pretty-prints JSON payloads inside SSE frames (only the
  // first line carries the data: prefix). frameDataText recovery must keep the
  // real error detail on the text routes too — not the mangled "{" the
  // spec-compliant parse leaves behind.
  test('pretty-printed multi-line error frame keeps its real detail', async () => {
    const baseUrl = serve(() => new Response(
      'event: error\ndata: {\n  "error": {\n    "message": "quota exhausted for kimi-k3",\n    "code": "usage_limit_reached"\n  }\n}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const out = await collect(baseUrl);
    expect(out[0]).toMatchObject({ type: 'failed' });
    expect((out[0] as { detail: string }).detail).toContain('quota exhausted');
  });

  test('non-200 yields a failed chunk with bounded detail', async () => {
    const baseUrl = serve(() => new Response(JSON.stringify({ error: { message: 'bad model' } }), { status: 400 }));
    const out = await collect(baseUrl);
    expect(out[0]).toMatchObject({ type: 'failed', status: 400 });
    expect((out[0] as { detail: string }).detail).toContain('bad model');
  });

  test('oversize stream fails instead of buffering unbounded', async () => {
    const huge = 'y'.repeat(5000);
    const baseUrl = serve(() => chatSse([JSON.stringify({ choices: [{ index: 0, delta: { content: huge }, finish_reason: null }] })]));
    const out = await collect(baseUrl, { maxResponseBytes: 256 });
    expect(out[0]).toMatchObject({ type: 'failed' });
    expect((out[0] as { detail: string }).detail).toContain('exceeded');
  });

  test('draftTemplate preserves known padded var tokens and strips @N from unknown warnings', async () => {
    const baseUrl = serve(() => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            kind: 'body',
            body: 'Known {{var:: face @1 }} unknown {{var:: mood @2 }}',
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const provider = createCliproxyTextProvider({ ...testTextPolicies(),
      baseUrl,
      token: 'sk-test',
      model: 'kimi-latest',
      maxResponseBytes: 1024 * 1024,
    });

    const result = await provider.draftTemplate({
      name: 'portrait',
      existingBody: '',
      library: {
        lists: [{ name: 'face', optionCount: 1, samples: ['freckled'] }],
      },
    }, new AbortController().signal);

    expect(result.type).toBe('ok');
    if (result.type !== 'ok' || result.payload.kind !== 'body') throw new Error('expected body result');
    expect(result.payload.body).toBe('Known {{var:: face @1 }} unknown mood');
    expect(result.payload.warnings).toEqual(['Removed unknown {{var::mood}} reference']);
  });
});
