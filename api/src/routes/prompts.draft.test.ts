import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DraftVariableListResponse, VariableList } from '@atelier/shared';
import { parseSseText, restoreFetch, testRuntime } from '../test/helpers';

type RT = ReturnType<typeof testRuntime>;
const servers: Bun.Server<unknown>[] = [];
beforeEach(() => { restoreFetch(); });
afterEach(async () => {
  restoreFetch();
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});
function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
// The route now streams its result as SSE (long upstream LLM call vs the
// Cloudflare ~100s edge cutoff). Drain the body and return the single terminal
// frame: `done` carries the payload, `error` carries the sanitized message.
async function readDraft(res: Response): Promise<{ done: DraftVariableListResponse | undefined; error: string | undefined }> {
  const frames = parseSseText(await res.text());
  // Invariant: every non-disconnect response emits EXACTLY one terminal frame
  // (a double-emit would let the client resolve on the first `done` and ignore
  // a later `error`, or vice versa). Guard it here so a route regression fails.
  expect(frames.filter((f) => f.event === 'done' || f.event === 'error').length).toBe(1);
  const done = frames.find((f) => f.event === 'done');
  const error = frames.find((f) => f.event === 'error');
  return {
    done: done ? (done.data as DraftVariableListResponse) : undefined,
    error: error ? (error.data as { message: string }).message : undefined,
  };
}
function modelJson(payload: unknown): string {
  const frames = [
    JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(payload) }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ];
  return frames.map((f) => `data: ${f}\n\n`).join('');
}
function modelSse(payload: unknown): Response {
  return new Response(modelJson(payload), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
function draftTargetFromRequest(raw: string): number {
  const body = JSON.parse(raw) as {
    messages?: { role?: string; content?: string }[];
  };
  const userContent = body.messages?.find((message) => message.role === 'user')?.content;
  const match = userContent?.match(/Produce up to (\d+) new values\./);
  if (!match?.[1]) throw new Error(`missing draft target in request body: ${raw}`);
  return Number(match[1]);
}
function draftServer(payload: unknown): { url: string; targets: number[] } {
  const targets: number[] = [];
  const url = serve(async (req) => {
    targets.push(draftTargetFromRequest(await req.text()));
    return modelSse(payload);
  });
  return { url, targets };
}
async function createList(app: RT['app'], name: string, userId = 'alice'): Promise<VariableList> {
  const res = await app.fetch(new Request('http://local/api/prompts/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ name }),
  }));
  expect(res.status).toBe(201);
  return await res.json() as VariableList;
}
function draft(app: RT['app'], listId: string, body: unknown, userId = 'alice') {
  return app.fetch(new Request(`http://local/api/prompts/lists/${listId}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/prompts/lists/:id/draft', () => {
  test('404 for a non-allowlisted user (gate, leak-safe)', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await draft(app, crypto.randomUUID(), { name: 'x', existing: [] }, 'mallory');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  test('404 when the list is not owned by the user', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await draft(app, crypto.randomUUID(), { name: 'x', existing: [] }, 'alice');
    expect(res.status).toBe(404);
  });

  test('400 on an invalid body', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app, 'Colours');
    const res = await draft(app, list.id, { existing: [] });
    expect(res.status).toBe(400);
  });

  test('returns entries, deduped vs existing + capped to target', async () => {
    const up = serve(() => modelSse({ kind: 'entries', entries: ['Red', 'blue', 'green', 'green'] }));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x' });
    const list = await createList(app, 'Colours');
    const res = await draft(app, list.id, { name: 'Colours', existing: ['red'] });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done).toEqual({ kind: 'entries', entries: ['blue', 'green'] });
  });

  test('still drafts up to 20 new entries when the list already has 20+ options', async () => {
    const up = serve(() => modelSse({ kind: 'entries', entries: ['Crimson', 'Cobalt', 'Olive'] }));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x' });
    const list = await createList(app, 'Colours');
    const existing = Array.from({ length: 25 }, (_, i) => `colour ${i}`);
    const res = await draft(app, list.id, { name: 'Colours', existing });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done).toEqual({ kind: 'entries', entries: ['Crimson', 'Cobalt', 'Olive'] });
  });

  test('clamps target so the list never exceeds the 200-option cap', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const up = serve(() => modelSse({ kind: 'entries', entries: twenty }));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x', MAX_OPTIONS_PER_LIST: '200' });
    const list = await createList(app, 'Colours');
    const existing = Array.from({ length: 198 }, (_, i) => `e${i}`);
    const res = await draft(app, list.id, { name: 'Colours', existing });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done?.kind).toBe('entries');
    expect(done?.kind === 'entries' ? done.entries.length : -1).toBe(2);
  });

  test('drafts exactly the remaining slots one below the cap (199 -> 1)', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const up = serve(() => modelSse({ kind: 'entries', entries: twenty }));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x', MAX_OPTIONS_PER_LIST: '200' });
    const list = await createList(app, 'Colours');
    const existing = Array.from({ length: 199 }, (_, i) => `e${i}`);
    const res = await draft(app, list.id, { name: 'Colours', existing });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done?.kind === 'entries' ? done.entries.length : -1).toBe(1);
  });

  test('returns no entries when the list is at the cap', async () => {
    const up = serve(() => modelSse({ kind: 'entries', entries: ['x', 'y'] }));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x', MAX_OPTIONS_PER_LIST: '200' });
    const list = await createList(app, 'Colours');
    const existing = Array.from({ length: 200 }, (_, i) => `e${i}`);
    const res = await draft(app, list.id, { name: 'Colours', existing });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done).toEqual({ kind: 'entries', entries: [] });
  });

  test('draft target respects the env-lowered save cap so drafted entries are always saveable', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const up = serve(() => modelSse({ kind: 'entries', entries: twenty }));
    // Save cap env-lowered to 60. Draft must clamp to the SAME effective cap
    // the save endpoint enforces, so a 50-item list can only gain 10 more
    // (60 - 50) — never 20, which would produce an unsaveable 70-option list.
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x',
      MAX_OPTIONS_PER_LIST: '60',
    });
    const list = await createList(app, 'Colours');
    const existing = Array.from({ length: 50 }, (_, i) => `e${i}`);
    const res = await draft(app, list.id, { name: 'Colours', existing });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done?.kind === 'entries' ? done.entries.length : -1).toBe(10);
  });

  test('seed drafts with an empty existing list and description target 10 entries', async () => {
    const upstream = draftServer({ kind: 'entries', entries: ['Siamese'] });
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: upstream.url, CLIPROXY_TOKEN: 'sk-x',
    });
    const list = await createList(app, 'Cat breeds');
    const res = await draft(app, list.id, { name: 'Cat breeds', existing: [], description: 'cats by breed' });
    expect(res.status).toBe(200);
    await readDraft(res); // drain so the upstream call (target capture) completes
    expect(upstream.targets).toEqual([10]);
  });

  test('described non-empty drafts keep the expand target of 20 entries', async () => {
    const upstream = draftServer({ kind: 'entries', entries: ['Siamese'] });
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: upstream.url, CLIPROXY_TOKEN: 'sk-x',
    });
    const list = await createList(app, 'Cat breeds');
    const res = await draft(app, list.id, {
      name: 'Cat breeds',
      existing: ['Persian'],
      description: 'more cat breeds',
    });
    expect(res.status).toBe(200);
    await readDraft(res);
    expect(upstream.targets).toEqual([20]);
  });

  test('described non-empty drafts clamp the expand target to the remaining cap', async () => {
    const upstream = draftServer({ kind: 'entries', entries: ['Siamese'] });
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: upstream.url, CLIPROXY_TOKEN: 'sk-x',
      MAX_OPTIONS_PER_LIST: '5',
    });
    const list = await createList(app, 'Cat breeds');
    const res = await draft(app, list.id, {
      name: 'Cat breeds',
      existing: ['Persian', 'Bengal'],
      description: 'more cat breeds',
    });
    expect(res.status).toBe(200);
    await readDraft(res);
    expect(upstream.targets).toEqual([3]);
  });

  test('empty drafts without a description keep the expand target of 20 entries', async () => {
    const upstream = draftServer({ kind: 'entries', entries: ['Siamese'] });
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: upstream.url, CLIPROXY_TOKEN: 'sk-x',
    });
    const list = await createList(app, 'Cat breeds');
    const res = await draft(app, list.id, { name: 'Cat breeds', existing: [] });
    expect(res.status).toBe(200);
    await readDraft(res);
    expect(upstream.targets).toEqual([20]);
  });

  test('seed drafts clamp the 10-entry target to a lower save cap', async () => {
    const upstream = draftServer({ kind: 'entries', entries: ['Siamese'] });
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: upstream.url, CLIPROXY_TOKEN: 'sk-x',
      MAX_OPTIONS_PER_LIST: '5',
    });
    const list = await createList(app, 'Cat breeds');
    const res = await draft(app, list.id, { name: 'Cat breeds', existing: [], description: 'cats by breed' });
    expect(res.status).toBe(200);
    await readDraft(res);
    expect(upstream.targets).toEqual([5]);
  });

  test('passes the clarify question through', async () => {
    const up = serve(() => modelSse({ kind: 'clarify', question: 'What domain is "X"?' }));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x' });
    const list = await createList(app, 'X');
    const res = await draft(app, list.id, { name: 'X', existing: [] });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done).toEqual({ kind: 'clarify', question: 'What domain is "X"?' });
  });

  test('a clarify returned despite a description is a sanitized failure (no loop)', async () => {
    const up = serve(() => modelSse({ kind: 'clarify', question: 'still vague?' }));
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x', LOG_LEVEL: 'info',
    });
    const list = await createList(app, 'X');
    const res = await draft(app, list.id, { name: 'X', existing: [], description: 'a list of cat breeds' });
    expect(res.status).toBe(200);
    const { done, error } = await readDraft(res);
    expect(done).toBeUndefined();
    expect(error ?? '').not.toContain('still vague');
  });

  test('upstream failure -> sanitized error frame, detail logged not leaked', async () => {
    const up = serve(() => new Response(JSON.stringify({ error: { message: 'leaky detail' } }), { status: 500 }));
    const { app, logs } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x', LOG_LEVEL: 'info',
    });
    const list = await createList(app, 'Colours');
    const res = await draft(app, list.id, { name: 'Colours', existing: [] });
    expect(res.status).toBe(200);
    const { done, error } = await readDraft(res);
    expect(done).toBeUndefined();
    expect(error ?? '').not.toContain('leaky detail');
    expect(logs.join('\n')).toContain('leaky detail');
  });

  test('stalled upstream is bounded by CLOUD_TIMEOUT_MS', async () => {
    const up = serve(async () => { await Bun.sleep(5000); return modelSse({ kind: 'entries', entries: ['x'] }); });
    const { app, logs } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x', CLOUD_TIMEOUT_MS: '250',
      LOG_LEVEL: 'info',
    });
    const list = await createList(app, 'Colours');
    const res = await draft(app, list.id, { name: 'Colours', existing: [] });
    expect(res.status).toBe(200);
    const { error } = await readDraft(res); // resolves once the timeout fires and the error frame is sent
    expect(error).toBeDefined();
    expect(logs.join('\n')).toContain('draft_list_timeout');
    expect(logs.join('\n')).not.toContain('draft_list_crash');
  });
});
