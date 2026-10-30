import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { TextProtocol } from '@atelier/shared';
import { TextConfigValidationError, type TextModelRecord } from '../../db/textProviders';
import { anthropicAdapter } from './anthropic';
import { openaiCompatibleAdapter } from './openaiCompatible';
import { testModel } from './probe';
import type { ResolvedProvider, TextProtocolAdapter } from './protocol';

// Spec § 6.5 and the connection test: scripted servers decide each answer
// from the request; every assertion is on what the report proves.

const KEY = 'sk-probe-secret-key-1234';

interface Captured {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/** What one chat/messages request should get back. */
type Answer =
  | { readonly text: string }
  | { readonly status: number; readonly body: string };

let server: ReturnType<typeof Bun.serve>;
let origin = '';
const captured: Captured[] = [];
let listAnswer: () => Response = () => Response.json({ data: [{ id: 'm-1' }, { id: 'm-2' }] });
let chat: (body: Record<string, unknown>) => Answer = () => ({ text: 'OK' });

function openaiReply(text: string): Response {
  return Response.json({
    id: 'c1',
    created: 0,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  });
}

/** Answers through the json tool when the request forces it, as Anthropic does. */
function anthropicReply(text: string, jsonTool: boolean): Response {
  return Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: jsonTool ? [{ type: 'tool_use', id: 'toolu_1', name: 'json', input: JSON.parse(text) as unknown }] : [{ type: 'text', text }],
    stop_reason: jsonTool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET') return listAnswer();
      const body = await req.json() as Record<string, unknown>;
      captured.push({ path, body });
      const answer = chat(body);
      if ('status' in answer) return new Response(answer.body, { status: answer.status });
      return path.endsWith('/messages') ? anthropicReply(answer.text, Array.isArray(body.tools)) : openaiReply(answer.text);
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
});

afterEach(() => {
  captured.length = 0;
  listAnswer = () => Response.json({ data: [{ id: 'm-1' }, { id: 'm-2' }] });
  chat = () => ({ text: 'OK' });
});

function provider(protocol: TextProtocol = 'openai-compatible', listModels = false): ResolvedProvider {
  return {
    id: 'prov',
    name: 'P',
    protocol,
    baseUrl: `${origin}/v1`,
    preset: null,
    auth: 'stored',
    tokenField: 'max_completion_tokens',
    listModels,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    credential: KEY,
  };
}

function model(modelId = 'm-1'): TextModelRecord {
  return {
    id: 'row-1',
    providerId: 'prov',
    modelId,
    displayName: 'M',
    enabled: true,
    vision: false,
    maxImages: null,
    structuredOutput: 'none',
    reasoningLevels: [],
    reasoningDefault: null,
    temperature: null,
    topP: null,
    fixedOutputTokens: null,
    latencyProfile: 'standard',
    promptVariant: 'generic',
    screenRequests: false,
    sortOrder: 0,
    verifiedAt: null,
    lastTest: null,
    legacyKey: null,
  };
}

const signal = (): AbortSignal => new AbortController().signal;

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/** Which of the four checks a request belongs to, read from its body. */
function kindOf(body: Record<string, unknown>): 'plain' | 'json' | 'image' | 'reasoning' {
  const raw = JSON.stringify(body);
  if (raw.includes('reasoning_effort') || raw.includes('"effort"')) return 'reasoning';
  if (raw.includes('image_url') || raw.includes('"type":"image"')) return 'image';
  if (raw.includes('answer')) return 'json';
  return 'plain';
}

/** A server that does everything; `override` changes chosen answers. */
function scripted(override: (body: Record<string, unknown>, kind: ReturnType<typeof kindOf>) => Answer | undefined = () => undefined) {
  return (body: Record<string, unknown>): Answer => {
    const kind = kindOf(body);
    const changed = override(body, kind);
    if (changed !== undefined) return changed;
    if (kind === 'json') return { text: '{"answer":"ok"}' };
    if (kind === 'image') return { text: 'seen' };
    return { text: 'OK' };
  };
}

async function run(adapter: TextProtocolAdapter = openaiCompatibleAdapter, prov = provider(adapter.protocol)) {
  return testModel(adapter, prov, model(), signal());
}

function statusOf(report: Awaited<ReturnType<typeof run>>, id: string): string | undefined {
  return report.checks.find((c) => c.id === id)?.status;
}

function messageOf(report: Awaited<ReturnType<typeof run>>, id: string): string {
  return report.checks.find((c) => c.id === id)?.message ?? '';
}

describe('testModel', () => {
  test('a capable server: four checks in order, everything proven', async () => {
    chat = scripted();
    const report = await run();
    expect(report.checks.map((c) => c.id)).toEqual(['plain', 'json', 'image', 'reasoning']);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(report.proposed).toEqual({
      structuredOutput: 'json_schema',
      vision: true,
      reasoningLevels: ['low', 'high'],
      reasoningDefault: 'low',
    });
    expect(report.advertised).toEqual({});
    expect(captured.map((c) => kindOf(c.body))).toEqual(['plain', 'json', 'image', 'reasoning', 'reasoning']);
    const plain = captured[0]?.body;
    expect(plain?.messages).toEqual([
      { role: 'system', content: 'Reply with exactly: OK' },
      { role: 'user', content: 'ping' },
    ]);
    expect(captured[1]?.body.response_format).toMatchObject({ type: 'json_schema' });
    expect(captured.slice(3).map((c) => c.body.reasoning_effort)).toEqual(['low', 'high']);
  });

  test('schema refused, json_object accepted → json_object', async () => {
    chat = scripted((body, kind) => {
      if (kind !== 'json') return undefined;
      return (body.response_format as { type: string }).type === 'json_schema'
        ? { status: 400, body: 'json_schema is not supported' }
        : { text: '{"answer":"ok"}' };
    });
    const report = await run();
    expect(report.proposed.structuredOutput).toBe('json_object');
    expect(statusOf(report, 'json')).toBe('pass');
    expect(captured.filter((c) => kindOf(c.body) === 'json').map((c) => (c.body.response_format as { type: string }).type))
      .toEqual(['json_schema', 'json_object']);
  });

  test('both JSON modes refused → none', async () => {
    chat = scripted((_body, kind) => (kind === 'json' ? { status: 400, body: 'response_format not supported' } : undefined));
    const report = await run();
    expect(report.proposed.structuredOutput).toBe('none');
    expect(messageOf(report, 'json')).toContain('JSON output turned off');
  });

  test('a 2xx with text that is not the requested JSON proposes nothing', async () => {
    chat = scripted((_body, kind) => (kind === 'json' ? { text: 'sure! here you go' } : undefined));
    const report = await run();
    expect(statusOf(report, 'json')).toBe('fail');
    expect(report.proposed).not.toHaveProperty('structuredOutput');
  });

  test('a 400 that mentions images → vision off, plain message, key redacted', async () => {
    chat = scripted((_body, kind) => (kind === 'image' ? { status: 400, body: `image input not supported (key ${KEY})` } : undefined));
    const report = await run();
    expect(report.proposed.vision).toBe(false);
    const message = messageOf(report, 'image');
    expect(message).toContain("The server refused the image: it answered 400 'image input not supported");
    expect(message).toContain('Image input turned off.');
    expect(message).not.toContain(KEY);
  });

  test('other image failures leave vision unknown', async () => {
    chat = scripted((_body, kind) => (kind === 'image' ? { status: 500, body: 'boom' } : undefined));
    const report = await run();
    expect(statusOf(report, 'image')).toBe('fail');
    expect(report.proposed).not.toHaveProperty('vision');
  });

  test("reasoning 'low' refused → no levels and no default", async () => {
    chat = scripted((_body, kind) => (kind === 'reasoning' ? { status: 400, body: 'unknown parameter reasoning_effort' } : undefined));
    const report = await run();
    expect(report.proposed).toMatchObject({ reasoningLevels: [], reasoningDefault: null });
    expect(captured.filter((c) => kindOf(c.body) === 'reasoning')).toHaveLength(1);
  });

  test("reasoning 'high' refused → only low", async () => {
    chat = scripted((body, kind) => (kind === 'reasoning' && body.reasoning_effort === 'high' ? { status: 400, body: 'bad effort' } : undefined));
    const report = await run();
    expect(report.proposed).toMatchObject({ reasoningLevels: ['low'], reasoningDefault: 'low' });
  });

  test('a failing plain reply skips the rest and proposes nothing', async () => {
    chat = () => ({ status: 404, body: 'model not found' });
    const report = await run();
    expect(report.checks.map((c) => c.status)).toEqual(['fail', 'skip', 'skip', 'skip']);
    expect(messageOf(report, 'plain')).toContain('404');
    expect(report.proposed).toEqual({});
    expect(captured).toHaveLength(1);
  });

  test('an empty reply fails the plain check', async () => {
    chat = () => ({ text: '' });
    const report = await run();
    expect(statusOf(report, 'plain')).toBe('fail');
  });

  test('list hints the probe did not exercise go to `advertised`, never to `proposed`', async () => {
    listAnswer = () => Response.json({
      data: [{
        id: 'm-1',
        architecture: { input_modalities: ['text', 'image'] },
        supported_parameters: ['structured_outputs', 'reasoning'],
      }],
    });
    chat = scripted((_body, kind) => (kind === 'image' ? { status: 500, body: 'boom' } : undefined));
    const report = await run(openaiCompatibleAdapter, provider('openai-compatible', true));
    expect(report.proposed).not.toHaveProperty('vision');
    expect(report.advertised).toEqual({ vision: true, reasoningLevels: ['medium'] });
  });

  test('Anthropic: native output format, effort levels, medium advertised by default', async () => {
    chat = scripted();
    const report = await run(anthropicAdapter, provider('anthropic'));
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(report.proposed).toEqual({
      structuredOutput: 'json_schema',
      vision: true,
      reasoningLevels: ['low', 'high'],
      reasoningDefault: 'low',
    });
    expect(report.advertised).toEqual({ reasoningLevels: ['medium'] });
    expect(captured.every((c) => c.path === '/v1/messages')).toBe(true);
    expect(captured[1]?.body.output_config).toMatchObject({ format: { type: 'json_schema' } });
    expect(captured.slice(3).map((c) => (c.body.output_config as { effort: string }).effort)).toEqual(['low', 'high']);
  });

  test('Anthropic: schema refused → the json tool', async () => {
    chat = scripted((body, kind) => {
      if (kind !== 'json') return undefined;
      return 'output_config' in body ? { status: 400, body: 'output_config.format: unsupported' } : undefined;
    });
    const report = await run(anthropicAdapter, provider('anthropic'));
    expect(report.proposed.structuredOutput).toBe('json_object');
    expect(captured.filter((c) => kindOf(c.body) === 'json')[1]?.body.tools).toEqual([expect.objectContaining({ name: 'json' })]);
  });

  test('times out a hanging check with a plain message', async () => {
    const hang = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(openaiReply('OK'));
        }, 2_000);
      }),
    });
    try {
      const report = await testModel(
        openaiCompatibleAdapter,
        { ...provider(), baseUrl: `http://127.0.0.1:${hang.port}/v1` },
        model(),
        signal(),
        { checkTimeoutMs: 50 },
      );
      expect(messageOf(report, 'plain')).toContain('did not answer');
    } finally {
      void hang.stop(true);
    }
  });
});

describe('probeConnection', () => {
  test('listing on: the list call is the check', async () => {
    const report = await openaiCompatibleAdapter.probeConnection(provider('openai-compatible', true), signal());
    expect(report).toEqual({
      ok: true,
      checks: [{ id: 'list', status: 'pass', message: 'The server answered and listed 2 models.' }],
      listedCount: 2,
    });
    expect(captured).toHaveLength(0);
  });

  test('listing on, list refused: plain failure, redacted', async () => {
    listAnswer = () => new Response(`no ${KEY}`, { status: 401 });
    const report = await anthropicAdapter.probeConnection(provider('anthropic', true), signal());
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toContain('refused the key');
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  test('listing off without a probe model: a validation error with a plain message', async () => {
    const missing = await caught(openaiCompatibleAdapter.probeConnection(provider('openai-compatible', false), signal()));
    expect(missing).toBeInstanceOf(TextConfigValidationError);
    const blank = await caught(openaiCompatibleAdapter.probeConnection(provider('openai-compatible', false), signal(), { probeModelId: ' ' }));
    expect(blank).toBeInstanceOf(TextConfigValidationError);
    expect((blank as Error).message).toContain('Name a model to test with');
    expect(captured).toHaveLength(0);
  });

  test('listing off: a 1-token completion against the probe model (OpenAI-compatible)', async () => {
    const report = await openaiCompatibleAdapter.probeConnection(provider('openai-compatible', false), signal(), { probeModelId: 'm-9' });
    expect(report.ok).toBe(true);
    expect(report.checks[0]).toMatchObject({ id: 'completion', status: 'pass' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({ model: 'm-9', max_completion_tokens: 1 });
  });

  test('listing off: a 1-token completion against the probe model (Anthropic)', async () => {
    const report = await anthropicAdapter.probeConnection(provider('anthropic', false), signal(), { probeModelId: 'claude-x' });
    expect(report.ok).toBe(true);
    expect(captured[0]).toMatchObject({ path: '/v1/messages', body: { model: 'claude-x', max_tokens: 1 } });
  });

  test('listing off: a refused completion fails plainly', async () => {
    chat = () => ({ status: 401, body: `invalid key ${KEY}` });
    const report = await openaiCompatibleAdapter.probeConnection(provider('openai-compatible', false), signal(), { probeModelId: 'm-9' });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toContain('401');
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  test('list unsupported: reported, then the probe model is tried when given', async () => {
    listAnswer = () => new Response('nope', { status: 404 });
    const bare = await openaiCompatibleAdapter.probeConnection(provider('openai-compatible', true), signal());
    expect(bare).toMatchObject({ ok: false, listUnsupported: true });
    expect(bare.checks[0]?.message).toContain('turn off model listing');

    const withModel = await openaiCompatibleAdapter.probeConnection(provider('openai-compatible', true), signal(), { probeModelId: 'm-9' });
    expect(withModel).toMatchObject({ ok: true, listUnsupported: true });
    expect(withModel.checks.map((c) => c.id)).toEqual(['list', 'completion']);
  });
});
