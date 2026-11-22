import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TEST_SERVER_HOSTNAME } from '../test/server';
import type { DraftVariableListRequest, DraftVariableListResponse } from '@atelier/shared';
import { LIST_DESCRIPTION_MAX_CHARS } from '@atelier/shared/prompt-limits';
import { parseSseText, pickLegacyTextModel, restoreFetch, testRuntime } from '../test/helpers';
import { setTextModelProviderForTests } from '../providers/text/registry';
import type { DraftListProviderInput, TestTextFeatureProvider } from '../providers/text/featureHelpers';
import { hostPortProbeResponse, isHostPortProbe } from '../test/hostProbe';

type RT = ReturnType<typeof testRuntime>;
const servers: Bun.Server<unknown>[] = [];
beforeEach(() => { restoreFetch(); });
afterEach(async () => {
  restoreFetch();
  setTextModelProviderForTests(null);
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});
function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, hostname: TEST_SERVER_HOSTNAME, fetch: (req) => (isHostPortProbe(req) ? hostPortProbeResponse() : handler(req)) });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
// The route streams its result as SSE (long upstream LLM call vs the
// Cloudflare ~100s edge cutoff). Drain the body and return the single terminal
// frame: `done` carries the payload, `error` carries the sanitized message.
async function readDraft(res: Response): Promise<{ done: DraftVariableListResponse | undefined; error: string | undefined }> {
  const frames = parseSseText(await res.text());
  // Invariant: every non-disconnect response emits EXACTLY one terminal frame.
  expect(frames.filter((f) => f.event === 'done' || f.event === 'error').length).toBe(1);
  const done = frames.find((f) => f.event === 'done');
  const error = frames.find((f) => f.event === 'error');
  return {
    done: done ? (done.data as DraftVariableListResponse) : undefined,
    error: error ? (error.data as { message: string }).message : undefined,
  };
}
function modelSse(payload: unknown): Response {
  const frames = [
    JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(payload) }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ];
  return new Response(frames.map((f) => `data: ${f}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
/** An upstream that answers `payload` and records the user message of every call. */
function upstream(payload: unknown): { url: string; briefs: string[] } {
  const briefs: string[] = [];
  const url = serve(async (req) => {
    const body = (await req.json()) as { messages?: { role?: string; content?: unknown }[] };
    const content = body.messages?.find((m) => m.role === 'user')?.content;
    briefs.push(typeof content === 'string' ? content : JSON.stringify(content));
    return modelSse(payload);
  });
  return { url, briefs };
}
function runtime(url: string, env: Record<string, string> = {}) {
  return testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice,bob', CLIPROXY_BASE_URL: url, CLIPROXY_TOKEN: 'sk-x', LOG_LEVEL: 'info', ...env });
}
async function createList(app: RT['app'], name: string, userId = 'alice'): Promise<void> {
  const res = await app.fetch(new Request('http://local/api/prompts/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ name }),
  }));
  expect(res.status).toBe(201);
}
function post(app: RT['app'], path: string, body: unknown, userId = 'alice') {
  return app.fetch(new Request(`http://local${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify(body),
  }));
}
const draft = (app: RT['app'], body: unknown, userId = 'alice') => post(app, '/api/prompts/lists/draft', body, userId);
const rows = (...values: string[]) => values.map((value) => ({ value, weight: 1 }));

const extendBody: DraftVariableListRequest = { mode: 'extend', name: 'scarf', options: rows('a red scarf', 'a blue scarf') };
const options = (count: number) => Array.from({ length: count }, (_, i) => ({ value: `a scarf ${i}`, weight: 1 }));
const extendAnswer = (...values: string[]) => ({ kind: 'options', options: rows(...values), question: null });

describe('POST /api/prompts/lists/draft: gate and validation', () => {
  test('404 for a non-allowlisted user (gate, leak-safe)', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await draft(app, extendBody, 'mallory');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  test('the old per-list draft path is gone', async () => {
    const up = upstream(extendAnswer('a wool scarf'));
    const { app } = runtime(up.url);
    const res = await post(app, `/api/prompts/lists/${crypto.randomUUID()}/draft`, { name: 'scarf', existing: [] });
    expect(res.status).toBe(404);
    expect(up.briefs).toEqual([]);
  });

  const valid: Record<string, unknown> = { mode: 'extend', name: 'scarf', options: rows('a red scarf') };
  const invalid: [string, unknown][] = [
    ['the old body', { name: 'scarf', existing: [] }],
    ['an unknown field', { ...valid, existing: [] }],
    ['an unknown mode', { ...valid, mode: 'seed' }],
    ['an extra option field', { ...valid, options: [{ value: 'a', weight: 1, key: 'k' }] }],
    ['create with a name', { mode: 'create', name: 'scarf', options: [], description: 'scarves' }],
    ['create without a description', { mode: 'create', options: [] }],
    ['create with options', { mode: 'create', options: rows('a'), description: 'scarves' }],
    ['extend without a name', { mode: 'extend', options: rows('a') }],
    ['rework without a name', { mode: 'rework', options: rows('a'), description: 'x' }],
    ['a blank name', { ...valid, name: '  ' }],
    ['rework without a description', { mode: 'rework', name: 'scarf', options: rows('a') }],
    ['rework of an empty list', { mode: 'rework', name: 'scarf', options: [], description: 'x' }],
    ['a seed without a description', { mode: 'extend', name: 'scarf', options: [] }],
    ['a blank description', { ...valid, description: '   ' }],
    ['a description over the limit', { ...valid, description: 'x'.repeat(LIST_DESCRIPTION_MAX_CHARS + 1) }],
    ['a blank option value', { ...valid, options: rows('  ') }],
    ['an option value over 2000 units', { ...valid, options: rows('x'.repeat(2_001)) }],
    ['a weight over 100', { ...valid, options: [{ value: 'a', weight: 101 }] }],
    ['a negative weight', { ...valid, options: [{ value: 'a', weight: -1 }] }],
    ['a fractional weight', { ...valid, options: [{ value: 'a', weight: 1.5 }] }],
    ['an option without a weight', { ...valid, options: [{ value: 'a' }] }],
    ['more options than the transport limit', { ...valid, options: options(2_001) }],
    ['a modelId over 200 chars', { ...valid, modelId: 'm'.repeat(201) }],
  ];
  for (const [label, body] of invalid) {
    test(`400 for ${label}, before any model call`, async () => {
      const up = upstream(extendAnswer('a wool scarf'));
      const { app } = runtime(up.url);
      const res = await draft(app, body);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(up.briefs).toEqual([]);
    });
  }

  test('a conditional requirement names its field', async () => {
    const { app } = runtime(upstream(extendAnswer()).url);
    const body = JSON.stringify(await (await draft(app, { mode: 'rework', name: 'scarf', options: rows('a') })).json());
    expect(body).toContain('description');
  });

  test('accepts an extend without a description, option values trimmed, 2000 units, weights 0 and 100', async () => {
    const up = upstream(extendAnswer('a wool scarf'));
    const { app } = runtime(up.url);
    const res = await draft(app, { mode: 'extend', name: 'scarf', options: [{ value: '  a red scarf ', weight: 0 }, { value: 'x'.repeat(2_000), weight: 100 }] });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done).toMatchObject({ kind: 'changes', baseCount: 2 });
    expect(up.briefs[0]).toContain('1. "a red scarf" (weight 0)');
  });
});

describe('POST /api/prompts/lists/draft: order and limits', () => {
  test('create at the list limit answers 409 and never calls the model; other users do not count', async () => {
    const up = upstream({ name: 'scarf', options: rows('a red scarf') });
    const { app } = runtime(up.url, { MAX_VARIABLE_LISTS: '2' });
    await createList(app, 'hair_color');
    await createList(app, 'scarf');
    await createList(app, 'hat', 'bob');
    const res = await draft(app, { mode: 'create', options: [], description: 'shoes' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'list limit reached' });
    expect(up.briefs).toEqual([]);

    const other = await draft(app, { mode: 'create', options: [], description: 'shoes' }, 'bob');
    expect(other.status).toBe(200);
    expect((await readDraft(other)).done).toEqual({ kind: 'list', name: 'scarf', options: rows('a red scarf') });
    expect(up.briefs).toHaveLength(1);
  });

  test('body validation comes before the list limit, and the list limit before routing', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', MAX_VARIABLE_LISTS: '1' });
    await createList(app, 'scarf');
    expect((await draft(app, { mode: 'create', options: [] })).status).toBe(400);
    const full = await draft(app, { mode: 'create', options: [], description: 'shoes' });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: 'list limit reached' });
  });

  test('no text model answers 409 with the routing failure body', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await draft(app, extendBody);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'No text model is set up. An admin can add one under Text models.',
      code: 'TEXT_MODEL_NOT_CONFIGURED',
    });
  });

  test('an extend of a full list answers no changes inside the stream without a model call', async () => {
    const up = upstream(extendAnswer('a wool scarf'));
    const { app } = runtime(up.url, { MAX_OPTIONS_PER_LIST: '3' });
    const res = await draft(app, { mode: 'extend', name: 'scarf', options: options(3), description: 'more' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect((await readDraft(res)).done).toEqual({ kind: 'changes', baseCount: 3, changes: [], unplaced: [], summary: null });
    expect(up.briefs).toEqual([]);
  });

  test('a rework of a list over the limit still runs, and its adds are all dropped', async () => {
    const up = upstream({
      changes: [
        { why: 'w', op: 'remove', n: 1, find: 'a scarf 0', value: null, weight: null },
        { why: 'w', op: 'add', n: null, find: null, value: 'a wool scarf', weight: 1 },
      ],
      summary: 'Done.',
    });
    const { app } = runtime(up.url, { MAX_OPTIONS_PER_LIST: '3' });
    const { done } = await readDraft(await draft(app, { mode: 'rework', name: 'scarf', options: options(4), description: 'trim' }));
    expect(done).toEqual({ kind: 'changes', baseCount: 4, changes: [{ id: 0, op: 'remove', index: 0, why: 'w' }], unplaced: [], summary: 'Done.' });
    expect(up.briefs[0]).toContain('<limit>0</limit>');
  });

  test('the add limit is the remaining capacity, at most 100', async () => {
    const up = upstream(extendAnswer('one', 'two', 'three', 'four'));
    const { app } = runtime(up.url, { MAX_OPTIONS_PER_LIST: '5' });
    const { done } = await readDraft(await draft(app, { mode: 'extend', name: 'scarf', options: options(2) }));
    expect(done?.kind === 'changes' ? done.changes.map((c) => c.op === 'add' ? c.value : '') : null).toEqual(['one', 'two', 'three']);
    expect(up.briefs[0]).toContain('<limit>3</limit>');

    const wide = upstream(extendAnswer('one'));
    const { app: wideApp } = runtime(wide.url, { MAX_OPTIONS_PER_LIST: '500' });
    await readDraft(await draft(wideApp, { mode: 'extend', name: 'scarf', options: options(2) }));
    expect(wide.briefs[0]).toContain('<limit>100</limit>');
  });
});

describe('POST /api/prompts/lists/draft: answers', () => {
  test('create answers a list under a name free among the user lists; the brief names them all', async () => {
    const up = upstream({ name: 'scarf', options: [{ value: 'a red scarf', weight: 2 }, { value: 'A Red Scarf', weight: 1 }] });
    const { app } = runtime(up.url);
    await createList(app, 'scarf');
    await createList(app, 'hair_color');
    await createList(app, 'scarf_2', 'bob');
    const { done } = await readDraft(await draft(app, { mode: 'create', options: [], description: 'scarves by colour' }));
    expect(done).toEqual({ kind: 'list', name: 'scarf_2', options: [{ value: 'a red scarf', weight: 2 }] });
    expect(up.briefs[0]).toContain('<mode>"create"</mode>');
    expect(up.briefs[0]).toContain('<library>["scarf","hair_color"]</library>');
    expect(up.briefs[0]).not.toContain('<name>');
  });

  test('create with a blank name is the safe error', async () => {
    const up = upstream({ name: ' ', options: rows('a red scarf') });
    const { app } = runtime(up.url);
    const { done, error } = await readDraft(await draft(app, { mode: 'create', options: [], description: 'scarves' }));
    expect(done).toBeUndefined();
    expect(error).toBeDefined();
  });

  test('an extend of an empty list is a seed: a list with a null name', async () => {
    const up = upstream({ name: 'ignored', options: rows('a red scarf', 'a blue scarf') });
    const { app } = runtime(up.url);
    const { done } = await readDraft(await draft(app, { mode: 'extend', name: 'scarf', options: [], description: 'scarves by colour' }));
    expect(done).toEqual({ kind: 'list', name: null, options: rows('a red scarf', 'a blue scarf') });
    expect(up.briefs[0]).toContain('<mode>"seed"</mode>');
    expect(up.briefs[0]).toContain('<name>"scarf"</name>');
    expect(up.briefs[0]).not.toContain('<library>');
  });

  test('a seed without a usable option is the safe error', async () => {
    const up = upstream({ name: null, options: rows(' ') });
    const { app } = runtime(up.url);
    const { error } = await readDraft(await draft(app, { mode: 'extend', name: 'scarf', options: [], description: 'scarves' }));
    expect(error).toBeDefined();
  });

  test('extend answers add changes that differ from the base, with empty why and null summary', async () => {
    const up = upstream(extendAnswer('A RED SCARF', 'a wool scarf', 'a Wool Scarf'));
    const { app } = runtime(up.url);
    const { done } = await readDraft(await draft(app, { ...extendBody, description: 'more scarves' }));
    expect(done).toEqual({
      kind: 'changes',
      baseCount: 2,
      changes: [{ id: 0, op: 'add', value: 'a wool scarf', weight: 1, why: '' }],
      unplaced: [],
      summary: null,
    });
    expect(up.briefs[0]).toContain('<description>"more scarves"</description>');
  });

  test('rework answers placed and unplaced changes and logs the placement', async () => {
    const up = upstream({
      changes: [
        { why: 'Wool.', op: 'edit', n: 2, find: 'a blue scarf', value: 'a blue wool scarf', weight: 3 },
        { why: 'Twice.', op: 'remove', n: 2, find: 'a blue scarf', value: null, weight: null },
      ],
      summary: 'Woollen.',
    });
    const { app, logs } = runtime(up.url);
    const { done } = await readDraft(await draft(app, { ...extendBody, mode: 'rework', description: 'make them woollen' }));
    expect(done).toEqual({
      kind: 'changes',
      baseCount: 2,
      changes: [{ id: 0, op: 'edit', index: 1, value: 'a blue wool scarf', weight: 3, why: 'Wool.' }],
      unplaced: [{ op: 'remove', find: 'a blue scarf', value: null, weight: null, why: 'Twice.', reason: 'overlap' }],
      summary: 'Woollen.',
    });
    const placed = logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.event === 'draft_list_rework');
    expect(placed).toMatchObject({ placed: 1, unplaced: 1, unplacedReasons: { overlap: 1 } });
  });

  test('passes a question on for an extend without a description', async () => {
    const up = upstream({ kind: 'clarify', options: [], question: 'Which season?' });
    const { app } = runtime(up.url);
    expect((await readDraft(await draft(app, extendBody))).done).toEqual({ kind: 'clarify', question: 'Which season?' });
  });

  test('a question despite a description is a sanitized failure', async () => {
    const up = upstream({ kind: 'clarify', options: [], question: 'still vague?' });
    const { app } = runtime(up.url);
    const { done, error } = await readDraft(await draft(app, { ...extendBody, description: 'more scarves' }));
    expect(done).toBeUndefined();
    expect(error ?? '').not.toContain('still vague');
  });

  test("the user's pinned effort reaches the wire", async () => {
    const efforts: unknown[] = [];
    const up = serve(async (req) => {
      efforts.push((await req.json() as { reasoning_effort?: unknown }).reasoning_effort);
      return modelSse(extendAnswer('a wool scarf'));
    });
    const { app, db } = runtime(up);
    pickLegacyTextModel(db, 'alice', 'list-draft', 'kimi', 'high');
    const { done } = await readDraft(await draft(app, extendBody));
    expect(done).toMatchObject({ kind: 'changes' });
    expect(efforts).toEqual(['high']);
  });

  test('upstream failure -> sanitized error frame; the log carries kind and status, never the upstream detail', async () => {
    const up = serve(() => new Response(JSON.stringify({ error: { message: 'leaky detail' } }), { status: 500 }));
    const { app, logs } = runtime(up);
    const { done, error } = await readDraft(await draft(app, extendBody));
    expect(done).toBeUndefined();
    expect(error ?? '').not.toContain('leaky detail');
    expect(logs.join('\n')).not.toContain('leaky detail');
    const failure = logs.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === 'draft_list_upstream_error');
    expect(failure).toMatchObject({ failureKind: 'transient', status: 500 });
    expect(typeof failure?.textModelId).toBe('string');
  });

  test('an unparseable answer is a sanitized error frame', async () => {
    const up = serve(() => modelSse('not json at all'));
    const { app } = runtime(up);
    const { done, error } = await readDraft(await draft(app, extendBody));
    expect(done).toBeUndefined();
    expect(error ?? '').not.toContain('not json');
  });

  test('stalled upstream is bounded by CLOUD_TIMEOUT_MS', async () => {
    const up = serve(async () => { await Bun.sleep(5000); return modelSse(extendAnswer('x')); });
    const { app, logs } = runtime(up, { CLOUD_TIMEOUT_MS: '250' });
    const { error } = await readDraft(await draft(app, extendBody));
    expect(error).toBeDefined();
    expect(logs.join('\n')).toContain('draft_list_timeout');
    expect(logs.join('\n')).not.toContain('draft_list_crash');
  });
});

describe('list draft provider input and terminal errors', () => {
  const fake = (draftList: TestTextFeatureProvider['draftList']): TestTextFeatureProvider => ({
    async *enhance() { await Promise.resolve(); yield { type: 'done' } as const; },
    draftList,
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
  });

  test('the provider gets the mode, base, add limit and, for create only, the user list names', async () => {
    const inputs: DraftListProviderInput[] = [];
    setTextModelProviderForTests(fake((input) => {
      inputs.push(input);
      return Promise.resolve({ type: 'ok', payload: { kind: 'list', name: 'shoe', options: rows('a boot') } });
    }));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice,bob', MAX_OPTIONS_PER_LIST: '50' });
    await createList(app, 'scarf');
    await createList(app, 'hat', 'bob');
    await readDraft(await draft(app, { mode: 'create', options: [], description: 'shoes', modelId: 'image-model' }));
    await readDraft(await draft(app, { mode: 'extend', name: 'scarf', options: rows('a'), description: 'more' }));
    await readDraft(await draft(app, { mode: 'extend', name: 'scarf', options: [], description: 'scarves' }));
    await readDraft(await draft(app, { mode: 'rework', name: 'scarf', options: rows('a', 'b'), description: 'x' }));
    expect(inputs).toEqual([
      { mode: 'create', options: [], description: 'shoes', addLimit: 50, listNames: ['scarf'], modelId: 'image-model' },
      { mode: 'extend', name: 'scarf', options: rows('a'), description: 'more', addLimit: 49 },
      { mode: 'seed', name: 'scarf', options: [], description: 'scarves', addLimit: 50 },
      { mode: 'rework', name: 'scarf', options: rows('a', 'b'), description: 'x', addLimit: 48 },
    ]);
  });

  test('a question from a rework is a sanitized failure', async () => {
    setTextModelProviderForTests(fake(() => Promise.resolve({ type: 'ok', payload: { kind: 'clarify', question: 'why?' } })));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const { done, error } = await readDraft(await draft(app, { mode: 'rework', name: 'scarf', options: rows('a'), description: 'x' }));
    expect(done).toBeUndefined();
    expect(error ?? '').not.toContain('why?');
  });

  test('an exhausted quota reaches the client as quota-exhausted with its retry hint', async () => {
    setTextModelProviderForTests(fake(() => Promise.resolve({
      type: 'failed', kind: 'quota', status: 429, detail: 'upstream says no', retryAfterSeconds: 120,
    })));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const frames = parseSseText(await (await draft(app, extendBody)).text());
    expect(frames.find((frame) => frame.event === 'error')?.data)
      .toEqual({ message: 'Codex quota exhausted', code: 'quota-exhausted', retryAfterSeconds: 120 });
  });

  test('a crash carries provider-error with the route message', async () => {
    setTextModelProviderForTests(fake(() => Promise.reject(new Error('boom'))));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const frames = parseSseText(await (await draft(app, extendBody)).text());
    expect(frames.find((frame) => frame.event === 'error')?.data)
      .toMatchObject({ code: 'provider-error' });
    expect(JSON.stringify(frames)).not.toContain('boom');
  });
});
