import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { allowJevForProviderTests, resetJevForProviderTests } from './jev-fixture';
import pino from 'pino';
import { generateEvents, jsonRequest, testRuntime } from './helpers';
import { buildReferenceImagePayloads, createCliproxyProvider } from '../providers/cliproxy';
import { CLIPROXY_RATIO_SIZES } from '../providers/cliproxy.config';
import type { ProviderRequest } from '../providers/types';
import { sanitizeProviderError } from '../orchestrator/sanitize';
import { pngBytes, progressiveJpegBytes, webpVp8xBytes } from './image-fixtures';

const pngFixture = pngBytes();
const pngBase64 = Buffer.from(pngFixture).toString('base64');
const jpegBase64 = Buffer.from(progressiveJpegBytes()).toString('base64');
const webpBase64 = Buffer.from(webpVp8xBytes()).toString('base64');
const servers: Bun.Server<unknown>[] = [];
beforeEach(allowJevForProviderTests);
const silentLogger = pino({ level: 'silent' });

afterEach(async () => {
  resetJevForProviderTests();
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function sseResponse(frames: readonly { event: string; data: unknown }[]): Response {
  const body = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function messageOnlySse(frames: readonly { data: unknown }[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f.data)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function completedSse(b64: string, revised?: string): Response {
  const data = revised ? { b64_json: b64, revised_prompt: revised } : { b64_json: b64 };
  return sseResponse([{ event: 'image_generation.completed', data }]);
}

function providerReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    prompt: 'paint a quiet workstation',
    modelId: 'gpt-image-2.5-sunburst',
    ratio: '1:1',
    tileIndex: 0,
    seed: 123,
    ...overrides,
  };
}

async function firstResult(baseUrl: string, overrides: Partial<ProviderRequest> = {}) {
  const provider = createCliproxyProvider({ baseUrl, token: 'sk-cliproxy-test', maxResponseBytes: 50 * 1024 * 1024 });
  for await (const result of provider.generate(providerReq(overrides), new AbortController().signal)) {
    return result;
  }
  return null;
}

async function collectResults(baseUrl: string, overrides: Partial<ProviderRequest> = {}) {
  const provider = createCliproxyProvider({ baseUrl, token: 'sk-cliproxy-test', maxResponseBytes: 50 * 1024 * 1024 });
  const collected: { status: string }[] = [];
  for await (const result of provider.generate(providerReq(overrides), new AbortController().signal)) {
    collected.push(result);
  }
  return collected;
}

describe('CLIProxyAPI provider', () => {
  test('sends locked gpt-image-2.5-sunburst body without n and decodes the response', async () => {
    let seenBody: Record<string, unknown> | undefined;
    let auth: string | undefined;
    const baseUrl = serve(async (req) => {
      auth = req.headers.get('authorization') ?? undefined;
      seenBody = await req.json() as Record<string, unknown>;
      return completedSse(pngBase64, 'rewritten');
    });

    const result = await firstResult(baseUrl, { ratio: '16:9' });

    expect(auth ?? '').toBe('Bearer sk-cliproxy-test');
    expect(seenBody ?? {}).toEqual({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'paint a quiet workstation',
      size: '3840x2160',
      quality: 'xhigh',
      output_format: 'png',
      moderation: 'low',
      stream: true,
      partial_images: 3,
    });
    expect(seenBody ?? {}).not.toHaveProperty('n');
    expect(seenBody ?? {}).not.toHaveProperty('output_compression');
    expect(result).toMatchObject({ status: 'ready', ext: 'png', mime: 'image/png', seed: 123 });
    expect(Array.from((result as { bytes: Uint8Array }).bytes)).toEqual(Array.from(pngFixture));
  });

  test('maps each ratio to a size that PRESERVES that ratio', () => {
    // This rewrite asserts the math, not a hard-coded table — any future
    // tweak to CLIPROXY_RATIO_SIZES is forced to satisfy the contract.
    const ratios: Record<string, [number, number]> = {
      '1:1': [1, 1],
      '4:5': [4, 5],
      '3:4': [3, 4],
      '16:9': [16, 9],
      '9:16': [9, 16],
    };
    for (const [ratio, size] of Object.entries(CLIPROXY_RATIO_SIZES)) {
      const [w, h] = size.split('x').map(Number) as [number, number];
      const expectedRatio = ratios[ratio];
      if (!expectedRatio) throw new Error(`missing ratio fixture: ${ratio}`);
      const [num, den] = expectedRatio;
      expect(w / h).toBeCloseTo(num / den, 3);
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
      expect(w * h).toBeGreaterThanOrEqual(655_360);
      expect(w * h).toBeLessThanOrEqual(8_294_400);
      expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
      expect(Math.max(w, h) / Math.min(w, h)).toBeLessThanOrEqual(3);
    }
  });

  test('jpeg output yields jpg/image-jpeg', async () => {
    let seenBody: Record<string, unknown> | undefined;
    const baseUrl = serve(async (req) => {
      seenBody = await req.json() as Record<string, unknown>;
      return completedSse(jpegBase64);
    });
    const provider = createCliproxyProvider({
      baseUrl,
      token: 'token',
      maxResponseBytes: 50 * 1024 * 1024,
      outputFormat: 'jpeg',
    });

    const result = await (async () => {
      for await (const item of provider.generate(providerReq(), new AbortController().signal)) return item;
      return null;
    })();

    expect(seenBody ?? {}).toMatchObject({ output_format: 'jpeg' });
    expect(seenBody ?? {}).not.toHaveProperty('output_compression');
    expect(result).toMatchObject({ status: 'ready', ext: 'jpg', mime: 'image/jpeg' });
  });

  test('webp output yields webp/image-webp', async () => {
    let seenBody: Record<string, unknown> | undefined;
    const baseUrl = serve(async (req) => {
      seenBody = await req.json() as Record<string, unknown>;
      return completedSse(webpBase64);
    });
    const provider = createCliproxyProvider({
      baseUrl,
      token: 'token',
      maxResponseBytes: 50 * 1024 * 1024,
      outputFormat: 'webp',
    });

    const result = await (async () => {
      for await (const item of provider.generate(providerReq(), new AbortController().signal)) return item;
      return null;
    })();

    expect(seenBody ?? {}).toMatchObject({ output_format: 'webp' });
    expect(seenBody ?? {}).not.toHaveProperty('output_compression');
    expect(result).toMatchObject({ status: 'ready', ext: 'webp', mime: 'image/webp' });
  });

  test('completion event without b64_json yields failed provider result', async () => {
    const baseUrl = serve(() =>
      sseResponse([{ event: 'image_generation.completed', data: {} }]),
    );
    const result = await firstResult(baseUrl);
    expect(result).toMatchObject({ status: 'failed' });
    expect(sanitizeProviderError((result as { error: unknown }).error, silentLogger)).toBe('internal error');
  });

  test('stream that ends without a completion event yields failed provider result', async () => {
    const baseUrl = serve(() => sseResponse([]));
    const result = await firstResult(baseUrl);
    expect(result).toMatchObject({ status: 'failed' });
    expect(sanitizeProviderError((result as { error: unknown }).error, silentLogger)).toBe('connection lost');
  });

  test('partial frames are yielded before the final ready result', async () => {
    const baseUrl = serve(() =>
      sseResponse([
        { event: 'image_generation.partial_image', data: { partial_image_index: 0, b64_json: pngBase64 } },
        { event: 'image_generation.partial_image', data: { partial_image_index: 1, b64_json: pngBase64 } },
        { event: 'image_generation.completed', data: { b64_json: pngBase64 } },
      ]),
    );
    const provider = createCliproxyProvider({ baseUrl, token: 'token', maxResponseBytes: 50 * 1024 * 1024 });
    const collected: { status: string }[] = [];
    for await (const item of provider.generate(providerReq(), new AbortController().signal)) {
      collected.push(item);
    }
    expect(collected.map((item) => item.status)).toEqual(['partial', 'partial', 'ready']);
    const partials = collected.filter((item): item is { status: 'partial'; preview: string; index: number; seed: number } => item.status === 'partial');
    expect(partials[0]).toMatchObject({ index: 0 });
    expect(partials[0]?.preview.startsWith('data:image/png;base64,')).toBe(true);
    expect(partials[1]).toMatchObject({ index: 1 });
  });

  test('image_edit partial frames are yielded like generation partials', async () => {
    const baseUrl = serve(() =>
      sseResponse([
        { event: 'image_edit.partial_image', data: { partial_image_index: 0, b64_json: pngBase64 } },
        { event: 'image_edit.completed', data: { b64_json: pngBase64 } },
      ]),
    );
    const collected = await collectResults(baseUrl, {
      refImages: [{ bytes: pngFixture, mime: 'image/png' }],
    });
    expect(collected.map((item) => item.status)).toEqual(['partial', 'ready']);
    const partial = collected[0] as { status: 'partial'; preview: string; index: number };
    expect(partial.preview.startsWith('data:image/png;base64,')).toBe(true);
    expect(partial.index).toBe(0);
  });

  test('frames missing the SSE event line fall back to payload.type dispatch', async () => {
    // Simulates a future cliproxy variant that drops the `event:` line
    // and only carries the type inside the JSON payload.
    const body =
      `data: ${JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: pngBase64 })}\n\n` +
      `data: ${JSON.stringify({ type: 'image_generation.completed', b64_json: pngBase64 })}\n\n`;
    const baseUrl = serve(
      () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const provider = createCliproxyProvider({ baseUrl, token: 'token', maxResponseBytes: 50 * 1024 * 1024 });
    const collected: { status: string }[] = [];
    for await (const item of provider.generate(providerReq(), new AbortController().signal)) {
      collected.push(item);
    }
    expect(collected.map((item) => item.status)).toEqual(['partial', 'ready']);
  });

  test('accepts raw Responses API partial and completed event shapes', async () => {
    const baseUrl = serve(() =>
      sseResponse([
        {
          event: 'response.image_generation_call.partial_image',
          data: { partial_image_index: 0, partial_image_b64: pngBase64 },
        },
        {
          event: 'response.completed',
          data: {
            response: {
              output: [{ type: 'image_generation_call', result: pngBase64, revised_prompt: 'revised' }],
            },
          },
        },
      ]),
    );
    const collected = await collectResults(baseUrl);
    expect(collected.map((item) => item.status)).toEqual(['partial', 'ready']);
    expect(collected[0]).toMatchObject({ status: 'partial', index: 0, batchIndex: 0 });
    expect(collected[1]).toMatchObject({ status: 'ready', revisedPrompt: 'revised' });
  });

  test('classifies raw Responses API failure events', async () => {
    const baseUrl = serve(() =>
      sseResponse([
        {
          event: 'response.failed',
          data: {
            type: 'response.failed',
            response: { status: 'failed', error: { code: 'server_error', message: 'upstream disconnected' } },
          },
        },
      ]),
    );
    const result = await firstResult(baseUrl);

    expect(result).toMatchObject({
      status: 'failed',
      error: { status: 502, reason: { kind: 'http', status: 502 } },
    });
  });

  test('frames missing the SSE event line fall back to image_edit payload.type dispatch', async () => {
    const baseUrl = serve(() =>
      messageOnlySse([
        { data: { type: 'image_edit.completed', b64_json: pngBase64 } },
      ]),
    );
    const result = await firstResult(baseUrl, {
      refImages: [{ bytes: pngFixture, mime: 'image/png' }],
    });
    expect(result).toMatchObject({ status: 'ready', ext: 'png', mime: 'image/png' });
  });

  test('image_edit completed event with b64_json returns PNG bytes', async () => {
    const baseUrl = serve(() =>
      sseResponse([
        { event: 'image_edit.completed', data: { b64_json: pngBase64 } },
      ]),
    );
    const result = await firstResult(baseUrl, {
      refImages: [{ bytes: pngFixture, mime: 'image/png' }],
    });
    expect(result).toMatchObject({ status: 'ready' });
    const bytes = (result as { bytes: Uint8Array }).bytes;
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test('reference images route to edits with ordered data URLs', async () => {
    let seenPath = '';
    let seenBody: Record<string, unknown> | undefined;
    const jpegFixture = progressiveJpegBytes();
    const baseUrl = serve(async (req) => {
      seenPath = new URL(req.url).pathname;
      seenBody = await req.json() as Record<string, unknown>;
      return sseResponse([{ event: 'image_edit.completed', data: { b64_json: pngBase64 } }]);
    });

    const result = await firstResult(baseUrl, {
      refImages: [
        { bytes: pngFixture, mime: 'image/png' },
        { bytes: jpegFixture, mime: 'image/jpeg' },
      ],
    });

    expect(result).toMatchObject({ status: 'ready' });
    expect(seenPath).toBe('/v1/images/edits');
    expect(seenBody ?? {}).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'paint a quiet workstation',
      size: '2880x2880',
      quality: 'xhigh',
      output_format: 'png',
      moderation: 'low',
      stream: true,
      partial_images: 3,
      response_format: 'b64_json',
    });
    const images = (seenBody?.images ?? []) as { image_url: string }[];
    expect(images).toHaveLength(2);
    expect(images[0]?.image_url).toBe(`data:image/png;base64,${pngBase64}`);
    expect(images[1]?.image_url).toBe(`data:image/jpeg;base64,${Buffer.from(jpegFixture).toString('base64')}`);
  });

  test('reference image URL invariant rejects non-image data URLs before fetch', () => {
    expect(() =>
      buildReferenceImagePayloads([{ bytes: pngFixture, mime: 'text/plain' }]),
    ).toThrow('invalid reference image data URL');
  });

  test('event: error frame is remapped to status:400 so moderation rejections classify correctly', async () => {
    // The SSE response itself is HTTP 200 (the stream succeeded). But
    // semantically an in-stream error frame is a request rejection — the
    // cliproxy adapter remaps it to status:400 so the sanitizer's
    // status-400 + moderation-keyword branch can tag it correctly.
    // Without the remap, the sanitizer would fall through to the
    // generic invalid_request_error branch and emit 'upstream rejected'.
    const baseUrl = serve(() =>
      sseResponse([
        { event: 'error', data: { error: { type: 'invalid_request_error', message: 'moderation blocked' } } },
      ]),
    );
    const result = await firstResult(baseUrl);
    expect(result).toMatchObject({ status: 'failed' });
    expect(sanitizeProviderError((result as { error: unknown }).error, silentLogger)).toBe('content-policy violation');
  });

  test('partial url with non-matching mime is rejected (XSS surface)', async () => {
    const baseUrl = serve(() =>
      sseResponse([
        // cliproxy claims a SVG/HTML payload — adapter MUST drop it.
        { event: 'image_generation.partial_image', data: { partial_image_index: 0, url: 'data:image/svg+xml;base64,PHN2Zy8+' } },
        { event: 'image_generation.completed', data: { b64_json: pngBase64 } },
      ]),
    );
    const provider = createCliproxyProvider({ baseUrl, token: 'token', maxResponseBytes: 50 * 1024 * 1024 });
    const collected: { status: string }[] = [];
    for await (const item of provider.generate(providerReq(), new AbortController().signal)) {
      collected.push(item);
    }
    // No partial yielded — the SVG `data:` URL was filtered. Only the
    // final ready result reaches the orchestrator.
    expect(collected.map((item) => item.status)).toEqual(['ready']);
  });

  test('mid-stream byte overflow aborts cleanly with response-too-large', async () => {
    // Build an SSE stream large enough to trip a 1 KB cap. Single data
    // line of 2 KB satisfies that without needing terminal events.
    const huge = 'x'.repeat(2048);
    const baseUrl = serve(() =>
      sseResponse([{ event: 'image_generation.partial_image', data: { partial_image_index: 0, b64_json: huge } }]),
    );
    const provider = createCliproxyProvider({ baseUrl, token: 'token', maxResponseBytes: 1024 });
    const collected: { status: string }[] = [];
    for await (const item of provider.generate(providerReq(), new AbortController().signal)) {
      collected.push(item);
    }
    const failure = collected.find((item) => item.status === 'failed') as { status: 'failed'; error: unknown } | undefined;
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure?.error)).toContain('exceeded 1024 bytes');
  });

  test('stream that closes after a partial without a completion fails the tile', async () => {
    const baseUrl = serve(() =>
      sseResponse([
        { event: 'image_generation.partial_image', data: { partial_image_index: 0, b64_json: pngBase64 } },
      ]),
    );
    const provider = createCliproxyProvider({ baseUrl, token: 'token', maxResponseBytes: 50 * 1024 * 1024 });
    const collected: { status: string }[] = [];
    for await (const item of provider.generate(providerReq(), new AbortController().signal)) {
      collected.push(item);
    }
    expect(collected.map((item) => item.status)).toEqual(['partial', 'failed']);
  });

  test('yields categorized failures for CLIProxyAPI errors and network errors', async () => {
    const cases = [
      [400, { error: { type: 'invalid_request_error', message: 'moderation blocked' } }, 'content-policy violation'],
      [429, { error: { message: 'rate limit exceeded' } }, 'upstream rejected'],
      [504, { error: { message: 'upstream timed out' } }, 'timed out'],
      [500, { error: { message: 'boom' } }, 'internal error'],
    ] as const;

    for (const [status, body, expected] of cases) {
      const baseUrl = serve(() => Response.json(body, { status }));
      const result = await firstResult(baseUrl);
      expect(result).toMatchObject({ status: 'failed' });
      expect(sanitizeProviderError((result as { error: unknown }).error, silentLogger)).toBe(expected);
    }

    const networkResult = await firstResult('http://127.0.0.1:1');
    expect(networkResult).toMatchObject({ status: 'failed' });
    expect(sanitizeProviderError((networkResult as { error: unknown }).error, silentLogger)).toBe('internal error');
  });

  test('passes AbortSignal through fetch', async () => {
    const baseUrl = serve(async () => {
      await Bun.sleep(1_000);
      return completedSse(pngBase64);
    });
    const provider = createCliproxyProvider({ baseUrl, token: 'token', maxResponseBytes: 50 * 1024 * 1024 });
    const abort = new AbortController();
    const run = (async () => {
      for await (const item of provider.generate(providerReq(), abort.signal)) return item;
      return null;
    })();

    await Bun.sleep(10);
    abort.abort(new Error('client disconnected'));

    let caught: unknown = null;
    try {
      await run;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  test('registry exposes gpt-image-2.5-sunburst and fan-out performs one POST per tile', async () => {
    let posts = 0;
    const baseUrl = serve(() => {
      posts += 1;
      return completedSse(pngBase64, 'rewritten');
    });
    const { app, logs } = testRuntime({ CLIPROXY_BASE_URL: baseUrl, CLIPROXY_TOKEN: 'sk-cliproxy-test', LOG_LEVEL: 'info' });

    const modelsRes = await app.fetch(new Request('http://local/api/models', { headers: { 'Remote-User': 'test' } }));
    const models = await modelsRes.json() as { id: string }[];
    expect(models.some((model) => model.id === 'gpt-image-2.5-sunburst')).toBe(true);

    const events = await generateEvents(app, {
      prompt: 'x',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 4,
    });
    expect(events.filter((event) => event.event === 'tile')).toHaveLength(4);
    expect(posts).toBe(4);
    expect(logs.join('\n')).not.toContain('rewritten');
    expect(logs.join('\n')).not.toContain('sk-cliproxy-test');
  });

  test('orchestrator forwards cliproxy partial frames to the SSE wire as tile events', async () => {
    const baseUrl = serve(() =>
      sseResponse([
        { event: 'image_generation.partial_image', data: { partial_image_index: 0, b64_json: pngBase64 } },
        { event: 'image_generation.partial_image', data: { partial_image_index: 1, b64_json: pngBase64 } },
        { event: 'image_generation.completed', data: { b64_json: pngBase64 } },
      ]),
    );
    const { app } = testRuntime({ CLIPROXY_BASE_URL: baseUrl, CLIPROXY_TOKEN: 'sk-cliproxy-test' });
    const events = await generateEvents(app, {
      prompt: 'x',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
    });
    const tileEvents = events.filter((event) => event.event === 'tile');
    // Two partials + one terminal done; ordering preserves emission order.
    for (const event of tileEvents) {
      const terminal = event.data as { status: string; error?: string; moderation?: unknown };
      if (terminal.status === 'failed') throw new Error(`unexpected failed tile: ${JSON.stringify({
        status: terminal.status, error: terminal.error, moderation: terminal.moderation,
      })}`);
    }
    expect(tileEvents.map((event) => (event.data as { status: string }).status)).toEqual(['partial', 'partial', 'done']);
    const partials = tileEvents.filter((event) => (event.data as { status: string }).status === 'partial');
    expect((partials[0]?.data as { index: number; preview: string }).index).toBe(0);
    expect((partials[0]?.data as { index: number; preview: string }).preview.startsWith('data:image/png;base64,')).toBe(true);
    expect((partials[1]?.data as { index: number }).index).toBe(1);
    // Terminal event is the existing `done` shape (url + ext + mime), proving partials
    // didn't disturb the persistence path.
    const done = tileEvents.find((event) => (event.data as { status: string }).status === 'done');
    expect(done?.data).toMatchObject({ status: 'done', ext: 'png', mime: 'image/png' });
  });

  test('gpt-image-2.5-sunburst rejects unsupported ratios through route validation', async () => {
    const { app } = testRuntime();
    const res = await jsonRequest(app, '/api/generate', {
      prompt: 'x',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '2:3',
      count: 1,
    });
    expect(res.status).toBe(400);
  });

  test('GET /api/models exposes gpt-image-2.5-sunburst ratio metadata', async () => {
    const { app } = testRuntime();
    const res = await app.fetch(new Request('http://local/api/models', { headers: { 'Remote-User': 'test' } }));
    const models = await res.json() as { id: string; supportedRatios: string[]; backend: string; tag: string }[];
    expect(models.find((model) => model.id === 'gpt-image-2.5-sunburst')).toMatchObject({
      id: 'gpt-image-2.5-sunburst',
      supportedRatios: ['1:1', '4:5', '3:4', '16:9', '9:16'],
      backend: 'cloud',
      tag: 'cloud',
    });
  });
});
