import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { generateEvents, testRuntime } from './helpers';
import { readArtifactBytes } from '../storage/files';
import { normalizeUpload } from '../storage/normalizeUpload';
import { releaseUploads } from '../storage/uploadStore';
import {
  MAX_CONCURRENT_UPLOADS_PER_USER,
  MAX_PENDING_UPLOADS_PER_USER,
  resetUploadsRuntimeForTests,
  withUploadSlot,
} from '../routes/uploads-runtime';

afterEach(() => {
  resetUploadsRuntimeForTests();
});

type Runtime = ReturnType<typeof testRuntime>;

interface UploadJson {
  id: string;
  mime: string;
  ext: string;
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: number;
}

async function decodablePng(width = 96, height = 64): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: '#c04020' } }).png().toBuffer();
  return new Uint8Array(buffer);
}

async function uploadPng(runtime: Runtime, userId = 'alice'): Promise<string> {
  const form = new FormData();
  form.set('file', new File([await decodablePng()], 'ref.png', { type: 'image/png' }));
  const res = await runtime.app.fetch(new Request('http://local/api/uploads', {
    method: 'POST', headers: { 'Remote-User': userId }, body: form,
  }));
  expect(res.status).toBe(201);
  return ((await res.json()) as UploadJson).id;
}

function get(runtime: Runtime, path: string, userId = 'alice'): Promise<Response> {
  return Promise.resolve(runtime.app.fetch(new Request(`http://local${path}`, { headers: { 'Remote-User': userId } })));
}

function post(runtime: Runtime, path: string, userId = 'alice', body?: string): Promise<Response> {
  return Promise.resolve(runtime.app.fetch(new Request(`http://local${path}`, {
    method: 'POST',
    headers: body === undefined
      ? { 'Remote-User': userId }
      : { 'Remote-User': userId, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  })));
}

function uploadThumbPath(runtime: Runtime, uploadId: string, userId = 'alice'): string {
  return join(runtime.config.DATA_DIR, 'thumbs', userId, `u-${uploadId}.webp`);
}

function expectWebp(bytes: Uint8Array): void {
  expect(Array.from(bytes.slice(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);
  expect(Array.from(bytes.slice(8, 12))).toEqual([0x57, 0x45, 0x42, 0x50]);
}

async function generatedTileId(runtime: Runtime, userId = 'alice'): Promise<string> {
  const events = await generateEvents(runtime.app, { prompt: 'x', modelId: 'mock-fast', ratio: '1:1', count: 1 }, userId);
  const tileId = (events.find((event) => event.event === 'tile')?.data as { tileId?: string } | undefined)?.tileId;
  if (!tileId) throw new Error('missing tileId');
  return tileId;
}

function seedTile(runtime: Runtime, options: { status: 'done' | 'loading'; ext: string | null; mime: string | null }): string {
  const now = Date.now();
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run('alice', now);
  runtime.db.query(
    'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(batchId, 'alice', 'prompt', '1:1', 'mock-fast', 'Mock Fast', now);
  runtime.db.query(
    'INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(tileId, batchId, 'alice', 0, 42, options.status, options.ext, options.mime, null, options.status === 'done' ? now : null);
  return tileId;
}

describe('GET /api/uploads/:uploadId/thumb', () => {
  test('serves the owner a cached, encrypted WebP thumbnail without caching authenticated bytes', async () => {
    const runtime = testRuntime();
    const uploadId = await uploadPng(runtime);

    const res = await get(runtime, `/api/uploads/${uploadId}/thumb`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const first = new Uint8Array(await res.arrayBuffer());
    expectWebp(first);

    // Stored encrypted under a key a tile id (a UUID) can never take.
    const path = uploadThumbPath(runtime, uploadId);
    expect(existsSync(path)).toBe(true);
    expectWebp((await readArtifactBytes(runtime.config.DATA_DIR, 'thumbs', 'alice', `u-${uploadId}`, 'webp', 'image/webp'))?.bytes ?? new Uint8Array());
    const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
    expect(Array.from(raw.slice(8, 12))).not.toEqual([0x57, 0x45, 0x42, 0x50]);

    const second = await get(runtime, `/api/uploads/${uploadId}/thumb`);
    expect(second.status).toBe(200);
    expect(Array.from(new Uint8Array(await second.arrayBuffer()))).toEqual(Array.from(first));
  });

  test('cross-user and unknown ids return the same leak-safe 404', async () => {
    const runtime = testRuntime();
    const uploadId = await uploadPng(runtime);
    for (const [path, user] of [
      [`/api/uploads/${uploadId}/thumb`, 'bob'],
      [`/api/uploads/${crypto.randomUUID()}/thumb`, 'alice'],
    ] as const) {
      const res = await get(runtime, path, user);
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBeNull();
    }
    expect(existsSync(uploadThumbPath(runtime, uploadId))).toBe(false);
    expect(existsSync(uploadThumbPath(runtime, uploadId, 'bob'))).toBe(false);
  });

  test('deleting an upload removes its thumbnail', async () => {
    const runtime = testRuntime();
    const uploadId = await uploadPng(runtime);
    expect((await get(runtime, `/api/uploads/${uploadId}/thumb`)).status).toBe(200);
    expect(existsSync(uploadThumbPath(runtime, uploadId))).toBe(true);

    const res = await runtime.app.fetch(new Request(`http://local/api/uploads/${uploadId}`, {
      method: 'DELETE', headers: { 'Remote-User': 'alice' },
    }));
    expect(res.status).toBe(204);
    expect(existsSync(uploadThumbPath(runtime, uploadId))).toBe(false);
  });

  test('releasing an upload removes its thumbnail', async () => {
    const runtime = testRuntime();
    const uploadId = await uploadPng(runtime);
    expect((await get(runtime, `/api/uploads/${uploadId}/thumb`)).status).toBe(200);
    expect(existsSync(uploadThumbPath(runtime, uploadId))).toBe(true);

    releaseUploads({
      db: runtime.db, dataDir: runtime.config.DATA_DIR, logger: runtime.logger, userId: 'alice', uploadIds: [uploadId],
    });

    expect(runtime.db.query('SELECT 1 FROM uploads WHERE id = ?').get(uploadId)).toBeNull();
    expect(existsSync(uploadThumbPath(runtime, uploadId))).toBe(false);
  });
});

describe('POST /api/tiles/:tileId/source-upload', () => {
  test('copies an image tile into a new upload server-side, normalized like a browser upload', async () => {
    const runtime = testRuntime();
    const tileId = await generatedTileId(runtime);

    const res = await post(runtime, `/api/tiles/${tileId}/source-upload`);
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadJson;
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'ext', 'height', 'id', 'mime', 'sizeBytes', 'width']);

    const original = await readArtifactBytes(runtime.config.DATA_DIR, 'images', 'alice', tileId, 'png', 'image/png');
    if (!original) throw new Error('tile artifact missing');
    const normalized = await normalizeUpload(original.bytes, new AbortController().signal);
    expect(body).toMatchObject({
      mime: normalized.sniffed.mime,
      ext: normalized.sniffed.ext,
      width: normalized.sniffed.width,
      height: normalized.sniffed.height,
      sizeBytes: normalized.bytes.byteLength,
    });

    const row = runtime.db
      .query<{ user_id: string; sha256: string; source_tile_id: string | null }, [string]>(
        'SELECT user_id, sha256, source_tile_id FROM uploads WHERE id = ?',
      )
      .get(body.id);
    expect(row?.user_id).toBe('alice');
    expect(row?.sha256).toBe(new Bun.CryptoHasher('sha256').update(normalized.bytes).digest('hex'));
    // Provenance stays reserved for video-extension predecessors.
    expect(row?.source_tile_id).toBeNull();

    const stored = await get(runtime, `/api/uploads/${body.id}`);
    expect(stored.status).toBe(200);
    expect(Array.from(new Uint8Array(await stored.arrayBuffer()))).toEqual(Array.from(normalized.bytes));
  });

  test('unknown, cross-user, unfinished and video tiles return a leak-safe 404', async () => {
    const runtime = testRuntime();
    const tileId = await generatedTileId(runtime);
    const loading = seedTile(runtime, { status: 'loading', ext: null, mime: null });
    const video = seedTile(runtime, { status: 'done', ext: 'mp4', mime: 'video/mp4' });
    for (const [id, user] of [
      [crypto.randomUUID(), 'alice'],
      [tileId, 'bob'],
      [loading, 'alice'],
      [video, 'alice'],
    ] as const) {
      const res = await post(runtime, `/api/tiles/${id}/source-upload`, user);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
    }
    const count = runtime.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM uploads').get()?.count;
    expect(count).toBe(0);
  });

  test('rejects a request that carries a body', async () => {
    const runtime = testRuntime();
    const tileId = await generatedTileId(runtime);
    const res = await post(runtime, `/api/tiles/${tileId}/source-upload`, 'alice', '{}');
    expect(res.status).toBe(400);
    const count = runtime.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM uploads').get()?.count;
    expect(count).toBe(0);
  });

  test('answers 503 with Retry-After when the upload queue is full', async () => {
    const runtime = testRuntime();
    const tileId = await generatedTileId(runtime);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = Array.from(
      { length: MAX_CONCURRENT_UPLOADS_PER_USER + MAX_PENDING_UPLOADS_PER_USER },
      () => withUploadSlot('alice', () => gate),
    );
    try {
      const res = await post(runtime, `/api/tiles/${tileId}/source-upload`);
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
    } finally {
      release();
      await Promise.all(held);
    }
  });
});
