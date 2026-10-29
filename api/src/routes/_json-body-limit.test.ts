import { expect, spyOn, test } from 'bun:test';
import { MAX_JSON_REQUEST_BYTES, MAX_PROMPT_LIBRARY_JSON_REQUEST_BYTES } from './_json-body-limit';
import { testRuntime } from '../test/helpers';

function streamedRequest(path: string, options: {
  bytes?: Uint8Array;
  totalBytes?: number;
  headers?: Record<string, string>;
  method?: string;
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
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice', ...options.headers },
    }),
    consumed: () => consumed,
    canceled: () => canceled,
  };
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
