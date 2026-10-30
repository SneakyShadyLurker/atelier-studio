import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import type { DraftTemplateResponse, VariableList } from '@atelier/shared';
import { type CliproxyTextProvider, type TestCliproxyTextProvider } from '../providers/cliproxyText';
import type { LibraryOverview } from '../prompts/libraryOverview';
import { parseSseText, restoreFetch, testRuntime } from '../test/helpers';

const servers: Bun.Server<unknown>[] = [];
beforeEach(() => { restoreFetch(); });
afterEach(async () => {
  setTextModelProviderForTests(null);
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
async function readDraft(res: Response): Promise<{ done: DraftTemplateResponse | undefined; error: string | undefined }> {
  const frames = parseSseText(await res.text());
  // Invariant: every non-disconnect response emits EXACTLY one terminal frame
  // (a double-emit would let the client resolve on the first `done` and ignore
  // a later `error`, or vice versa). Guard it here so a route regression fails.
  expect(frames.filter((f) => f.event === 'done' || f.event === 'error').length).toBe(1);
  const done = frames.find((f) => f.event === 'done');
  const error = frames.find((f) => f.event === 'error');
  return {
    done: done ? (done.data as DraftTemplateResponse) : undefined,
    error: error ? (error.data as { message: string }).message : undefined,
  };
}

async function* emptyEnhance(): AsyncGenerator<never, void, unknown> {
  await Promise.resolve();
  if (Date.now() < 0) yield undefined as never;
}

function fakeProvider(
  draftTemplate: CliproxyTextProvider['draftTemplate'],
): TestCliproxyTextProvider {
  return {
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    draftTemplate,
    inferDimensions: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    inferTaxonomy: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
  };
}

async function createList(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  name: string,
): Promise<VariableList> {
  const res = await app.fetch(new Request('http://local/api/prompts/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ name }),
  }));
  expect(res.status).toBe(201);
  return await res.json() as VariableList;
}

async function draftTemplate(
  app: ReturnType<typeof testRuntime>['app'],
  body: { name: string; existingBody: string; description?: string },
  userId = 'alice',
  signal?: AbortSignal,
): Promise<Response> {
  return app.fetch(new Request('http://local/api/prompts/templates/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  }));
}

describe('POST /api/prompts/templates/draft', () => {
  test('non-allowlisted user → 404', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await app.fetch(new Request('http://local/api/prompts/templates/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'stranger' },
      body: JSON.stringify({ name: 'T', existingBody: '' }),
    }));
    expect(res.status).toBe(404);
  });

  test('happy path returns body', async () => {
    const expectedPayload: DraftTemplateResponse = { kind: 'body', body: 'A cinematic portrait.', warnings: [] };
    setTextModelProviderForTests(fakeProvider(
      () => Promise.resolve({ type: 'ok', payload: expectedPayload }),
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await draftTemplate(app, { name: 'Portrait', existingBody: 'A portrait.' });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done).toEqual(expectedPayload);
  });

  test('unsaved-template flow — works without a stored template id (headline use case)', async () => {
    // The route must accept requests with no pre-existing template. The library
    // overview must be built from the calling user's own data, not the absent template.
    let capturedLibrary: LibraryOverview | null = null;
    setTextModelProviderForTests(fakeProvider(
      (input) => {
        capturedLibrary = input.library;
        return Promise.resolve({ type: 'ok', payload: { kind: 'body', body: 'drafted', warnings: [] } });
      },
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    // alice has a list but no saved template — this is the "new template + AI" flow
    await createList(app, 'alice', 'subject');
    const res = await draftTemplate(app, { name: 'New Template', existingBody: '' }, 'alice');
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done).toEqual({ kind: 'body', body: 'drafted', warnings: [] });
    // library overview must be alice's own data
    expect(capturedLibrary).not.toBeNull();
    const listNames = (capturedLibrary as unknown as LibraryOverview).lists.map((l) => l.name);
    expect(listNames).toContain('subject');
  });

  test('clarify path passes through unchanged', async () => {
    const expectedPayload: DraftTemplateResponse = { kind: 'clarify', question: 'What subject?' };
    setTextModelProviderForTests(fakeProvider(
      () => Promise.resolve({ type: 'ok', payload: expectedPayload }),
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await draftTemplate(app, { name: 'Portrait', existingBody: '' });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done).toEqual(expectedPayload);
  });

  test('clarify after description present → sanitized error frame', async () => {
    setTextModelProviderForTests(fakeProvider(
      () => Promise.resolve({ type: 'ok', payload: { kind: 'clarify', question: 'What subject?' } }),
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await draftTemplate(app, { name: 'Portrait', existingBody: '', description: 'cinematic' });
    expect(res.status).toBe(200);
    const { done, error } = await readDraft(res);
    expect(done).toBeUndefined();
    expect(error).toBeDefined();
    expect(error).not.toContain('What subject?');
  });

  test('invalid body (Zod rejection) → 400', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    // Missing required `existingBody` field
    const res = await app.fetch(new Request('http://local/api/prompts/templates/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ name: 'Portrait' }),
    }));
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string; issues: unknown[] };
    expect(data.error).toBe('validation failed');
    expect(Array.isArray(data.issues)).toBe(true);
  });

  test('multibyte body byte-cap parity — single 4-byte emoji at 4-byte cap accepted', async () => {
    setTextModelProviderForTests(fakeProvider(
      () => Promise.resolve({ type: 'ok', payload: { kind: 'body', body: '🌅', warnings: [] } }),
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice', MAX_TEMPLATE_BODY_BYTES: '4' });
    const res = await draftTemplate(app, { name: 'T', existingBody: '🌅' });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    expect(done).toEqual({ kind: 'body', body: '🌅', warnings: [] });
  });

  test('multibyte body byte-cap parity — two emoji over 4-byte cap → 409', async () => {
    setTextModelProviderForTests(fakeProvider(
      () => Promise.resolve({ type: 'ok', payload: { kind: 'body', body: '🌅🌅', warnings: [] } }),
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice', MAX_TEMPLATE_BODY_BYTES: '4' });
    const res = await draftTemplate(app, { name: 'T', existingBody: '🌅🌅' });
    expect(res.status).toBe(409);
  });

  test('upstream failure → sanitized error frame (detail not leaked)', async () => {
    setTextModelProviderForTests(fakeProvider(
      () => Promise.resolve({ type: 'failed', status: 500, detail: 'PRIVATE DEBUG model key abc123' }),
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await draftTemplate(app, { name: 'Portrait', existingBody: '' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('PRIVATE DEBUG');
    // The terminal frame is a sanitized error, not a payload.
    const frames = parseSseText(text);
    expect(frames.some((f) => f.event === 'error')).toBe(true);
    expect(frames.some((f) => f.event === 'done')).toBe(false);
  });

  test('cross-user isolation — provider receives the caller user library only', async () => {
    let capturedLibrary: LibraryOverview | null = null;
    setTextModelProviderForTests(fakeProvider(
      (input) => {
        capturedLibrary = input.library;
        return Promise.resolve({ type: 'ok', payload: { kind: 'body', body: 'result', warnings: [] } });
      },
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice,bob' });

    // Seed alice with a 'lens' list
    await createList(app, 'alice', 'lens');
    // Seed bob with a 'mood' list
    await createList(app, 'bob', 'mood');

    const res = await draftTemplate(app, { name: 'Portrait', existingBody: '' }, 'alice');
    expect(res.status).toBe(200);
    await readDraft(res); // drain so the provider call completes

    expect(capturedLibrary).not.toBeNull();
    const listNames = (capturedLibrary as unknown as LibraryOverview).lists.map((l) => l.name);
    expect(listNames).toContain('lens');
    expect(listNames).not.toContain('mood');
  });

  test('model-echoes-existing-body contract: editor appends model output verbatim (no server-side dedup)', async () => {
    // Documents the current append contract: the route returns whatever the
    // provider gives back, even if the model erroneously included the existing
    // body. The editor (TemplateEditor.tsx) appends the returned body to the
    // existing body with spacing — there is no server-side duplication check.
    // If this test starts failing because we add a strip-if-duplicate guard,
    // update both the route implementation and this test.
    const existingBody = 'A portrait in golden hour light.';
    const modelContinuation = 'Soft bokeh background.';
    const modelOutput = existingBody + ' ' + modelContinuation; // model echoed + continued
    setTextModelProviderForTests(fakeProvider(
      () => Promise.resolve({ type: 'ok', payload: { kind: 'body', body: modelOutput, warnings: [] } }),
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await draftTemplate(app, { name: 'Portrait', existingBody });
    expect(res.status).toBe(200);
    const { done } = await readDraft(res);
    // The route passes the model output through unchanged.
    // The tightened system prompt instructs the model to omit the existing
    // prefix — this test documents that the server has no defensive strip yet.
    expect(done?.kind).toBe('body');
    if (done?.kind === 'body') {
      expect(done.body).toBe(modelOutput);
    }
  });

  test('stalled upstream is bounded by CLOUD_TIMEOUT_MS', async () => {
    // Stall until the request is aborted (rather than sleeping a fixed time) so
    // the upstream server completes as soon as the route aborts its fetch, keeping
    // the test fast without requiring app.stop().
    const up = serve((req: Request) => new Promise<Response>((resolve) => {
      req.signal.addEventListener('abort', () => { resolve(new Response('{}', { status: 200 })); }, { once: true });
    }));
    const { app, logs } = testRuntime({
      seedLegacyText: true,
      PROMPT_LIBRARY_USERS: 'alice', CLIPROXY_BASE_URL: up, CLIPROXY_TOKEN: 'sk-x', CLOUD_TIMEOUT_MS: '250',
      LOG_LEVEL: 'info',
    });
    const res = await draftTemplate(app, { name: 'Portrait', existingBody: '' });
    expect(res.status).toBe(200);
    const { error } = await readDraft(res); // drains: resolves once the timeout fires and the error frame is sent
    expect(error).toBeDefined();
    expect(logs.join('\n')).toContain('draft_template_timeout');
    expect(logs.join('\n')).not.toContain('draft_template_crash');
  });

  test('client disconnect aborts the upstream call', async () => {
    // Track whether the signal passed to the provider was aborted.
    let upstreamSignalAborted = false;
    // Fake provider that stalls until its signal is aborted
    setTextModelProviderForTests(fakeProvider(
      (_input, signal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            upstreamSignalAborted = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
          }, { once: true });
          // Never resolves on its own — stall until abort from the abort bridge
        });
      },
    ));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });

    // Stand up a real Bun.serve so the client abort propagates as a real network
    // disconnect — c.req.raw.signal fires when the client closes the connection.
    const appServer = Bun.serve({ port: 0, fetch: (req) => app.fetch(req) });
    servers.push(appServer);
    const base = `http://127.0.0.1:${appServer.port}`;

    const ac = new AbortController();
    const fetchPromise = fetch(`${base}/api/prompts/templates/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ name: 'Portrait', existingBody: '' }),
      signal: ac.signal,
    });

    // Give the request time to reach the handler and enter the stalled provider
    await Bun.sleep(80);
    ac.abort();

    // Response may be an aborted error or a closed stream — both are acceptable
    await fetchPromise.then((r) => r.body?.cancel()).catch(() => null);

    // Give abort propagation time to reach the provider signal.
    await Bun.sleep(200);
    expect(upstreamSignalAborted).toBe(true);
  });
});
