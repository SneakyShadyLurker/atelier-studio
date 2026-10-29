import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Server } from 'bun';
import { CHARACTER_CARD_DIRECTION_MAX_CHARS, MAX_PROMPT_CHARS } from '@atelier/shared';
import { generateHybridIdentity, identityToRecipient } from 'age-encryption';
import { configureLlmAdmissionPools, enhancePool, resetLlmAdmissionForTests } from '../orchestrator/llmAdmission';
import {
  configureStorageKeyring,
  MemoryUserKeyStore,
  StorageKeyring,
  StorageSealedError,
} from '../storage/crypto';
import { namedArtifactDir, writeAtomic } from '../storage/files';
import { grayCardPng } from '../test/image-fixtures';
import { parseSseText, testRuntime } from '../test/helpers';

const KEY = 'i'.repeat(48);
const ORIGIN = 'https://ephemera.example.org';
const USER = 'alice';
const PROMPT = 'portrait of a lighthouse keeper, rain on the window';
const CARD_NAME = 'Mara Quill';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface FakeRequest {
  readonly headers: Headers;
  readonly fileBytes: Uint8Array | null;
  readonly id: unknown;
  readonly notes: unknown;
  readonly direction: unknown;
  readonly kind: unknown;
}

let fake: Server<undefined> | null = null;

afterEach(async () => {
  await fake?.stop(true);
  fake = null;
  configureStorageKeyring(null);
  resetLlmAdmissionForTests();
});

interface Fake {
  readonly baseUrl: string;
  readonly requests: FakeRequest[];
  readonly aborted: { value: boolean };
}

function startFake(answer: (id: string) => Response): Fake {
  const requests: FakeRequest[] = [];
  const aborted = { value: false };
  fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      req.signal.addEventListener('abort', () => { aborted.value = true; });
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- test server uses Bun's built-in multipart parser.
      const form = await req.formData();
      const file = form.get('file');
      const id = form.get('id');
      requests.push({
        headers: req.headers,
        fileBytes: file instanceof File ? new Uint8Array(await file.arrayBuffer()) : null,
        id,
        notes: form.get('notes'),
        direction: form.get('direction'),
        kind: form.get('kind'),
      });
      return answer(typeof id === 'string' ? id : '');
    },
  });
  return { baseUrl: fake.url.origin, requests, aborted };
}

function ndjson(lines: readonly unknown[]): Response {
  return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  });
}

const succeed = (id: string): Response => ndjson([
  { type: 'status', phase: 'writing' },
  { type: 'status', phase: 'saving' },
  { type: 'result', id, name: CARD_NAME },
]);

function runtimeFor(fakeEphemera: Fake | null, extra: Record<string, string> = {}): ReturnType<typeof testRuntime> {
  return testRuntime({
    ...(fakeEphemera === null
      ? {}
      : {
          EPHEMERA_BASE_URL: fakeEphemera.baseUrl,
          EPHEMERA_INTEGRATION_KEY: KEY,
          EPHEMERA_ORIGIN: ORIGIN,
        }),
    EPHEMERA_USERS: USER,
    MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1',
    LOG_LEVEL: 'info',
    ...extra,
  });
}

async function seedTile(
  runtime: ReturnType<typeof testRuntime>,
  options: { userId?: string; status?: 'done' | 'loading'; video?: boolean; bytes?: Uint8Array | null } = {},
): Promise<string> {
  const userId = options.userId ?? USER;
  const now = Date.now();
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  const video = options.video === true;
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  runtime.db.query(
    'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(batchId, userId, PROMPT, '1:1', 'mock', 'Mock', now);
  runtime.db.query(
    'INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    tileId, batchId, userId, 0, 42, options.status ?? 'done',
    video ? 'mp4' : 'png', video ? 'video/mp4' : 'image/png', null, now,
  );
  if (options.bytes !== null) {
    const bytes = options.bytes ?? await grayCardPng();
    await writeAtomic(runtime.config.DATA_DIR, 'images', userId, tileId, video ? 'mp4' : 'png', bytes);
  }
  return tileId;
}

function postCard(
  runtime: ReturnType<typeof testRuntime>,
  tileId: string,
  userId = USER,
  signal?: AbortSignal,
  characterId: unknown = crypto.randomUUID(),
  direction?: unknown,
  kind?: unknown,
): Promise<Response> {
  return runtime.fetch(`/api/tiles/${tileId}/character-card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({
      characterId,
      ...(direction === undefined ? {} : { direction }),
      ...(kind === undefined ? {} : { kind }),
    }),
    ...(signal ? { signal } : {}),
  });
}

function probe(runtime: ReturnType<typeof testRuntime>, userId = USER): Promise<Response> {
  return runtime.fetch('/api/ephemera', { headers: { 'Remote-User': userId } });
}

async function frames(response: Response): Promise<{ event: string; data: unknown }[]> {
  return parseSseText(await response.text());
}

function poolSlotFree(): boolean {
  const slot = enhancePool.acquire(USER);
  if (!slot.ok) return false;
  slot.release();
  return true;
}

class AlwaysSealedKeyring extends StorageKeyring {
  override decryptFileBytes(): Promise<Uint8Array> {
    return Promise.reject(new StorageSealedError());
  }
}

async function sealedKeyring(): Promise<StorageKeyring> {
  return new StorageKeyring({
    rootRecipient: await identityToRecipient(await generateHybridIdentity()),
    store: new MemoryUserKeyStore(),
  });
}

describe('Ephemera routes', () => {
  test('both routes are 404 when EPHEMERA_BASE_URL is unset', async () => {
    const runtime = runtimeFor(null);
    const tileId = await seedTile(runtime);
    expect((await probe(runtime)).status).toBe(404);
    const response = await postCard(runtime, tileId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  });

  test('both routes are 404 for a user outside EPHEMERA_USERS', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime, { userId: 'mallory' });
    expect((await probe(runtime, 'mallory')).status).toBe(404);
    expect((await postCard(runtime, tileId, 'mallory')).status).toBe(404);
    expect(fakeEphemera.requests).toHaveLength(0);
  });

  test('the probe returns the origin and the card timeout for an allowed user', async () => {
    const runtime = runtimeFor(startFake(succeed), { EPHEMERA_CARD_TIMEOUT_MS: '480000' });
    const response = await probe(runtime);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ origin: ORIGIN, timeoutMs: 480_000 });
  });

  test('a body without a UUID characterId is 400 and Ephemera is never called', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    expect((await postCard(runtime, tileId, USER, undefined, 'not-a-uuid')).status).toBe(400);
    const empty = await runtime.fetch(`/api/tiles/${tileId}/character-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': USER },
      body: '{}',
    });
    expect(empty.status).toBe(400);
    expect(fakeEphemera.requests).toHaveLength(0);
  });

  test('the body characterId is the id Ephemera receives and the result carries', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    const characterId = crypto.randomUUID();
    const events = await frames(await postCard(runtime, tileId, USER, undefined, characterId));
    expect(fakeEphemera.requests.map((request) => request.id)).toEqual([characterId]);
    expect(events.at(-1)).toEqual({
      event: 'result',
      data: { characterId, name: CARD_NAME, url: `${ORIGIN}/characters/${characterId}` },
    });
  });

  test('the direction reaches Ephemera trimmed, and a blank one is not sent', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    const direction = 'a retired sea captain, gruff but kind';
    await (await postCard(runtime, tileId, USER, undefined, crypto.randomUUID(), `  ${direction}\n`)).text();
    await (await postCard(runtime, tileId, USER, undefined, crypto.randomUUID(), '   ')).text();
    await (await postCard(runtime, tileId)).text();
    expect(fakeEphemera.requests.map((request) => request.direction)).toEqual([direction, null, null]);
    expect(runtime.logs.join('\n')).not.toContain(direction);
  });

  test('an over-long or non-string direction is 400 and Ephemera is never called', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    const tooLong = 'x'.repeat(CHARACTER_CARD_DIRECTION_MAX_CHARS + 1);
    expect((await postCard(runtime, tileId, USER, undefined, crypto.randomUUID(), tooLong)).status).toBe(400);
    expect((await postCard(runtime, tileId, USER, undefined, crypto.randomUUID(), 42)).status).toBe(400);
    expect(fakeEphemera.requests).toHaveLength(0);
  });

  test('the chosen kind reaches Ephemera, and an absent one is sent as subject', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    await (await postCard(runtime, tileId, USER, undefined, crypto.randomUUID(), undefined, 'scenario')).text();
    await (await postCard(runtime, tileId, USER, undefined, crypto.randomUUID(), undefined, 'group')).text();
    await (await postCard(runtime, tileId)).text();
    expect(fakeEphemera.requests.map((request) => request.kind)).toEqual(['scenario', 'group', 'subject']);
  });

  test('an unknown or non-string kind is 400 and Ephemera is never called', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    expect((await postCard(runtime, tileId, USER, undefined, crypto.randomUUID(), undefined, 'party')).status).toBe(400);
    expect((await postCard(runtime, tileId, USER, undefined, crypto.randomUUID(), undefined, 1)).status).toBe(400);
    expect(fakeEphemera.requests).toHaveLength(0);
  });

  test('a foreign tile is 404', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera, { EPHEMERA_USERS: 'alice,bob' });
    const tileId = await seedTile(runtime, { userId: 'bob' });
    expect((await postCard(runtime, tileId)).status).toBe(404);
    expect(fakeEphemera.requests).toHaveLength(0);
  });

  test('a tile that is still loading is 404', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime, { status: 'loading' });
    expect((await postCard(runtime, tileId)).status).toBe(404);
    expect(fakeEphemera.requests).toHaveLength(0);
  });

  test('a done video tile is 404', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime, { video: true, bytes: new Uint8Array([0, 0, 0, 0x18]) });
    expect((await postCard(runtime, tileId)).status).toBe(404);
    expect(fakeEphemera.requests).toHaveLength(0);
  });

  test('Ephemera receives the artifact bytes, the batch prompt as notes, a UUID id and the caller', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const png = await grayCardPng(8);
    const tileId = await seedTile(runtime, { bytes: png });
    const response = await postCard(runtime, tileId);
    expect(response.status).toBe(200);
    await response.text();
    expect(fakeEphemera.requests).toHaveLength(1);
    const [request] = fakeEphemera.requests;
    if (!request) throw new Error('fake Ephemera was not called');
    expect(request.fileBytes).toEqual(png);
    expect(request.notes).toBe(PROMPT);
    expect(request.id).toMatch(UUID_PATTERN);
    expect(request.headers.get('remote-user')).toBe(USER);
    expect(request.headers.get('x-ephemera-proxy-key')).toBe(KEY);
    expect(request.headers.get('origin')).toBe(ORIGIN);
  });

  test('streams status frames then a result whose url sits under the origin', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    const response = await postCard(runtime, tileId);
    expect(response.headers.get('Content-Type')).toStartWith('text/event-stream');
    const events = await frames(response);
    const id = fakeEphemera.requests[0]?.id;
    expect(events).toEqual([
      { event: 'status', data: { phase: 'reading' } },
      { event: 'status', data: { phase: 'writing' } },
      { event: 'status', data: { phase: 'saving' } },
      { event: 'result', data: { characterId: id, name: CARD_NAME, url: `${ORIGIN}/characters/${String(id)}` } },
    ]);
    const logs = runtime.logs.join('\n');
    expect(logs).toContain('ephemera_card_saved');
    expect(logs).not.toContain(CARD_NAME);
    expect(logs).not.toContain(PROMPT);
  });

  test('a 403 from Ephemera ends as ephemera-forbidden', async () => {
    const runtime = runtimeFor(startFake(() => Response.json({ error: 'forbidden' }, { status: 403 })));
    const tileId = await seedTile(runtime);
    const events = await frames(await postCard(runtime, tileId));
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'ephemera-forbidden', message: 'Ephemera refused this request for your account.' },
    });
    expect(poolSlotFree()).toBe(true);
  });

  test('a saturated enhance pool answers 429 QUEUE_FULL before any outbound call', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    configureLlmAdmissionPools(runtime.config);
    const held = enhancePool.acquire(USER);
    if (!held.ok) throw new Error('expected a free enhance slot');
    try {
      const response = await postCard(runtime, tileId);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ code: 'QUEUE_FULL', retry_after_seconds: 10 });
      expect(fakeEphemera.requests).toHaveLength(0);
    } finally {
      held.release();
    }
  });

  test('a client disconnect aborts the outbound request and emits no terminal frame', async () => {
    const fakeEphemera = startFake(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'status', phase: 'writing' })}\n`));
      },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    const ac = new AbortController();
    const response = await postCard(runtime, tileId, USER, ac.signal);
    expect(response.status).toBe(200);
    for (let i = 0; i < 200 && fakeEphemera.requests.length === 0; i++) await Bun.sleep(10);
    expect(fakeEphemera.requests).toHaveLength(1);
    ac.abort(new Error('browser left'));
    const text = await response.text();
    for (let i = 0; i < 100 && !fakeEphemera.aborted.value; i++) await Bun.sleep(10);
    expect(fakeEphemera.aborted.value).toBe(true);
    const events = parseSseText(text).map((frame) => frame.event);
    expect(events).not.toContain('result');
    expect(events).not.toContain('error');
    expect(runtime.logs.join('\n')).not.toContain(CARD_NAME);
    expect(poolSlotFree()).toBe(true);
  });

  test('a sealed store ends as storage-sealed and Ephemera is never called', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    configureStorageKeyring(new AlwaysSealedKeyring({
      rootRecipient: await identityToRecipient(await generateHybridIdentity()),
      store: new MemoryUserKeyStore(),
    }));
    const events = await frames(await postCard(runtime, tileId));
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'storage-sealed', message: 'Atelier could not read this image right now. Try again.' },
    });
    expect(fakeEphemera.requests).toHaveLength(0);
  });

  test('a missing artifact ends as image-unavailable and Ephemera is never called', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime, { bytes: null });
    const events = await frames(await postCard(runtime, tileId));
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'image-unavailable', message: 'This image is no longer available.' },
    });
    expect(fakeEphemera.requests).toHaveLength(0);
    expect(runtime.logs.join('\n')).toContain('ArtifactMissing');
  });

  test('a sealed store past the deadline ends as timeout, not storage-sealed', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera, { EPHEMERA_CARD_TIMEOUT_MS: '100' });
    const tileId = await seedTile(runtime);
    configureStorageKeyring(await sealedKeyring());
    const events = await frames(await postCard(runtime, tileId));
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: {
        code: 'timeout',
        message: 'Writing the card took too long. It may already be saved; clicking again finds it instead of making a duplicate.',
      },
    });
    expect(fakeEphemera.requests).toHaveLength(0);
  });

  test('a tampered artifact ends as card-failed and the enhance slot is released', async () => {
    const fakeEphemera = startFake(succeed);
    const runtime = runtimeFor(fakeEphemera);
    const tileId = await seedTile(runtime);
    // Plaintext where ciphertext belongs: the keyring refuses it as an
    // integrity failure.
    await Bun.write(join(namedArtifactDir(runtime.config.DATA_DIR, 'images', USER), `${tileId}.png`), await grayCardPng());
    const events = await frames(await postCard(runtime, tileId));
    expect(events.at(-1)).toEqual({
      event: 'error',
      data: { code: 'card-failed', message: "Couldn't create the card. Please try again." },
    });
    expect(fakeEphemera.requests).toHaveLength(0);
    expect(runtime.logs.join('\n')).toContain('StorageIntegrityError');
    expect(poolSlotFree()).toBe(true);
  });

  test('MAX_PROMPT_CHARS fits Ephemera notes without truncation', () => {
    // Ephemera's CREATOR_LIMITS.descriptionLength (20,000) bounds `notes`;
    // the batch prompt is sent whole, so Atelier's cap must stay at or below it.
    expect(MAX_PROMPT_CHARS).toBeLessThanOrEqual(20_000);
  });
});
