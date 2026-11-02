import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { allowJevForProviderTests, resetJevForProviderTests } from '../test/jev-fixture';
import { createCliproxyProvider } from './cliproxy';
import type { ProviderRequest, ProviderResult } from './types';

const originalFetch = globalThis.fetch;
beforeEach(allowJevForProviderTests);

afterEach(() => {
  resetJevForProviderTests();
  globalThis.fetch = originalFetch;
});

const baseRequest: ProviderRequest = {
  prompt: 'a small dot',
  modelId: 'gpt-image-2.5-sunburst',
  ratio: '1:1',
  tileIndex: 0,
  seed: 0,
};

async function consume(req: ProviderRequest = baseRequest): Promise<ProviderResult[]> {
  const provider = createCliproxyProvider({
    baseUrl: 'https://cliproxy.test',
    token: 'token',
    maxResponseBytes: 1024 * 1024,
  });
  const out: ProviderResult[] = [];
  for await (const result of provider.generate(req, new AbortController().signal)) {
    out.push(result);
  }
  return out;
}

describe('cliproxy adapter provider reasons', () => {
  test('marks in-stream moderation error events as typed HTTP request rejections', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      'event: error\ndata: {"error":{"message":"moderation blocked","type":"moderation_blocked"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        status: 400,
        reason: { kind: 'http', status: 400 },
      },
    });
  });

  // CLIProxyAPI commits HTTP 200 up front on streamed image calls; server-side
  // failures arrive as in-stream `event: error` frames. Stamping those 400
  // would mislabel proxy/credential outages as request rejections and exempt
  // them from the transient-retry path (400 is not in TRANSIENT_STATUSES).
  test.each([
    [
      'codex credential outage (auth_unavailable)',
      '{"error":{"message":"auth_unavailable: no auth available (providers=codex, model=gpt-image-2.5-sunburst)","type":"server_error","code":"internal_server_error"}}',
    ],
    [
      'upstream stream severed mid-generation',
      '{"error":{"message":"stream error: stream disconnected before completion","type":"server_error","code":"internal_server_error"}}',
    ],
  ])('marks in-stream server-class error events as transient 502: %s', async (_label, body) => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      `event: error\ndata: ${body}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        status: 502,
        reason: { kind: 'http', status: 502 },
      },
    });
  });

  // "upstream did not return image output" is how gpt-image-2 OUTPUT-stage
  // moderation usually manifests on the Codex path (its body carries
  // type:"server_error", so the server-class regex would otherwise claim it).
  // It must stay non-retriable — same typed reason as Gemini's NO_IMAGE —
  // or moderation storms would burn retry budget and trip the pool breaker.
  test('marks in-stream no-image-output events as non-retriable no-image refusals', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      'event: error\ndata: {"error":{"message":"upstream did not return image output","type":"server_error","code":"internal_server_error"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        status: 400,
        reason: { kind: 'no-image' },
      },
    });
  });

  test('marks in-stream rate-limit error events as transient 429', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      'event: error\ndata: {"error":{"message":"Rate limit reached for gpt-image-2-codex (for limit gpt-image) in organization org-x on input-images per min","type":"requests","code":"rate_limit_exceeded"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        status: 429,
        reason: { kind: 'http', status: 429 },
      },
    });
  });

  test('keeps unrecognized in-stream error events as 400 request rejections', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      'event: error\ndata: {"error":{"message":"prompt exceeds maximum length","type":"invalid_request_error"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        status: 400,
        reason: { kind: 'http', status: 400 },
      },
    });
  });
});

// Newer CLIProxyAPI builds answer /v1/images/* with an SSE content-type but a
// body that is a keep-alive comment + ONE raw pretty-printed JSON object (no
// data:/event: frames, no partials), a framing regression that failed every
// gpt-image generation. The adapter sniffs the
// framing and must handle both shapes.
describe('cliproxy raw-JSON (frameless) framing', () => {
  // 1×1 transparent PNG
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  test('parses a keep-alive comment followed by a raw pretty-printed JSON body', async () => {
    const body = `: keep-alive\n\n{\n  "created": 1783434269,\n  "data": [\n    {\n      "b64_json": "${PNG_B64}"\n    }\n  ],\n  "usage": {"total_tokens": 203}\n}`;
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      body,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({ status: 'ready', ext: 'png', mime: 'image/png' });
  });

  test('parses a raw JSON body split across many chunks', async () => {
    const body = `: keep-alive\n\n{\n  "data": [{"b64_json": "${PNG_B64}"}]\n}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      stream,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({ status: 'ready', ext: 'png' });
  });

  test('classifies a raw JSON moderation error body as a non-retriable 400', async () => {
    const body = `: keep-alive\n\n{\n  "error": {"message": "Your request was rejected by the safety system. moderation_blocked", "type": "image_generation_user_error"}\n}`;
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      body,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({
      status: 'failed',
      error: { status: 400, reason: { kind: 'http', status: 400 } },
    });
  });

  test('classifies a raw JSON server-class error body as transient 502', async () => {
    const body = `{"error":{"message":"context canceled","type":"server_error","code":"internal_server_error"}}`;
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      body,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({
      status: 'failed',
      error: { status: 502, reason: { kind: 'http', status: 502 } },
    });
  });

  test('keep-alive comments followed by EOF fail as an ended stream, not a crash', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      ': keep-alive\n\n: keep-alive\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({ status: 'failed', error: 'CLIProxyAPI stream ended without a completed event' });
  });
});

// CLIProxyAPI 7.2.50 also pretty-prints JSON payloads INSIDE proper SSE
// frames: only the first line carries the `data:` prefix, the rest of the
// object follows bare. A spec-compliant parse keeps `{` and drops the
// continuation lines, which turned every in-stream error (output-stage
// moderation after a full 2-minute generation) into a generic
// `raw: "{"` provider failure. frameDataText recovers the
// payload from the raw frame text.
describe('cliproxy pretty-printed SSE frame payloads', () => {
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  test('recovers a pretty-printed in-stream moderation error as a non-retriable 400', async () => {
    const body = ': keep-alive\n\nevent: error\ndata: {\n  "error": {\n    "message": "Your request was rejected by the safety system. safety_violations=[sexual].",\n    "type": "image_generation_user_error",\n    "code": "moderation_blocked",\n    "moderation_details": {\n      "moderation_stage": "output",\n      "categories": ["sexual"]\n    }\n  }\n}\n\n';
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      body,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({
      status: 'failed',
      error: { status: 400, reason: { kind: 'http', status: 400 } },
    });
    // The recovered reason must carry the real refusal text, not the mangled "{".
    const failed = result as Extract<ProviderResult, { status: 'failed' }>;
    const error = failed.error as { reason: { raw: string } };
    expect(error.reason.raw).toContain('moderation_blocked');
  });

  test('recovers a pretty-printed in-stream server-class error as transient 502', async () => {
    const body = 'event: error\ndata: {\n  "error": {\n    "message": "stream error: stream disconnected before completion",\n    "type": "server_error",\n    "code": "internal_server_error"\n  }\n}\n\n';
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      body,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({
      status: 'failed',
      error: { status: 502, reason: { kind: 'http', status: 502 } },
    });
  });

  test('recovers a pretty-printed completed frame into a ready image', async () => {
    const body = `event: image_generation.completed\ndata: {\n  "type": "image_generation.completed",\n  "b64_json": "${PNG_B64}"\n}\n\n`;
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      body,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({ status: 'ready', ext: 'png', mime: 'image/png' });
  });

  test('classifies a data-only pretty-printed error frame (no event line) as terminal', async () => {
    // Error payloads have no top-level `type`, so event inference cannot name
    // them — the top-level `error` object must route to the error branch
    // instead of skipping into "stream ended without a completed event".
    const body = 'data: {\n  "error": {\n    "message": "Your request was rejected by the safety system. safety_violations=[sexual].",\n    "code": "moderation_blocked"\n  }\n}\n\n';
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      body,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({
      status: 'failed',
      error: { status: 400, reason: { kind: 'http', status: 400 } },
    });
  });

  test('infers the event from a recovered payload when the event line is missing', async () => {
    const body = `data: {\n  "type": "image_generation.completed",\n  "b64_json": "${PNG_B64}"\n}\n\n`;
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      body,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({ status: 'ready', ext: 'png' });
  });

  test('pretty-printed frames split across chunk boundaries still recover', async () => {
    const body = 'event: error\ndata: {\n  "error": {\n    "message": "upstream did not return image output",\n    "type": "server_error"\n  }\n}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.slice(i, i + 5));
        controller.close();
      },
    });
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      stream,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;

    const [result] = await consume();
    expect(result).toMatchObject({
      status: 'failed',
      error: { status: 400, reason: { kind: 'no-image' } },
    });
  });
});
