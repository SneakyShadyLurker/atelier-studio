import { afterEach, expect, spyOn, test } from 'bun:test';
import { MAX_JSON_REQUEST_BYTES, MAX_PROMPT_LIBRARY_JSON_REQUEST_BYTES, setJsonBodyReadTimeoutForTests } from './_json-body-limit';
import { testRuntime } from '../test/helpers';
import { withUploadSlot } from './uploads-runtime';
import {
  MAX_CONCURRENT_JSON_BODIES_PER_USER, MAX_PENDING_JSON_BODIES_PER_USER,
  resetJsonBodyRuntimeForTests, withJsonBodySlot,
} from './json-body-runtime';

afterEach(() => { setJsonBodyReadTimeoutForTests(null); resetJsonBodyRuntimeForTests(); });

function streamedRequest(path: string, options: {
  bytes?: Uint8Array;
  totalBytes?: number;
  headers?: Record<string, string>;
  method?: string;
  signal?: AbortSignal;
} = {}) {
  const chunk = new Uint8Array(16 * 1024).fill(32);
  const total = options.bytes?.byteLength ?? options.totalBytes ?? MAX_JSON_REQUEST_BYTES * 2;
  let consumed = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (consumed === total) { controller.close(); return; }
      const length = Math.min(chunk.length, total - consumed);
      controller.enqueue(options.bytes?.subarray(consumed, consumed + length) ?? chunk.subarray(0, length));
      consumed += length;
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  return {
    request: new Request(`http://local${path}`, {
      method: options.method ?? 'POST', body,
      ...(options.signal ? { signal: options.signal } : {}),
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice', ...options.headers },
    }),
    consumed: () => consumed,
    canceled: () => canceled,
  };
}

function delayedRequest(path: string, delayMs: number, method = 'POST', signal?: AbortSignal) {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(delayMs);
      if (canceled) return;
      controller.enqueue(new TextEncoder().encode('{}'));
      controller.close();
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  return new Request(`http://local${path}`, {
    method, headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' }, body, ...(signal ? { signal } : {}),
  });
}

for (const contentLength of [undefined, '1', String(MAX_JSON_REQUEST_BYTES + 1)]) {
  test(`oversized JSON with Content-Length ${contentLength ?? 'absent'} returns early 413 before route/provider mutations`, async () => {
    const runtime = testRuntime();
    await runtime.fetch('/api/session', { headers: { 'Remote-User': 'alice' } });
    const before = runtime.db.query('SELECT total_changes() AS n').get();
    const body = streamedRequest('/api/generate', {
      headers: contentLength === undefined ? {} : { 'Content-Length': contentLength },
    });
    let providerCalls = 0;
    const providerFetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(() => {
      providerCalls += 1;
      return Promise.reject(new Error('unexpected provider call'));
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      const response = await runtime.app.fetch(body.request);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'request body too large' });
      expect(body.consumed()).toBeLessThan(MAX_JSON_REQUEST_BYTES * 2);
      expect(body.canceled()).toBe(true);
      expect(providerCalls).toBe(0);
      expect(runtime.db.query('SELECT total_changes() AS n').get()).toEqual(before);
    } finally { providerFetch.mockRestore(); }
  });
}

test('the byte limit also covers multibyte JSON and non-JSON content types before parsing', async () => {
  const runtime = testRuntime();
  const bytes = new TextEncoder().encode(JSON.stringify({ prompt: '界'.repeat(400_000) }));
  expect(bytes.length).toBeGreaterThan(MAX_JSON_REQUEST_BYTES);
  const body = streamedRequest('/api/generate', { bytes, headers: { 'Content-Type': 'text/plain' } });
  expect((await runtime.app.fetch(body.request)).status).toBe(413);
  expect(body.canceled()).toBe(true);
  expect(runtime.db.query('SELECT COUNT(*) AS n FROM batches').get()).toEqual({ n: 0 });
});

test('a valid Unicode generation request at the ordinary byte ceiling still succeeds', async () => {
  const runtime = testRuntime();
  const prompt = '界'.repeat(6000);
  const json = new TextEncoder().encode(JSON.stringify({ prompt, modelId: 'mock-fast', ratio: '1:1', count: 1 }));
  const bytes = new Uint8Array(MAX_JSON_REQUEST_BYTES).fill(32);
  bytes.set(json, bytes.length - json.length);
  const body = streamedRequest('/api/generate', { bytes });
  const response = await runtime.app.fetch(body.request);
  expect(response.status).toBe(201);
  expect(body.consumed()).toBe(MAX_JSON_REQUEST_BYTES);
  const { batchId } = await response.json() as { batchId: string };
  const events = await runtime.fetch(`/api/batches/${batchId}/events`, { headers: { 'Remote-User': 'alice' } });
  expect(await events.text()).toContain('event: done');
  expect(runtime.db.query('SELECT prompt FROM batches WHERE id = ?').get(batchId)).toEqual({ prompt });
});

test('prompt-library requests accept 2,000 maximum-length escaped option values', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', MAX_OPTIONS_PER_LIST: '2000' });
  const created = await runtime.fetch('/api/prompts/lists', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'large list' }),
  });
  const { id } = await created.json() as { id: string };
  const value = `界${'\u0001'.repeat(1999)}`;
  const options = Array.from({ length: 2000 }, (_, sortOrder) => ({ value, tagIds: [], sortOrder }));
  const bytes = new TextEncoder().encode(JSON.stringify({ options }));
  expect(bytes.length).toBeGreaterThan(24_000_000);
  expect(bytes.length).toBeLessThan(MAX_PROMPT_LIBRARY_JSON_REQUEST_BYTES);
  const body = streamedRequest(`/api/prompts/lists/${id}/options`, { bytes, method: 'PUT' });
  const response = await runtime.app.fetch(body.request);
  expect(response.status).toBe(200);
  await response.body?.cancel();
  expect(runtime.db.query('SELECT COUNT(*) AS n, MIN(length(value)) AS length FROM variable_options WHERE list_id = ?').get(id))
    .toEqual({ n: 2000, length: 2000 });
});

test('prompt-library requests over their own ceiling cancel without mutation', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  await runtime.fetch('/api/session', { headers: { 'Remote-User': 'alice' } });
  const before = runtime.db.query('SELECT total_changes() AS n').get();
  const body = streamedRequest('/api/prompts/templates', {
    totalBytes: MAX_PROMPT_LIBRARY_JSON_REQUEST_BYTES + 1024 * 1024,
    headers: { 'Content-Length': '1' },
  });
  expect((await runtime.app.fetch(body.request)).status).toBe(413);
  expect(body.canceled()).toBe(true);
  expect(body.consumed()).toBeLessThan(MAX_PROMPT_LIBRARY_JSON_REQUEST_BYTES + 1024 * 1024);
  expect(runtime.db.query('SELECT total_changes() AS n').get()).toEqual(before);
});

test('a declared small library request enforces the small actual-byte ceiling', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const body = streamedRequest('/api/prompts/lists', { totalBytes: MAX_JSON_REQUEST_BYTES * 2, headers: { 'Content-Length': '1' } });
  expect((await runtime.app.fetch(body.request)).status).toBe(413);
  expect(body.consumed()).toBeLessThan(MAX_JSON_REQUEST_BYTES * 2);
  expect(body.canceled()).toBe(true);
  expect(runtime.db.query('SELECT COUNT(*) AS n FROM variable_lists').get()).toEqual({ n: 0 });
});

test('large JSON saturation across users leaves generation and declared-small library mutations available', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice,bob,charlie' });
  const gate = Promise.withResolvers<undefined>();
  const blockers = ['alice', 'bob'].flatMap((user) => [0, 1].map(() => withJsonBodySlot(user, () => gate.promise, undefined, 'large')));
  const abort = new AbortController();
  const large = streamedRequest('/api/prompts/lists', { bytes: new TextEncoder().encode('{}'), headers: { 'Remote-User': 'charlie' }, signal: abort.signal });
  const pending = runtime.app.fetch(large.request);
  try {
    await Bun.sleep(0);
    expect(large.consumed()).toBe(0);
    const response = await runtime.fetch('/api/generate', {
      method: 'POST', headers: { 'Remote-User': 'charlie', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'small stays available', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
    });
    expect(response.status).toBe(201);
    const { batchId } = await response.json() as { batchId: string };
    const events = await runtime.fetch(`/api/batches/${batchId}/events`, { headers: { 'Remote-User': 'charlie' } });
    expect(await events.text()).toContain('event: done');
    const json = JSON.stringify({ name: 'small list' });
    const mutation = await runtime.fetch('/api/prompts/lists', {
      method: 'POST', headers: { 'Remote-User': 'charlie', 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(json).length) }, body: json,
    });
    expect(mutation.status).toBe(201);
    abort.abort();
    expect((await pending).status).toBe(400);
    expect(large.consumed()).toBe(0);
  } finally { abort.abort(); gate.resolve(undefined); await Promise.all(blockers); await pending; }
});

test('stalled credential probes cannot occupy small capacity; aborted waits and failed probes release credential slots', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'eve' });
  const gate = Promise.withResolvers<undefined>();
  let calls = 0;
  const providerFetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
    calls += 1;
    await gate.promise;
    return new Response('{}', { status: 503 });
  }, { preconnect: globalThis.fetch.preconnect }));
  const key = `AIza${'x'.repeat(35)}`;
  const probes = ['alice', 'bob', 'carol', 'dave'].map((user) => runtime.fetch('/api/keys/google', {
    method: 'PUT', headers: { 'Remote-User': user, 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
  }));
  const abort = new AbortController();
  let queued: Promise<Response> | undefined;
  try {
    const deadline = Date.now() + 1000;
    while (calls < 4 && Date.now() < deadline) await Bun.sleep(1);
    expect(calls).toBe(4);
    const generation = await runtime.fetch('/api/generate', {
      method: 'POST', headers: { 'Remote-User': 'eve', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'credentials stay separate', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
    });
    expect(generation.status).toBe(201);
    const { batchId } = await generation.json() as { batchId: string };
    const events = await runtime.fetch(`/api/batches/${batchId}/events`, { headers: { 'Remote-User': 'eve' } });
    expect(await events.text()).toContain('event: done');
    const json = JSON.stringify({ name: 'control mutation' });
    expect((await runtime.fetch('/api/prompts/lists', {
      method: 'POST', headers: { 'Remote-User': 'eve', 'Content-Type': 'application/json', 'Content-Length': String(json.length) }, body: json,
    })).status).toBe(201);
    const body = streamedRequest('/api/keys/google', {
      method: 'PUT', headers: { 'Remote-User': 'eve' }, bytes: new TextEncoder().encode(JSON.stringify({ key })), signal: abort.signal,
    });
    queued = Promise.resolve(runtime.app.fetch(body.request));
    await Bun.sleep(0);
    expect(body.consumed()).toBe(0);
    abort.abort();
    expect((await queued).status).toBe(400);
    expect(body.canceled()).toBe(true);
    expect(calls).toBe(4);
  } finally {
    abort.abort();
    gate.resolve(undefined);
    const results = await Promise.all(probes);
    expect(results.map((response) => response.status)).toEqual([503, 503, 503, 503]);
    await queued;
    providerFetch.mockRestore();
  }
  expect(await withJsonBodySlot('eve', () => Promise.resolve('released'), undefined, 'credentials')).toBe('released');
});

test('credential bodies retain the ordinary actual-byte ceiling', async () => {
  const runtime = testRuntime();
  const body = streamedRequest('/api/keys/google', { method: 'PUT' });
  expect((await runtime.app.fetch(body.request)).status).toBe(413);
  expect(body.canceled()).toBe(true);
  expect(body.consumed()).toBeLessThan(MAX_JSON_REQUEST_BYTES * 2);
});

test('authentication, CSRF and session guards reject before reading or limiting JSON', async () => {
  for (const [env, headers, status] of [
    [{}, { 'Remote-User': '' }, 401],
    [{ CSRF_PROTECT: 'true' }, {}, 403],
    [{}, { 'X-Atelier-Session-Scope': 'old-account' }, 409],
  ] as const) {
    const runtime = testRuntime(env);
    const body = streamedRequest('/api/generate', {
      headers: { ...headers, 'Content-Length': String(MAX_JSON_REQUEST_BYTES + 1) },
    });
    expect((await runtime.app.fetch(body.request)).status).toBe(status);
    expect(body.consumed()).toBe(0);
    await body.request.body?.cancel();
  }
});

test('prompt authorization rejects an expanded body without consuming bytes', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'bob' });
  const body = streamedRequest('/api/prompts/does-not-exist');
  expect((await runtime.app.fetch(body.request)).status).toBe(404);
  expect(body.consumed()).toBe(0);
  expect(body.canceled()).toBe(true);
});

test('a queued body consumes nothing and abort releases its admission wait', async () => {
  const runtime = testRuntime();
  const gate = Promise.withResolvers<undefined>();
  const blockers = [0, 1].map(() => withJsonBodySlot('alice', () => gate.promise));
  const abort = new AbortController();
  const body = streamedRequest('/api/generate', { bytes: new TextEncoder().encode('{}'), signal: abort.signal });
  const pending = runtime.app.fetch(body.request);
  await Bun.sleep(0);
  expect(body.consumed()).toBe(0);
  abort.abort();
  expect((await pending).status).toBe(400);
  expect(body.consumed()).toBe(0);
  gate.resolve(undefined);
  await Promise.all(blockers);
  expect(await withJsonBodySlot('alice', () => Promise.resolve('released'))).toBe('released');
});

test('a stalled body times out and frees its slot', async () => {
  const runtime = testRuntime();
  setJsonBodyReadTimeoutForTests(5);
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }, { highWaterMark: 0 });
  const response = await runtime.app.fetch(new Request('http://local/api/generate', {
    method: 'POST', headers: { 'Remote-User': 'alice' }, body,
  }));
  expect(response.status).toBe(408);
  expect(response.headers.get('Retry-After')).toBe('5');
  expect(await response.json()).toEqual({ error: 'request body timed out' });
  expect(canceled).toBe(true);
  expect(await withJsonBodySlot('alice', () => Promise.resolve('released'))).toBe('released');
});

test('queue wait has its own bounded deadline and consumes no admitted read allowance', async () => {
  const runtime = testRuntime();
  runtime.app.post('/api/read-budget', async (c) => { await c.req.json(); return c.json({ ok: true }); });
  setJsonBodyReadTimeoutForTests(25, { queueWaitMs: 150 });
  const gate = Promise.withResolvers<undefined>();
  const blockers = [0, 1].map(() => withJsonBodySlot('alice', () => gate.promise));
  const pending = runtime.app.fetch(delayedRequest('/api/read-budget', 10));
  try {
    await Bun.sleep(60); // longer than the complete admitted read allowance
    gate.resolve(undefined);
    expect((await pending).status).toBe(200);
  } finally { gate.resolve(undefined); await Promise.all(blockers); await pending; }

  setJsonBodyReadTimeoutForTests(200, { queueWaitMs: 10 });
  const blocked = Promise.withResolvers<undefined>();
  const held = [0, 1].map(() => withJsonBodySlot('alice', () => blocked.promise));
  const request = streamedRequest('/api/read-budget', { bytes: new TextEncoder().encode('{}') });
  try {
    const response = await runtime.app.fetch(request.request);
    expect(response.status).toBe(408);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(request.consumed()).toBe(0);
    expect(request.canceled()).toBe(true);
  } finally { blocked.resolve(undefined); await Promise.all(held); }
});

test('an expired queue deadline cannot cancel an active read or mask a downstream failure', async () => {
  const runtime = testRuntime();
  runtime.app.post('/api/read-budget', async (c) => { await c.req.json(); return c.json({ ok: true }); });
  const failure = new Error('downstream handler failed');
  runtime.app.post('/api/downstream-error', async (c) => {
    await c.req.json();
    await Bun.sleep(30);
    throw failure;
  });
  runtime.app.onError((error) => { throw error; });
  setJsonBodyReadTimeoutForTests(100, { queueWaitMs: 10 });
  expect((await runtime.app.fetch(delayedRequest('/api/read-budget', 30))).status).toBe(200);
  let caught: unknown;
  try { await runtime.app.fetch(delayedRequest('/api/downstream-error', 0)); }
  catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(await withJsonBodySlot('alice', () => Promise.resolve('released'))).toBe('released');
});

test('large authorized reads outlive the small/credentials read budget while all reads remain bounded', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  runtime.app.post('/api/prompts/read-budget', async (c) => { await c.req.json(); return c.json({ ok: true }); });
  setJsonBodyReadTimeoutForTests(10, { queueWaitMs: 100, largeReadMs: 100 });
  expect((await runtime.app.fetch(delayedRequest('/api/prompts/read-budget', 35))).status).toBe(200);
  expect((await runtime.app.fetch(delayedRequest('/api/generate', 35))).status).toBe(408);
  expect((await runtime.app.fetch(delayedRequest('/api/keys/google', 35, 'PUT'))).status).toBe(408);

  setJsonBodyReadTimeoutForTests(10, { queueWaitMs: 100, largeReadMs: 15 });
  expect((await runtime.app.fetch(delayedRequest('/api/prompts/read-budget', 35))).status).toBe(408);
  expect(await withJsonBodySlot('alice', () => Promise.resolve('released'), undefined, 'large')).toBe('released');
});

test('production deadlines allocate 60 seconds to queueing and 600 seconds to admitted large reads', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  runtime.app.post('/api/prompts/read-budget', async (c) => { await c.req.json(); return c.json({ ok: true }); });
  const timeout = spyOn(AbortSignal, 'timeout');
  try {
    expect((await runtime.app.fetch(delayedRequest('/api/prompts/read-budget', 0))).status).toBe(200);
    expect(timeout.mock.calls.map((args) => args[0])).toEqual([60_000, 600_000]);
  } finally { timeout.mockRestore(); }
});

test('aborting an admitted large body cancels reading and releases admission', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const abort = new AbortController();
  const request = delayedRequest('/api/prompts/read-budget', 30, 'POST', abort.signal);
  const pending = runtime.app.fetch(request);
  await Bun.sleep(0);
  abort.abort();
  expect((await pending).status).toBe(400);
  expect(await withJsonBodySlot('alice', () => Promise.resolve('released'), undefined, 'large')).toBe('released');
});

test('saturated uploads do not delay an ordinary JSON generation request', async () => {
  const runtime = testRuntime();
  const gate = Promise.withResolvers<undefined>();
  const uploads = [0, 1].map(() => withUploadSlot('alice', () => gate.promise));
  try {
    const response = await runtime.fetch('/api/generate', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'independent JSON admission', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
    });
    expect(response.status).toBe(201);
    const { batchId } = await response.json() as { batchId: string };
    const events = await runtime.fetch(`/api/batches/${batchId}/events`, { headers: { 'Remote-User': 'alice' } });
    expect(await events.text()).toContain('event: done');
  } finally { gate.resolve(undefined); await Promise.all(uploads); }
});

test('a full JSON queue returns the existing QUEUE_FULL retry protocol without reading', async () => {
  const runtime = testRuntime();
  const gate = Promise.withResolvers<undefined>();
  const blockers = Array.from({ length: MAX_CONCURRENT_JSON_BODIES_PER_USER + MAX_PENDING_JSON_BODIES_PER_USER },
    () => withJsonBodySlot('alice', () => gate.promise));
  const body = streamedRequest('/api/generate');
  try {
    const response = await runtime.app.fetch(body.request);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(await response.json()).toEqual({ error: 'request body queue full', code: 'QUEUE_FULL', retry_after_seconds: 5 });
    expect(body.consumed()).toBe(0);
    expect(body.canceled()).toBe(true);
  } finally { gate.resolve(undefined); await Promise.all(blockers); }
  expect(await withJsonBodySlot('alice', () => Promise.resolve('released'))).toBe('released');
});
