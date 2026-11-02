import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { testRuntime } from './helpers';
import { animatedWebpBytes, pngBytes, progressiveJpegBytes } from './image-fixtures';
import { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_REQUEST_BYTES } from '../routes/uploads';
import { MAX_UPLOAD_INPUT_BYTES } from '@atelier/shared';
import { setStorageOpsForTests } from '../storage/files';
import { setHeicDecoderForTests } from '../storage/heicDecode';
import type { AppDeps } from '../server';
import { createApp } from '../server';

interface UploadResponse {
  id: string;
  mime: string;
  ext: string;
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: number;
}

afterEach(() => {
  setStorageOpsForTests(null);
  setHeicDecoderForTests(null);
});

function uploadRequest(bytes: Uint8Array, options: { userId?: string; type?: string; name?: string } = {}): Request {
  const form = new FormData();
  form.set('file', new File([bytes], options.name ?? 'ref.png', { type: options.type ?? 'image/png' }));
  return new Request('http://local/api/uploads', {
    method: 'POST',
    headers: { 'Remote-User': options.userId ?? 'alice' },
    body: form,
  });
}

async function upload(app: ReturnType<typeof createApp>, bytes: Uint8Array, options: { userId?: string; type?: string; name?: string } = {}) {
  return app.fetch(uploadRequest(bytes, options));
}

async function uploadJson(app: ReturnType<typeof createApp>, bytes: Uint8Array, options: { userId?: string; type?: string; name?: string } = {}) {
  const res = await upload(app, bytes, options);
  return { res, body: await res.json() as UploadResponse | { error: string } };
}

function countUploads(deps: AppDeps, userId = 'alice'): number {
  return deps.db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM uploads WHERE user_id = ?').get(userId)?.count ?? 0;
}

function seedUploads(deps: AppDeps, count: number, sizeBytes = 1024): void {
  // Quota admission depends on existing rows, not their artifacts. Keep the
  // boundary-crossing requests real without encrypting/fsyncing the setup.
  const now = Date.now();
  deps.db.transaction(() => {
    deps.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run('alice', now);
    const insert = deps.db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, 'alice', 'png', 'image/png', ?, 64, 64, ?, ?)",
    );
    for (let index = 0; index < count; index += 1) {
      const id = crypto.randomUUID();
      insert.run(id, sizeBytes, `sha-${id}`, now);
    }
  })();
}

function seedReferencedTile(deps: AppDeps, uploadId: string, userId = 'alice'): void {
  const now = Date.now();
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  deps.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  deps.db
    .query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
  deps.db
    .query("INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, 0, 0, 'done', 'png', 'image/png', ?)")
    .run(tileId, batchId, userId, now);
  deps.db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, 0)').run(tileId, uploadId);
}

function seedI2vSourceBatch(deps: AppDeps, uploadId: string, userId = 'alice'): void {
  const now = Date.now();
  deps.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  deps.db
    .query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, i2v_source_upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), userId, 'p', '16:9', 'minimax-h3-i2v', 'MiniMax H3 I2V', now, uploadId);
}

describe('/api/uploads', () => {
  test('POST, GET, and idempotent DELETE round trip a 64x64 PNG', async () => {
    const runtime = testRuntime();
    const bytes = pngBytes(64, 64);
    const { res, body } = await uploadJson(runtime.app, bytes);

    expect(res.status).toBe(201);
    expect(body).toMatchObject({ mime: 'image/png', ext: 'png', sizeBytes: bytes.byteLength, width: 64, height: 64 });
    const uploadId = (body as UploadResponse).id;

    const get = await runtime.app.fetch(new Request(`http://local/api/uploads/${uploadId}`, { headers: { 'Remote-User': 'alice' } }));
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/png');
    expect(get.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Array.from(new Uint8Array(await get.arrayBuffer()))).toEqual(Array.from(bytes));
    const switched = await runtime.app.fetch(new Request(`http://local/api/uploads/${uploadId}`, {
      headers: { 'Remote-User': 'bob', 'If-None-Match': '*' },
    }));
    expect(switched.status).toBe(404);

    expect((await runtime.app.fetch(new Request(`http://local/api/uploads/${uploadId}`, { method: 'DELETE', headers: { 'Remote-User': 'alice' } }))).status).toBe(204);
    expect((await runtime.app.fetch(new Request(`http://local/api/uploads/${uploadId}`, { method: 'DELETE', headers: { 'Remote-User': 'alice' } }))).status).toBe(204);
  });

  test('accepts valid bytes regardless of the declared Content-Type', async () => {
    const { app } = testRuntime();
    const { res, body } = await uploadJson(app, pngBytes(), { type: 'image/jpeg', name: 'ref.jpg' });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ mime: 'image/png', ext: 'png' });
  });

  test('rejects an undecodable animated WebP fixture', async () => {
    // The synthetic animatedWebpBytes() fixture is not a fully decodable WebP
    // (it has only a VP8X header with the animation flag set, no frame data),
    // so Sharp rejects it with UnsupportedImageError → 400. A real animated
    // WebP would have its first frame extracted instead.
    const { app } = testRuntime();
    const res = await upload(app, animatedWebpBytes(), { type: 'image/webp', name: 'ref.webp' });
    expect(res.status).toBe(400);
  });

  test('rejects files larger than the 50 MB input ceiling', async () => {
    const { app } = testRuntime();
    const res = await upload(app, pngBytes(64, 64, MAX_UPLOAD_INPUT_BYTES + 1));
    expect(res.status).toBe(400);
  });

  test('Bun.serve rejects request bodies over the envelope cap before app.fetch runs', async () => {
    const runtime = testRuntime();
    let didFetch = false;
    const app = createApp(runtime);
    const server = Bun.serve({
      port: 0,
      maxRequestBodySize: MAX_UPLOAD_REQUEST_BYTES,
      fetch: (req) => {
        didFetch = true;
        return app.fetch(req);
      },
    });
    try {
      // Bun rejects an oversized Content-Length from the headers. Send only
      // those headers so its early response cannot race a large fetch body
      // write (and no giant image fixture needs to be allocated).
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(`http://127.0.0.1:${server.port}/api/uploads`, {
          method: 'POST',
          agent: false,
          headers: {
            'Remote-User': 'alice',
            'Content-Type': 'multipart/form-data; boundary=oversized',
            'Content-Length': MAX_UPLOAD_REQUEST_BYTES + 1,
          },
        }, (res) => {
          res.on('error', reject);
          res.on('end', () => { resolve(res.statusCode); });
          res.resume();
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(413);
      expect(didFetch).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test('accepts uploads beyond the former 20-upload count limit', async () => {
    const runtime = testRuntime();
    seedUploads(runtime, 20);
    const res = await upload(runtime.app, pngBytes(64, 64, 1024), { name: 'ref-21.png' });
    expect(res.status).toBe(201);
    expect(countUploads(runtime)).toBe(21);
  });

  test('accepts uploads beyond the former 400 MB accumulated-byte limit', async () => {
    const runtime = testRuntime();
    seedUploads(runtime, 16, MAX_UPLOAD_FILE_BYTES);
    const res = await upload(runtime.app, pngBytes(64, 64, 1024), { name: 'over-cap.png' });
    expect(res.status).toBe(201);
    expect(countUploads(runtime)).toBe(17);
    expect(runtime.db.query<{ bytes: number }, []>('SELECT SUM(size_bytes) AS bytes FROM uploads').get()?.bytes).toBeGreaterThan(400 * 1024 * 1024);
  });

  test('parallel uploads both succeed across the former count limit', async () => {
    const runtime = testRuntime();
    seedUploads(runtime, 19);
    const [a, b] = await Promise.all([
      upload(runtime.app, pngBytes(64, 64, 1024), { name: 'race-a.png' }),
      upload(runtime.app, pngBytes(64, 64, 1024), { name: 'race-b.png' }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(countUploads(runtime)).toBe(21);
  });

  test('cross-user GET returns 404 without leaking existence', async () => {
    const runtime = testRuntime();
    const { body } = await uploadJson(runtime.app, pngBytes(), { userId: 'alice' });
    const res = await runtime.app.fetch(new Request(`http://local/api/uploads/${(body as UploadResponse).id}`, { headers: { 'Remote-User': 'bob' } }));
    expect(res.status).toBe(404);
  });

  test('cross-user DELETE is idempotent and does not delete the owner row', async () => {
    const runtime = testRuntime();
    const { body } = await uploadJson(runtime.app, pngBytes(), { userId: 'alice' });
    const uploadId = (body as UploadResponse).id;
    const res = await runtime.app.fetch(new Request(`http://local/api/uploads/${uploadId}`, { method: 'DELETE', headers: { 'Remote-User': 'bob' } }));
    expect(res.status).toBe(204);
    expect(countUploads(runtime, 'alice')).toBe(1);
  });

  test('referenced uploads cannot be deleted until the reference is removed', async () => {
    const runtime = testRuntime();
    const { body } = await uploadJson(runtime.app, pngBytes(), { userId: 'alice' });
    const uploadId = (body as UploadResponse).id;
    seedReferencedTile(runtime, uploadId);

    const blocked = await runtime.app.fetch(new Request(`http://local/api/uploads/${uploadId}`, { method: 'DELETE', headers: { 'Remote-User': 'alice' } }));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: 'upload still referenced' });

    runtime.db.query('DELETE FROM tile_ref_images WHERE upload_id = ?').run(uploadId);
    const deleted = await runtime.app.fetch(new Request(`http://local/api/uploads/${uploadId}`, { method: 'DELETE', headers: { 'Remote-User': 'alice' } }));
    expect(deleted.status).toBe(204);
  });

  test('i2v source uploads cannot be deleted while a batch references them', async () => {
    const runtime = testRuntime();
    const { body } = await uploadJson(runtime.app, pngBytes(), { userId: 'alice' });
    const uploadId = (body as UploadResponse).id;
    seedI2vSourceBatch(runtime, uploadId);

    const blocked = await runtime.app.fetch(new Request(`http://local/api/uploads/${uploadId}`, { method: 'DELETE', headers: { 'Remote-User': 'alice' } }));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: 'upload still referenced' });
  });

  test('file write failure rolls back the committed upload row', async () => {
    const runtime = testRuntime();
    setStorageOpsForTests({
      renameSync: () => {
        throw new Error('disk full');
      },
    });
    const res = await upload(runtime.app, pngBytes());
    expect(res.status).toBe(500);
    expect(countUploads(runtime)).toBe(0);
  });

  test('stores ext and mime from the sniffer, not the filename', async () => {
    const runtime = testRuntime();
    const bytes = progressiveJpegBytes();
    const { res, body } = await uploadJson(runtime.app, bytes, { type: 'image/jpeg', name: 'looks-like.bin' });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ ext: 'jpg', mime: 'image/jpeg' });
    const path = join(runtime.config.DATA_DIR, 'uploads', 'alice', `${(body as UploadResponse).id}.jpg`);
    expect(existsSync(path)).toBe(true);
  });

  test('accepts a HEIC upload and stores a supported artifact', async () => {
    const { app } = testRuntime();
    // Real 1×1 transparent PNG produced by sharp — valid CRCs so normalizeUpload's
    // post-decode sharp pipeline can read and re-encode it. The synthetic pngBytes()
    // fixture has zeroed CRCs that sharp rejects, so we use literal bytes here.
    const validOnePx = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,9,112,72,89,115,0,0,3,232,0,0,3,232,1,181,123,82,107,0,0,0,13,73,68,65,84,120,156,99,96,96,96,96,0,0,0,5,0,1,165,246,69,64,0,0,0,0,73,69,78,68,174,66,96,130]);
    setHeicDecoderForTests(() => Promise.resolve(validOnePx));
    const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
    const { res, body } = await uploadJson(app, heic, { type: '', name: 'IMG.HEIC' });
    expect(res.status).toBe(201);
    expect(['image/png', 'image/jpeg', 'image/webp']).toContain((body as { mime: string }).mime);
  });
});
