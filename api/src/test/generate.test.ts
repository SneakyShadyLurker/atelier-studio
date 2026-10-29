import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateEvents, jsonRequest, parseSse, testRuntime } from './helpers';
import { pngBytes } from './image-fixtures';
import { allowJevForProviderTests, resetJevForProviderTests } from './jev-fixture';
import { writeAtomic } from '../storage/files';
import { acquireTiles, releaseTiles, resetConcurrencyForTests } from '../orchestrator/concurrency';
import * as queue from '../orchestrator/queue';
import { setGenerateSubmitRaceHookForTests } from '../routes/generate';

const servers: Bun.Server<unknown>[] = [];
const pngFixture = pngBytes();
const pngBase64 = Buffer.from(pngFixture).toString('base64');
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetJevForProviderTests();
  setGenerateSubmitRaceHookForTests(null);
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function sseResponse(frames: readonly { event: string; data: unknown }[]): Response {
  const body = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function seedUpload(
  runtime: ReturnType<typeof testRuntime>,
  userId: string,
  options: { sizeBytes?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  runtime.db.query(
    "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', ?, 64, 64, ?, ?)",
  ).run(id, userId, options.sizeBytes ?? pngFixture.byteLength, `sha-${id}`, now);
  if (options.sizeBytes === undefined) {
    await writeAtomic(runtime.config.DATA_DIR, 'uploads', userId, id, 'png', pngFixture);
  }
  return id;
}

function seedQueuedVideoBatch(runtime: ReturnType<typeof testRuntime>, userId: string, uploadId: string, modelId = 'minimax-h3-i2v'): string {
  const now = Date.now();
  const batchId = crypto.randomUUID();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  runtime.db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at, collection_id, pinned, status, pool, template_id, roll_seed, roll_pins, i2v_source_upload_id)
     VALUES (?, ?, 'animate', '16:9', ?, 'MiniMax H3', ?, NULL, NULL, 0, 'queued', 'local', NULL, NULL, NULL, ?)`,
  ).run(batchId, userId, modelId, now, uploadId);
  return batchId;
}

describe('generate', () => {
  test('a Krea face-reference submit passes preflight on a healthy model', async () => {
    const availability = new Map([['krea-2-gonzalomo', { ok: true, checkedAt: 1 }]]);
    const runtime = testRuntime({ availability, LOCAL_MODELS_USERS: 'alice' });
    const uploadId = await seedUpload(runtime, 'alice');
    const response = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'portrait', modelId: 'krea-2-gonzalomo', ratio: '1:1', count: 1, refImageIds: [uploadId],
    }, 'alice');
    expect(response.status).toBe(201);
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(1);
  });

  test('submits JSON, replays batch events, and writes artifacts', async () => {
    const { app, config } = testRuntime();
    const res = await jsonRequest(app, '/api/generate', {
      prompt: 'hello',
      modelId: 'mock-fast',
      ratio: '1:1',
      count: 2,
    }, 'test', 'application/json');
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    const submitted = await res.json() as { batchId: string };
    const eventsRes = await app.fetch(new Request(`http://local/api/batches/${submitted.batchId}/events`, {
      headers: { 'Remote-User': 'test' },
    }));
    expect(eventsRes.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(eventsRes.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(eventsRes.headers.get('content-encoding')).toBe('identity');
    expect(eventsRes.headers.get('x-accel-buffering')).toBe('no');
    const events = await parseSse(eventsRes);
    expect(events.map((event) => event.event)).toEqual(['batch', 'tile', 'tile', 'done']);
    expect((events[0]?.data as { tiles: unknown[] }).tiles).toHaveLength(2);
    for (const event of events.filter((item) => item.event === 'tile')) {
      expect(event.data).toMatchObject({ status: 'done', ext: 'png', mime: 'image/png' });
      const data = event.data as { url?: string; thumbUrl?: string };
      expect(data.thumbUrl).toBe(`${data.url}/thumb`);
    }
    expect(readdirSync(join(config.DATA_DIR, 'images', 'test')).filter((name) => name.endsWith('.png'))).toHaveLength(2);
    expect(existsSync(join(config.DATA_DIR, 'atelier.sqlite'))).toBe(true);
  });

  test('models endpoint returns mock registry with supportedRatios', async () => {
    const { app } = testRuntime();
    const res = await app.fetch(new Request('http://local/api/models', { headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(200);
    const models = (await res.json()) as { id: string; supportedRatios?: unknown[] }[];
    expect(models.some((model) => model.id === 'mock-fast')).toBe(true);
    expect(models.every((model) => Array.isArray(model.supportedRatios))).toBe(true);
  });

  test('models endpoint exposes the effective configured reference byte budget', async () => {
    const { app } = testRuntime({ MAX_REF_BYTES_PER_BATCH: '1234' });
    const res = await app.fetch(new Request('http://local/api/models', { headers: { 'Remote-User': 'test' } }));

    expect(res.status).toBe(200);
    const models = (await res.json()) as { id: string; maxRefBytesPerBatch?: number }[];
    expect(models.find((model) => model.id === 'gpt-image-2.5-sunburst')?.maxRefBytesPerBatch).toBe(1234);
  });

  test('rejects Gemini generate when user has no Google key', async () => {
    const runtime = testRuntime();

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'hello',
      modelId: 'gemini-3-pro-image-preview',
      ratio: '1:1',
      count: 1,
    }, 'alice');

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'BYOK key required',
      code: 'NEEDS_GOOGLE_KEY',
    });
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });

  test('treats undecryptable stored Google key as missing on Gemini generate', async () => {
    const runtime = testRuntime({ LOG_LEVEL: 'warn' });
    await runtime.seedKey('alice', 'google', `AIza${'x'.repeat(35)}`);
    runtime.db.run(`UPDATE user_provider_keys SET ciphertext = ? WHERE user_id = ? AND provider = ?`, [
      new Uint8Array([1, 2, 3]),
      'alice',
      'google',
    ]);

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'hello',
      modelId: 'gemini-3-pro-image-preview',
      ratio: '1:1',
      count: 1,
    }, 'alice');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'BYOK key required',
      code: 'NEEDS_GOOGLE_KEY',
    });
    expect(runtime.logs.join('')).toContain('BYOK key decrypt failed; treating as missing');
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });

  test('rejects offline pool=local model with 503 MODEL_OFFLINE', async () => {
    const availability = new Map([
      ['krea-2-gonzalomo', { ok: false as const, checkedAt: 1_700_000_000_000, reason: 'host down' }],
    ]);
    const runtime = testRuntime({ availability, LOCAL_MODELS_USERS: 'alice' });

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'hello',
      modelId: 'krea-2-gonzalomo',
      ratio: '1:1',
      count: 1,
    }, 'alice');

    expect(res.status).toBe(503);
    // The raw `reason` field is logged but NOT echoed publicly — it can
    // contain LAN host:port and would leak internal topology.
    expect(await res.json()).toEqual({
      error: 'model offline',
      code: 'MODEL_OFFLINE',
    });
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });

  test('allows pool=local model when snapshot says ok (offline guard does not fire)', async () => {
    const availability = new Map([
      ['krea-2-gonzalomo', { ok: true as const, checkedAt: 1_700_000_000_000 }],
    ]);
    const runtime = testRuntime({ availability, LOCAL_MODELS_USERS: 'alice' });

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'hello',
      modelId: 'krea-2-gonzalomo',
      ratio: '1:1',
      count: 1,
    }, 'alice');

    // Substantive assertion: when the guard is skipped, the orchestrator
    // takes over and inserts the batch row before any provider call. The
    // offline-guard test asserts the inverse (`toHaveLength(0)`). Comparing
    // the two batches-table observations is the only way to prove this test
    // actually exercised the post-guard code path rather than e.g. failing
    // validation upstream.
    const batches = runtime.db.query('SELECT id FROM batches').all();
    expect(batches).toHaveLength(1);
    // Belt-and-braces: even if the SSE stream errors downstream, MODEL_OFFLINE
    // is never the right code for an ok-snapshot run.
    if (res.status === 503) {
      const body = (await res.json()) as { code?: unknown };
      expect(body.code).not.toBe('MODEL_OFFLINE');
    }
  });

  test('an immediately started local batch records affinity for later queued work', async () => {
    // Pins the production wiring end to end: createApp configures the scheduler
    // with localResidencyKey, and the immediate-start branch of POST /generate
    // (batch never enqueued) still tells the queue which model now holds the GPU.
    // Affinity applies across users; each user's own accepted work stays FIFO.
    const availability = new Map([
      ['krea-2-gonzalomo', { ok: true as const, checkedAt: 1_700_000_000_000 }],
      ['moss-image-sft', { ok: true as const, checkedAt: 1_700_000_000_000 }],
    ]);
    const runtime = testRuntime({ availability, LOCAL_MODELS_USERS: 'alice,bob' });
    resetConcurrencyForTests();
    queue.resetQueueForTests();

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'hello',
      modelId: 'krea-2-gonzalomo',
      ratio: '1:1',
      count: 1,
    }, 'alice');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { status: string }).status).toBe('running');

    const queuedAt = Date.now();
    queue.enqueue('local', { batchId: 'moss-1', userId: 'alice', modelId: 'moss-image-sft', count: 1, queuedAt });
    queue.enqueue('local', { batchId: 'gonzalomo-2', userId: 'bob', modelId: 'krea-2-gonzalomo', count: 1, queuedAt });
    expect(queue.peekNext('local')?.batchId).toBe('gonzalomo-2');
    expect(queue.positionOf('local', 'moss-1')).toBe(1);
  });

  test('rejects Gemini generate as structurally unavailable when BYOK is disabled', async () => {
    const runtime = testRuntime({ disableByok: true });

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'hello',
      modelId: 'gemini-3-pro-image-preview',
      ratio: '1:1',
      count: 1,
    }, 'alice');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'byok-not-configured' });
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });

  test('Gemini generate uses stored Google key after per-request rebind', async () => {
    const runtime = testRuntime();
    const userId = 'alice';
    runtime.db.run(`INSERT INTO users (id, created_at) VALUES (?, ?)`, [userId, Date.now()]);
    if (!runtime.keyStore) throw new Error('expected keyStore in test runtime');
    await runtime.keyStore.put(userId, 'google', 'AIzaTEST');
    let seenPath = '';
    let seenKey = '';
    globalThis.fetch = ((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      seenPath = url.pathname;
      seenKey = new Headers(init?.headers).get('x-goog-api-key') ?? '';
      return Promise.resolve(new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: pngBase64,
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    }) as typeof fetch;

    const events = await generateEvents(runtime.app, {
      prompt: 'hello',
      modelId: 'gemini-3-pro-image-preview',
      ratio: '1:1',
      count: 1,
    }, userId);

    expect(seenPath).toBe('/v1beta/models/gemini-3-pro-image-preview:generateContent');
    expect(seenKey).toBe('AIzaTEST');
    expect(events.map((event) => event.event)).toEqual(['batch', 'tile', 'done']);
    expect(events[1]?.data).toMatchObject({ status: 'done', ext: 'png', mime: 'image/png' });
  });

  test('Gemini generate touches stored Google key after successful stream', async () => {
    const runtime = testRuntime();
    const userId = 'alice';
    runtime.db.run(`INSERT INTO users (id, created_at) VALUES (?, ?)`, [userId, Date.now()]);
    if (!runtime.keyStore) throw new Error('expected keyStore in test runtime');
    await runtime.keyStore.put(userId, 'google', 'AIzaTEST');
    globalThis.fetch = ((_input, _init) =>
      Promise.resolve(new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: pngBase64,
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))) as typeof fetch;

    const events = await generateEvents(runtime.app, {
      prompt: 'hello',
      modelId: 'gemini-3-pro-image-preview',
      ratio: '1:1',
      count: 1,
    }, userId);

    expect(events.map((event) => event.event)).toEqual(['batch', 'tile', 'done']);
    const row = runtime.db
      .query<{ last_used_at: number | null }, [string, string]>(
        `SELECT last_used_at FROM user_provider_keys WHERE user_id = ? AND provider = ?`,
      )
      .get(userId, 'google');
    expect(row?.last_used_at).toBeGreaterThan(0);
  });

  test('gpt-image-2.5-sunburst accepts refImageIds, routes to edits, and emits provenance', async () => {
    allowJevForProviderTests();
    let seenPath = '';
    const baseUrl = serve((req) => {
      seenPath = new URL(req.url).pathname;
      return sseResponse([{ event: 'image_edit.completed', data: { b64_json: pngBase64 } }]);
    });
    const runtime = testRuntime({ CLIPROXY_BASE_URL: baseUrl, CLIPROXY_TOKEN: 'sk-cliproxy-test' });
    const uploadId = await seedUpload(runtime, 'alice');

    const events = await generateEvents(runtime.app, {
      prompt: 'use the reference',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
      refImageIds: [uploadId],
    }, 'alice');

    expect(seenPath).toBe('/v1/images/edits');
    expect(events.find((event) => event.event === 'tile')?.data).toMatchObject({ status: 'done' });
    expect(events[0]?.data).toMatchObject({ refImageIds: [uploadId] });
    const refRows = runtime.db
      .query<{ upload_id: string; position: number }, []>('SELECT upload_id, position FROM tile_ref_images ORDER BY position')
      .all();
    expect(refRows).toEqual([{ upload_id: uploadId, position: 0 }]);
    const history = await runtime.app.fetch(new Request('http://local/api/history', { headers: { 'Remote-User': 'alice' } }));
    const page = await history.json() as { items: { tiles: { refImageIds?: string[] }[] }[] };
    expect(page.items[0]?.tiles[0]?.refImageIds).toEqual([uploadId]);
  });

  test('refImageIds against a non-supporting model returns precise validation error', async () => {
    const runtime = testRuntime();
    const uploadId = await seedUpload(runtime, 'alice');
    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'x',
      modelId: 'mock-fast',
      ratio: '1:1',
      count: 1,
      refImageIds: [uploadId],
    }, 'alice');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation failed',
      issues: [{ path: ['refImageIds'], message: 'model does not support reference images' }],
    });
  });

  test('unknown and cross-user refImageIds return upload not found', async () => {
    const runtime = testRuntime();
    const bobUpload = await seedUpload(runtime, 'bob');
    for (const uploadId of [crypto.randomUUID(), bobUpload]) {
      const res = await jsonRequest(runtime.app, '/api/generate', {
        prompt: 'x',
        modelId: 'gpt-image-2.5-sunburst',
        ratio: '1:1',
        count: 1,
        refImageIds: [uploadId],
      }, 'alice');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'upload not found' });
    }
  });

  test('duplicate refImageIds are rejected as a 400 validation error, not a misleading 404', async () => {
    const runtime = testRuntime();
    const uploadId = await seedUpload(runtime, 'alice');
    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'x',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
      refImageIds: [uploadId, uploadId],
    }, 'alice');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; issues: { path: (string | number)[]; message: string }[] };
    expect(body.error).toBe('validation failed');
    expect(body.issues.some((i) => i.path[0] === 'refImageIds' && i.message === 'duplicate refImageIds')).toBe(true);
  });

  test('reference images over the per-batch byte budget are rejected before generation', async () => {
    const runtime = testRuntime({ MAX_REF_BYTES_PER_BATCH: '10' });
    const uploadId = await seedUpload(runtime, 'alice', { sizeBytes: 11 });
    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'x',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
      refImageIds: [uploadId],
    }, 'alice');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'reference images exceed per-batch byte budget' });
  });

  test('cap-full reference request queues instead of returning a legacy 429', async () => {
    const runtime = testRuntime({ MAX_CONCURRENT_TILES: '1', MAX_CONCURRENT_TILES_PER_USER: '1' });
    const uploadId = await seedUpload(runtime, 'alice');
    const acquired = acquireTiles('alice', 1, 1, 1);
    expect(acquired.ok).toBe(true);
    try {
      const res = await jsonRequest(runtime.app, '/api/generate', {
        prompt: 'x',
        modelId: 'gpt-image-2.5-sunburst',
        ratio: '1:1',
        count: 1,
        refImageIds: [uploadId],
      }, 'alice', 'application/json');
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ status: 'queued', queueLengthAhead: 0 });
    } finally {
      releaseTiles('alice', 1);
    }
  });

  test('missing reference artifact after reservation returns 404 and cleans the batch', async () => {
    const runtime = testRuntime();
    const uploadId = await seedUpload(runtime, 'alice', { sizeBytes: pngFixture.byteLength });
    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'x',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
      refImageIds: [uploadId],
    }, 'alice');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'upload not found' });
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(0);
    expect(runtime.db.query('SELECT tile_id FROM tile_ref_images').all()).toHaveLength(0);
  });

  test('empty refImageIds is a validation error while omitted keeps text-to-image path', async () => {
    const runtime = testRuntime();
    const empty = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'x',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
      refImageIds: [],
    }, 'alice');
    expect(empty.status).toBe(400);

    const omitted = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'x',
      modelId: 'mock-fast',
      ratio: '1:1',
      count: 1,
    }, 'alice');
    expect(omitted.status).toBe(201);
  });

  test('ignores i2v fields for non-i2v models', async () => {
    const runtime = testRuntime();
    const uploadId = await seedUpload(runtime, 'alice');
    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'animate',
      modelId: 'mock-fast',
      ratio: '1:1',
      count: 1,
      i2vSourceUploadId: uploadId,
      motionPrompt: 'slow push in',
    }, 'alice');
    expect(res.status).toBe(201);
    const body = await res.json() as { batchId: string };
    const row = runtime.db
      .query<{ i2v_source_upload_id: string | null }, [string]>(
        'SELECT i2v_source_upload_id FROM batches WHERE id = ?',
      )
      .get(body.batchId);
    expect(row?.i2v_source_upload_id).toBeNull();
  });

  test('H3 requires an i2v source upload id', async () => {
    const runtime = testRuntime({
      COMFYUI_BASE_URL: 'http://127.0.0.1:1',
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice',
    });

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'animate',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
    }, 'alice');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation failed',
      issues: [{ path: ['i2vSourceUploadId'], message: 'i2vSourceUploadId is required for this model' }],
    });
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });

  test('H3 rejects a source upload owned by another user', async () => {
    const runtime = testRuntime({
      COMFYUI_BASE_URL: 'http://127.0.0.1:1',
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice',
    });
    const uploadId = await seedUpload(runtime, 'bob');

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'animate',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: uploadId,
    }, 'alice');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'upload not found' });
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });

  test('H3 rejects multi-image counts', async () => {
    const runtime = testRuntime({
      COMFYUI_BASE_URL: 'http://127.0.0.1:1',
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice',
    });
    const uploadId = await seedUpload(runtime, 'alice');

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'animate',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 2,
      i2vSourceUploadId: uploadId,
    }, 'alice');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation failed',
      issues: [{ path: ['count'], message: 'video models require count 1' }],
    });
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });

  test('H3 rejects a second in-flight video for the same user', async () => {
    const runtime = testRuntime({
      COMFYUI_BASE_URL: 'http://127.0.0.1:1',
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice',
      MAX_INFLIGHT_VIDEO_PER_USER: '1',
    });
    const uploadId = await seedUpload(runtime, 'alice');
    seedQueuedVideoBatch(runtime, 'alice', uploadId);

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'animate another',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: uploadId,
    }, 'alice');

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'video generation already in progress',
      code: 'VIDEO_BUSY',
    });
    expect(runtime.db.query('SELECT id FROM batches WHERE user_id = ?').all('alice')).toHaveLength(1);
  });

  test('T2V submits without a source and shares the in-flight video cap with I2V', async () => {
    const runtime = testRuntime({
      COMFYUI_BASE_URL: 'http://127.0.0.1:1',
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice,bob',
      MAX_INFLIGHT_VIDEO_PER_USER: '1',
    });
    const uploadId = await seedUpload(runtime, 'alice');
    // An in-flight T2V batch must block a new I2V submission (shared budget).
    seedQueuedVideoBatch(runtime, 'alice', uploadId, 'minimax-h3-t2v');

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'animate another',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: uploadId,
    }, 'alice');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'video generation already in progress',
      code: 'VIDEO_BUSY',
    });

    // A T2V submission carries no i2vSourceUploadId — it must never fail the
    // i2v source validation (a busy/offline outcome is fine, a 400 is not).
    const bare = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'a slow pan over a foggy harbor at dawn',
      modelId: 'minimax-h3-t2v',
      ratio: '16:9',
      count: 1,
    }, 'bob');
    expect(bare.status).not.toBe(400);
  });

  test('H3 rechecks the in-flight video cap inside the create transaction', async () => {
    const runtime = testRuntime({
      COMFYUI_BASE_URL: 'http://127.0.0.1:1',
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice',
      MAX_INFLIGHT_VIDEO_PER_USER: '1',
    });
    const uploadId = await seedUpload(runtime, 'alice');
    setGenerateSubmitRaceHookForTests(({ userId }) => {
      seedQueuedVideoBatch(runtime, userId, uploadId);
    });

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'animate after stale preflight',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: uploadId,
    }, 'alice');

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'video generation already in progress',
      code: 'VIDEO_BUSY',
    });
    const batches = runtime.db
      .query<{ id: string; prompt: string }, []>('SELECT id, prompt FROM batches ORDER BY created_at, id')
      .all();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.prompt).toBe('animate');
  });

  test('H3 rechecks source upload ownership inside the create transaction', async () => {
    const runtime = testRuntime({
      COMFYUI_BASE_URL: 'http://127.0.0.1:1',
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice',
    });
    const uploadId = await seedUpload(runtime, 'alice');
    setGenerateSubmitRaceHookForTests(() => {
      runtime.db.query('DELETE FROM uploads WHERE id = ?').run(uploadId);
    });

    const res = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'animate after stale source preflight',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: uploadId,
    }, 'alice');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'upload not found' });
    expect(runtime.db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });
});
