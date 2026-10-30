import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { JSONSchema7, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { TextStructuredOutputMode } from '@atelier/shared';
import type { TextModelRecord } from '../../db/textProviders';
import { ANTHROPIC_OPTIONS_KEY, anthropicAdapter, anthropicReasoningOptions } from './anthropic';
import { boundedFetch } from './fetch';
import { classifyFinish } from './finish';
import type { ResolvedProvider } from './protocol';

// Anthropic Messages through the AI SDK adapter: headers, body shape,
// structured output in both modes (streaming and not), effort mapping and
// keyless custom servers.

interface Captured {
  readonly path: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

let server: ReturnType<typeof Bun.serve>;
let origin = '';
const captured: Captured[] = [];
/** Scripted reply for the next requests: a JSON body or an SSE event list. */
let reply: { json?: unknown; sse?: readonly unknown[] } = {};

function sse(events: readonly unknown[]): string {
  return events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.json() as Record<string, unknown>;
      captured.push({ path: new URL(req.url).pathname, headers: req.headers, body });
      if (body.stream === true) {
        return new Response(sse(reply.sse ?? textStream('ok')), { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json(reply.json ?? textMessage('ok'));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
});

afterEach(() => {
  reply = {};
});

const usage = { input_tokens: 3, output_tokens: 2 };

function message(content: readonly unknown[], stopReason: string): Record<string, unknown> {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content, stop_reason: stopReason, stop_sequence: null, usage };
}

function textMessage(text: string): Record<string, unknown> {
  return message([{ type: 'text', text }], 'end_turn');
}

function streamFrame(blocks: readonly unknown[], stopReason: string): unknown[] {
  return [
    { type: 'message_start', message: { ...message([], stopReason), stop_reason: null } },
    ...blocks,
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
}

function textStream(text: string): unknown[] {
  return streamFrame([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
  ], 'end_turn');
}

const JSON_ANSWER = '{"answer":"ok"}';

/** The json tool's input streamed in two pieces, as Anthropic sends it. */
function jsonToolStream(): unknown[] {
  return streamFrame([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'json', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"answer"' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"ok"}' } },
    { type: 'content_block_stop', index: 0 },
  ], 'tool_use');
}

function provider(credential: string | null): ResolvedProvider {
  return {
    id: 'prov-anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: `${origin}/v1`,
    preset: 'anthropic',
    auth: credential === null ? 'none' : 'stored',
    tokenField: 'max_completion_tokens',
    listModels: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    credential,
  };
}

function model(structuredOutput: TextStructuredOutputMode = 'json_object', modelId = 'claude-sonnet-4-5'): TextModelRecord {
  return {
    id: 'model-claude',
    providerId: 'prov-anthropic',
    modelId,
    displayName: 'Claude',
    enabled: true,
    vision: true,
    maxImages: null,
    structuredOutput,
    reasoningLevels: ['low', 'medium', 'high'],
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

const SCHEMA: JSONSchema7 = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

function options(extra: Partial<LanguageModelV4CallOptions> = {}): LanguageModelV4CallOptions {
  return {
    prompt: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'ping' }] },
    ],
    maxOutputTokens: 100,
    ...extra,
  };
}

function languageModel(credential: string | null = 'sk-ant-test-key', row: TextModelRecord = model()) {
  return anthropicAdapter.languageModel(provider(credential), row, boundedFetch({ maxBytes: 1_000_000 }));
}

async function drain(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function lastRequest(): Captured {
  const request = captured.at(-1);
  if (request === undefined) throw new Error('no request captured');
  return request;
}

function streamedText(parts: readonly LanguageModelV4StreamPart[]): string {
  return parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('');
}

function generatedText(content: readonly { type: string }[]): string {
  return content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('');
}

describe('anthropic adapter wire', () => {
  test('keyed: x-api-key and anthropic-version, system in `system`, image as a base64 block', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = await languageModel().doGenerate(options({
      prompt: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } }] },
      ],
    }));
    expect(classifyFinish(result)).toBeNull();
    expect(generatedText(result.content)).toBe('ok');
    const request = lastRequest();
    expect(request.path).toBe('/v1/messages');
    expect(request.headers.get('x-api-key')).toBe('sk-ant-test-key');
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.body.system).toEqual([{ type: 'text', text: 'be brief' }]);
    expect(request.body.max_tokens).toBe(100);
    expect(request.body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } },
      ],
    }]);
  });

  test('keyless: no x-api-key or Authorization header, and the environment is never read', async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    process.env.ANTHROPIC_AUTH_TOKEN = 'token-from-env';
    try {
      const result = await languageModel(null).doGenerate(options());
      expect(generatedText(result.content)).toBe('ok');
      const streamed = await drain((await languageModel(null).doStream(options())).stream);
      expect(streamedText(streamed)).toBe('ok');
      for (const request of captured.slice(-2)) {
        expect(request.headers.get('x-api-key')).toBeNull();
        expect(request.headers.get('authorization')).toBeNull();
        expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
      }
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });
});

describe('anthropic structured output', () => {
  const jsonOptions = (): LanguageModelV4CallOptions => options({ responseFormat: { type: 'json', schema: SCHEMA, name: 'probe' } });

  test("json_schema uses the native output format (non-streaming)", async () => {
    reply = { json: textMessage(JSON_ANSWER) };
    const result = await languageModel('k', model('json_schema')).doGenerate(jsonOptions());
    const body = lastRequest().body;
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA } });
    expect(body).not.toHaveProperty('tools');
    expect(classifyFinish(result)).toBeNull();
    expect(JSON.parse(generatedText(result.content))).toEqual({ answer: 'ok' });
  });

  test("json_schema uses the native output format (streaming)", async () => {
    reply = { sse: textStream(JSON_ANSWER) };
    const parts = await drain((await languageModel('k', model('json_schema')).doStream(jsonOptions())).stream);
    expect(lastRequest().body.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA } });
    expect(classifyFinish(parts.find((p) => p.type === 'finish'))).toBeNull();
    expect(JSON.parse(streamedText(parts))).toEqual({ answer: 'ok' });
  });

  test('json_object uses the json tool and its tool_use finish counts as complete (non-streaming)', async () => {
    reply = { json: message([{ type: 'tool_use', id: 'toolu_1', name: 'json', input: { answer: 'ok' } }], 'tool_use') };
    const result = await languageModel('k', model('json_object')).doGenerate(jsonOptions());
    const body = lastRequest().body;
    expect(body).not.toHaveProperty('output_config');
    expect(body.tools).toEqual([expect.objectContaining({ name: 'json', input_schema: SCHEMA })]);
    expect(body.tool_choice).toMatchObject({ type: 'any' });
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'tool_use' });
    expect(classifyFinish(result)).toBeNull();
    expect(JSON.parse(generatedText(result.content))).toEqual({ answer: 'ok' });
  });

  test('json_object uses the json tool and streams its input as text (streaming)', async () => {
    reply = { sse: jsonToolStream() };
    const parts = await drain((await languageModel('k', model('json_object')).doStream(jsonOptions())).stream);
    expect(lastRequest().body.tools).toEqual([expect.objectContaining({ name: 'json' })]);
    expect(parts.some((p) => p.type.startsWith('tool-'))).toBe(false);
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish).toMatchObject({ finishReason: { unified: 'stop', raw: 'tool_use' } });
    expect(classifyFinish(finish)).toBeNull();
    expect(JSON.parse(streamedText(parts))).toEqual({ answer: 'ok' });
  });

  test('a caller option still overrides the row default', async () => {
    reply = { json: textMessage(JSON_ANSWER) };
    await languageModel('k', model('json_object')).doGenerate({
      ...jsonOptions(),
      providerOptions: { [ANTHROPIC_OPTIONS_KEY]: { structuredOutputMode: 'outputFormat' } },
    });
    expect(lastRequest().body).toHaveProperty('output_config');
  });
});

describe('anthropic reasoning effort', () => {
  test('levels Anthropic knows map to output_config.effort', async () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const mapped = anthropicReasoningOptions(level);
      expect(mapped).toEqual({ providerOptions: { [ANTHROPIC_OPTIONS_KEY]: { effort: level } }, wireNote: null });
    }
    await languageModel('k', model('none', 'claude-opus-4-8')).doGenerate(options({ providerOptions: anthropicReasoningOptions('high').providerOptions }));
    expect(lastRequest().body.output_config).toEqual({ effort: 'high' });
  });

  test('none and minimal are left out with a wire note; null sends nothing', async () => {
    for (const level of ['none', 'minimal'] as const) {
      const mapped = anthropicReasoningOptions(level);
      expect(mapped.providerOptions).toEqual({});
      expect(mapped.wireNote).toContain(level);
    }
    expect(anthropicReasoningOptions(null)).toEqual({ providerOptions: {}, wireNote: null });
    await languageModel('k', model('none')).doGenerate(options({ providerOptions: anthropicReasoningOptions('none').providerOptions }));
    expect(lastRequest().body).not.toHaveProperty('output_config');
  });
});
