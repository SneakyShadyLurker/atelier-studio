import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { TextStructuredOutputMode } from '@atelier/shared';
import { RESCUE_RESPONSE_FORMAT } from '../../prompts/inferParse';
import { STORY_PLAN_RESPONSE_FORMAT } from '../../prompts/storyPlannerSystemPrompt';
import { genericTextModel, testTextModelProvider } from '../../test/textModelProvider';
import type { EnhanceChunk } from './featureHelpers';
import { STORY_PLANNER_DEFAULTS } from './textBudgets';

// Anthropic structured output end to end through the feature provider: the
// rescue call (strict schema, accumulated inside the policy) and the story
// planner (enhance with a strict schema, streamed to the client), each on a
// `json_schema` row (native output format) and a `json_object` row (the forced
// json tool, whose input streams as text and whose tool_use stop counts as
// complete). Fixtures follow anthropic.test.ts (Task 5).

interface Captured {
  readonly path: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

let server: ReturnType<typeof Bun.serve>;
let origin = '';
const captured: Captured[] = [];
let reply: { sse?: readonly unknown[]; json?: unknown } = {};

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
        return new Response(sse(reply.sse ?? []), { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json(reply.json);
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

function message(content: readonly unknown[], stopReason: string | null): Record<string, unknown> {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content, stop_reason: stopReason, stop_sequence: null, usage };
}

function streamFrame(blocks: readonly unknown[], stopReason: string): unknown[] {
  return [
    { type: 'message_start', message: message([], null) },
    ...blocks,
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
}

/** A text answer in two deltas (the `outputFormat` path). */
function textStream(json: string): unknown[] {
  const cut = Math.floor(json.length / 2);
  return streamFrame([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json.slice(0, cut) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json.slice(cut) } },
    { type: 'content_block_stop', index: 0 },
  ], 'end_turn');
}

/** The json tool's input in two pieces, as Anthropic streams it (the `jsonTool` path). */
function jsonToolStream(json: string): unknown[] {
  const cut = Math.floor(json.length / 2);
  return streamFrame([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'json', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(cut) } },
    { type: 'content_block_stop', index: 0 },
  ], 'tool_use');
}

function answerStream(mode: TextStructuredOutputMode, json: string): unknown[] {
  return mode === 'json_schema' ? textStream(json) : jsonToolStream(json);
}

function claude(structuredOutput: TextStructuredOutputMode) {
  return testTextModelProvider({
    origin,
    token: 'sk-ant-test',
    provider: { protocol: 'anthropic', auth: 'stored', baseUrl: `${origin}/v1`, preset: 'anthropic' },
    model: genericTextModel('claude-sonnet-4-5', {
      structuredOutput,
      reasoningLevels: ['low', 'medium', 'high'],
      reasoningDefault: null,
    }),
  });
}

function lastRequest(): Captured {
  const request = captured.at(-1);
  if (request === undefined) throw new Error('no request captured');
  return request;
}

/**
 * Asserts the structured-output mode on the wire. The SDK moves constraints
 * Anthropic's output format does not accept (min/max) into descriptions, so
 * the native format is compared by shape, not byte for byte.
 */
function expectMode(body: Record<string, unknown>, mode: TextStructuredOutputMode, schema: { readonly required?: readonly string[] }): void {
  if (mode === 'json_schema') {
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema', schema: { type: 'object', required: schema.required } } });
    expect(body).not.toHaveProperty('tools');
  } else {
    expect(body).not.toHaveProperty('output_config');
    expect(body.tools).toEqual([expect.objectContaining({ name: 'json', input_schema: schema })]);
    expect(body.tool_choice).toMatchObject({ type: 'any' });
  }
}

const RESCUE_OPS = { ops: [{ op: 'addOption' as const, listIdx: 0, value: 'teal', tags: [{ dimName: 'Hue', label: 'cool' }] }] };
const STORY_PLAN = '{"title":"t","beats":[]}';

describe('Anthropic structured output through textModel', () => {
  for (const mode of ['json_schema', 'json_object'] as const) {
    test(`rescue (${mode}) returns the addOption op`, async () => {
      reply = { sse: answerStream(mode, JSON.stringify(RESCUE_OPS)) };
      const result = await claude(mode).rescueDimension({
        previewSnapshot: { dimensions: [], lists: [] },
        templateLists: [],
        targetListName: 'colours',
        conflictReason: 'test',
      }, new AbortController().signal);
      expect(result).toEqual({ type: 'ok', ops: RESCUE_OPS.ops });
      const request = lastRequest();
      expect(request.path).toBe('/v1/messages');
      expect(request.headers.get('x-api-key')).toBe('sk-ant-test');
      expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
      expect(request.body.system).toEqual([expect.objectContaining({ type: 'text' })]);
      expectMode(request.body, mode, RESCUE_RESPONSE_FORMAT.json_schema.schema);
    });

    test(`story planner (${mode}) streams the plan and completes`, async () => {
      reply = { sse: answerStream(mode, STORY_PLAN) };
      const chunks: EnhanceChunk[] = [];
      for await (const chunk of claude(mode).enhance('outline a story', [], new AbortController().signal, 'plan system', {
        responseFormat: STORY_PLAN_RESPONSE_FORMAT,
        defaults: STORY_PLANNER_DEFAULTS,
      })) chunks.push(chunk);
      expect(chunks.at(-1)).toEqual({ type: 'done' });
      const text = chunks.flatMap((c) => (c.type === 'delta' ? [c.text] : [])).join('');
      expect(text).toBe(STORY_PLAN);
      const body = lastRequest().body;
      expect(body.max_tokens).toBe(STORY_PLANNER_DEFAULTS.max_completion_tokens);
      expectMode(body, mode, STORY_PLAN_RESPONSE_FORMAT.json_schema.schema);
    });
  }

  test('a refusal stop is a failure, never done', async () => {
    reply = { sse: streamFrame([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I cannot' } },
      { type: 'content_block_stop', index: 0 },
    ], 'refusal') };
    const chunks: EnhanceChunk[] = [];
    for await (const chunk of claude('json_schema').enhance('x', [], new AbortController().signal)) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ type: 'failed', kind: 'permanent', detail: 'refusal' });
  });

  test('template draft (non-streaming) parses the answer', async () => {
    reply = { json: message([{ type: 'text', text: JSON.stringify({ kind: 'body', body: 'a portrait' }) }], 'end_turn') };
    const result = await claude('json_schema').draftTemplate(
      { name: 'T', existingBody: '', library: { lists: [] } },
      new AbortController().signal,
    );
    expect(result).toEqual({ type: 'ok', payload: { kind: 'body', body: 'a portrait', warnings: [] } });
    expect(lastRequest().body).not.toHaveProperty('stream', true);
  });
});
