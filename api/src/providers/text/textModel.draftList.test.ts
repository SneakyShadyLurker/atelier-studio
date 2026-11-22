import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TEST_SERVER_HOSTNAME } from '../../test/server';
import { restoreFetch } from '../../test/helpers';
import { seededTextModel, testTextModelProvider } from '../../test/textModelProvider';
import {
  EXTEND_LIST_SYSTEM_PROMPT,
  REWORK_LIST_SYSTEM_PROMPT,
  WRITE_LIST_SYSTEM_PROMPT,
} from '../../prompts/draftListSystemPrompt';
import type { DraftListProviderInput } from './featureHelpers';

const servers: Bun.Server<unknown>[] = [];
beforeEach(() => { restoreFetch(); });
afterEach(async () => {
  restoreFetch();
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});
function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, hostname: TEST_SERVER_HOSTNAME, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
function chatSse(frames: readonly string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
function contentFrames(text: string): string[] {
  return [
    JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ];
}
function provider(baseUrl: string, maxResponseBytes = 1_000_000) {
  return testTextModelProvider({ origin: baseUrl, token: 'sk-x', model: seededTextModel('kimi', { modelId: 'kimi-latest' }), maxResponseBytes });
}
/** Answers `answer` and records each request body. */
function answering(answer: unknown): { url: string; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const url = serve(async (request) => {
    bodies.push((await request.json()) as Record<string, unknown>);
    return chatSse(contentFrames(typeof answer === 'string' ? answer : JSON.stringify(answer)));
  });
  return { url, bodies };
}
function message(body: Record<string, unknown> | undefined, role: 'system' | 'user'): string {
  const messages = (body?.messages ?? []) as { role: string; content: unknown }[];
  const content = messages.find((m) => m.role === role)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}
const signal = () => new AbortController().signal;

const base = [{ value: 'a red scarf', weight: 1 }, { value: 'a "blue" scarf', weight: 4 }];
const create: DraftListProviderInput = { mode: 'create', options: [], description: 'scarves by colour', addLimit: 100, listNames: ['hair_color', 'scarf'] };
const seed: DraftListProviderInput = { mode: 'seed', name: 'scarf', options: [], description: 'scarves by colour', addLimit: 100 };
const extend: DraftListProviderInput = { mode: 'extend', name: 'scarf', options: base, addLimit: 3 };
const rework: DraftListProviderInput = { mode: 'rework', name: 'scarf', options: base, description: 'make them woollen', addLimit: 2 };

describe('textModel.draftList: requests', () => {
  test('create sends the write prompt, the list_draft schema and a brief with the library and no name', async () => {
    const up = answering({ name: 'scarf_colour', options: [{ value: 'a red scarf', weight: 1 }] });
    await provider(up.url).draftList(create, signal());
    const [body] = up.bodies;
    expect(message(body, 'system')).toBe(WRITE_LIST_SYSTEM_PROMPT);
    expect(body).toMatchObject({
      model: 'kimi-latest',
      reasoning_effort: 'low',
      max_completion_tokens: 8000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'list_draft',
          strict: true,
          schema: { type: 'object', required: ['name', 'options'], additionalProperties: false },
        },
      },
    });
    expect(message(body, 'user')).toBe([
      '<mode>"create"</mode>',
      '<description>"scarves by colour"</description>',
      '<limit>100</limit>',
      '<library>["hair_color","scarf"]</library>',
    ].join('\n'));
  });

  test('a seed sends the write prompt with its name and no library', async () => {
    const up = answering({ name: null, options: [{ value: 'a red scarf', weight: 1 }] });
    await provider(up.url).draftList(seed, signal());
    expect(message(up.bodies[0], 'system')).toBe(WRITE_LIST_SYSTEM_PROMPT);
    expect(message(up.bodies[0], 'user')).toBe([
      '<mode>"seed"</mode>',
      '<name>"scarf"</name>',
      '<description>"scarves by colour"</description>',
      '<limit>100</limit>',
    ].join('\n'));
  });

  test('extend sends the extend prompt, the list_extend schema and the numbered rows with weights', async () => {
    const up = answering({ kind: 'options', options: [], question: null });
    await provider(up.url).draftList(extend, signal());
    const [body] = up.bodies;
    expect(message(body, 'system')).toBe(EXTEND_LIST_SYSTEM_PROMPT);
    expect(body).toMatchObject({
      max_completion_tokens: 8000,
      response_format: { type: 'json_schema', json_schema: { name: 'list_extend', strict: true } },
    });
    expect(message(body, 'user')).toBe([
      '<name>"scarf"</name>',
      '<options>',
      '  1. "a red scarf" (weight 1)',
      '  2. "a \\"blue\\" scarf" (weight 4)',
      '</options>',
      '<limit>3</limit>',
    ].join('\n'));
  });

  test('rework sends the rework prompt, the list_rework schema and the instructions; the budget grows with the options', async () => {
    const up = answering({ changes: [], summary: 'Nothing to change.' });
    await provider(up.url).draftList(rework, signal());
    const [body] = up.bodies;
    expect(message(body, 'system')).toBe(REWORK_LIST_SYSTEM_PROMPT);
    // 25 code points -> 9 tokens; two options -> 80 tokens.
    expect(body?.max_completion_tokens).toBe(8000 + 9 + 80);
    expect(body?.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'list_rework',
        strict: true,
        schema: {
          type: 'object',
          required: ['changes', 'summary'],
          additionalProperties: false,
          properties: {
            changes: {
              type: 'array',
              items: { type: 'object', required: ['why', 'op', 'n', 'find', 'value', 'weight'], additionalProperties: false },
            },
          },
        },
      },
    });
    expect(message(body, 'user')).toContain('<description>"make them woollen"</description>');
    expect(message(body, 'user')).toContain('  1. "a red scarf" (weight 1)');
    expect(message(body, 'user')).toContain('<limit>2</limit>');
  });

  test('a pinned effort above low reasons through at least the enhance budget', async () => {
    const up = answering({ kind: 'options', options: [], question: null });
    await provider(up.url).draftList({ ...extend, reasoningEffort: 'high' }, signal());
    expect(up.bodies[0]).toMatchObject({ reasoning_effort: 'high', max_completion_tokens: 36_000 });
  });
});

describe('textModel.draftList: create and seed answers', () => {
  test('create answers the whole list under a name that is free among the user lists', async () => {
    const up = answering({
      name: ' scarf ',
      options: [{ value: ' a red scarf ', weight: 2 }, { value: 'A RED SCARF', weight: 1 }, { value: '', weight: 1 }, 'junk', { value: 'a wool scarf', weight: 250 }],
    });
    expect(await provider(up.url).draftList(create, signal())).toEqual({
      type: 'ok',
      payload: { kind: 'list', name: 'scarf_2', options: [{ value: 'a red scarf', weight: 2 }, { value: 'a wool scarf', weight: 100 }] },
    });
  });

  test('create joins whitespace runs in the name with _ and cuts options to the add limit', async () => {
    const up = answering({ name: 'scarf   colour', options: [{ value: 'one', weight: 1 }, { value: 'two', weight: 1 }, { value: 'three', weight: 1 }] });
    expect(await provider(up.url).draftList({ ...create, addLimit: 2 }, signal())).toEqual({
      type: 'ok',
      payload: { kind: 'list', name: 'scarf_colour', options: [{ value: 'one', weight: 1 }, { value: 'two', weight: 1 }] },
    });
  });

  test('a seed answers the list with a null name, whatever name the model gave', async () => {
    const up = answering({ name: 'other', options: [{ value: 'a red scarf', weight: 1 }] });
    expect(await provider(up.url).draftList(seed, signal())).toEqual({
      type: 'ok',
      payload: { kind: 'list', name: null, options: [{ value: 'a red scarf', weight: 1 }] },
    });
  });

  test('create without a usable name, or any answer without a usable option, is a transient failure', async () => {
    for (const [input, answer] of [
      [create, { name: '   ', options: [{ value: 'a', weight: 1 }] }],
      [create, { name: null, options: [{ value: 'a', weight: 1 }] }],
      [create, { name: 'scarf_colour', options: [{ value: ' ', weight: 1 }] }],
      [seed, { name: null, options: [] }],
      [seed, { name: null }],
      [seed, '["a red scarf"]'],
    ] as const) {
      const up = answering(answer);
      expect(await provider(up.url).draftList(input, signal())).toMatchObject({ type: 'failed', kind: 'transient', status: null });
    }
  });
});

describe('textModel.draftList: extend answers', () => {
  test('extend answers add changes that differ from the base, cut to the add limit', async () => {
    const up = answering({
      kind: 'options',
      options: [{ value: 'A RED SCARF', weight: 1 }, { value: 'a wool scarf', weight: 2.4 }, { value: 'a silk scarf' }, { value: 'a wool scarf', weight: 1 }, { value: 'a lace scarf', weight: 1 }, { value: 'a knit scarf', weight: 1 }],
      question: null,
    });
    expect(await provider(up.url).draftList(extend, signal())).toEqual({
      type: 'ok',
      payload: {
        kind: 'changes',
        baseCount: 2,
        changes: [
          { id: 0, op: 'add', value: 'a wool scarf', weight: 2, why: '' },
          { id: 1, op: 'add', value: 'a silk scarf', weight: 1, why: '' },
          { id: 2, op: 'add', value: 'a lace scarf', weight: 1, why: '' },
        ],
        unplaced: [],
        summary: null,
      },
    });
  });

  test('extend passes a question on', async () => {
    const up = answering({ kind: 'clarify', options: [], question: ' Which season? ' });
    expect(await provider(up.url).draftList(extend, signal())).toEqual({ type: 'ok', payload: { kind: 'clarify', question: 'Which season?' } });
  });

  test('an answer without its options array, or a blank question, is a transient failure', async () => {
    for (const answer of [{ kind: 'options', question: null }, { kind: 'clarify', options: [], question: ' ' }, 'not json at all']) {
      const up = answering(answer);
      expect(await provider(up.url).draftList(extend, signal())).toMatchObject({ type: 'failed', kind: 'transient' });
    }
  });
});

describe('textModel.draftList: rework answers', () => {
  test('rework answers placed changes, the unplaced ones and the summary', async () => {
    const up = answering({
      changes: [
        { why: 'Wool.', op: 'edit', n: 2, find: 'a "blue" scarf', value: 'a blue wool scarf', weight: null },
        { why: 'Gone.', op: 'remove', n: 7, find: 'a green scarf', value: null, weight: null },
        { why: 'More.', op: 'add', n: null, find: null, value: 'a grey wool scarf', weight: 1 },
        { why: 'Reweight.', op: 'edit', n: 1, find: 'a red scarf', value: null, weight: 3 },
      ],
      summary: '  Made them woollen.  ',
    });
    expect(await provider(up.url).draftList(rework, signal())).toEqual({
      type: 'ok',
      payload: {
        kind: 'changes',
        baseCount: 2,
        changes: [
          { id: 0, op: 'edit', index: 0, value: 'a red scarf', weight: 3, why: 'Reweight.' },
          { id: 1, op: 'edit', index: 1, value: 'a blue wool scarf', weight: 4, why: 'Wool.' },
          { id: 2, op: 'add', value: 'a grey wool scarf', weight: 1, why: 'More.' },
        ],
        unplaced: [{ op: 'remove', find: 'a green scarf', value: null, weight: null, why: 'Gone.', reason: 'missing' }],
        summary: 'Made them woollen.',
      },
    });
  });

  test('a blank or missing summary is null', async () => {
    for (const answer of [{ changes: [], summary: '  ' }, { changes: [] }]) {
      const up = answering(answer);
      const result = await provider(up.url).draftList(rework, signal());
      expect(result).toEqual({ type: 'ok', payload: { kind: 'changes', baseCount: 2, changes: [], unplaced: [], summary: null } });
    }
  });

  test('an answer without a changes array is a transient failure', async () => {
    for (const answer of [{ summary: 'x' }, { changes: 'none', summary: 'x' }, '[]']) {
      const up = answering(answer);
      expect(await provider(up.url).draftList(rework, signal())).toMatchObject({ type: 'failed', kind: 'transient' });
    }
  });
});

describe('textModel.draftList: transport', () => {
  test('strips code fences and trailing prose before parsing', async () => {
    const fenced = '```json\n' + JSON.stringify({ kind: 'options', options: [{ value: '```js', weight: 1 }], question: null }) + '\n```\nHere you go!';
    const up = answering(fenced);
    const result = await provider(up.url).draftList(extend, signal());
    expect(result).toMatchObject({ type: 'ok', payload: { kind: 'changes', changes: [{ op: 'add', value: '```js' }] } });
  });

  test('in-stream error frame -> failed', async () => {
    const up = serve(() => chatSse([JSON.stringify({ error: { message: 'mid-stream boom' } }), '[DONE]']));
    expect((await provider(up).draftList(extend, signal())).type).toBe('failed');
  });

  test('quota 429 -> failed with kind quota and retry-after', async () => {
    const up = serve(() => new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), {
      status: 429,
      headers: { 'Retry-After': '900' },
    }));
    expect(await provider(up).draftList(extend, signal())).toMatchObject({ type: 'failed', kind: 'quota', status: 429, retryAfterSeconds: 900 });
  });

  test('upstream non-200 -> failed with status', async () => {
    const up = serve(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));
    expect(await provider(up).draftList(extend, signal())).toMatchObject({ type: 'failed', status: 500 });
  });

  test('oversize response -> failed', async () => {
    const up = answering({ kind: 'options', options: [{ value: ' '.repeat(4000), weight: 1 }], question: null });
    expect((await provider(up.url, 256).draftList(extend, signal())).type).toBe('failed');
  });
});
