import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateHybridIdentity, identityToRecipient } from 'age-encryption';
import sharp from 'sharp';
import { kickQueues } from '../orchestrator/dispatch';
import {
  DbUserKeyStore,
  StorageKeyring,
  configureStorageKeyring,
  createUnsealedKeyring,
} from '../storage/crypto';
import {
  DATA_VOLUME_MARKER,
  DataVolumeMarkerMissingError,
  assertDataVolumeMarker,
  startUnsealSocket,
} from '../storage/encryptionBoot';
import { writeAtomic } from '../storage/files';
import {
  VIDEO_CACHE_BUDGET_BYTES,
  acquireDecryptedVideo,
  resetDecryptedVideoCacheForTests,
  sweepDecryptedVideoCache,
  videoCacheBudgetForTests,
} from '../storage/decryptedVideoCache';
import { jsonRequest, rejectionOf, tempDir, testRuntime } from './helpers';

const PNG = new Uint8Array(
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c0392b' } }).png().toBuffer(),
);

async function root(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateHybridIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

function seedDoneTile(runtime: ReturnType<typeof testRuntime>, userId: string, tileId: string): void {
  const batchId = crypto.randomUUID();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 1)').run(userId);
  runtime.db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
     VALUES (?, ?, 'p', '1:1', 'mock-fast', 'Mock', 1, 'done', 'shared')`,
  ).run(batchId, userId);
  runtime.db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
     VALUES (?, ?, ?, 0, 1, 'done', 'png', 'image/png', 1)`,
  ).run(tileId, batchId, userId);
}

function seedDoneClip(runtime: ReturnType<typeof testRuntime>, userId: string, tileId: string): void {
  seedDoneTile(runtime, userId, tileId);
  runtime.db.query("UPDATE tiles SET ext = 'mp4', mime = 'video/mp4' WHERE id = ?").run(tileId);
}

function imageRequest(path: string, userId: string, signal?: AbortSignal): Request {
  return new Request(`http://local${path}`, {
    headers: { 'Remote-User': userId },
    ...(signal ? { signal } : {}),
  });
}

afterEach(() => {
  resetDecryptedVideoCacheForTests();
  configureStorageKeyring(null);
});

describe('encrypted artifact serving', () => {
  test('serves plaintext with its exact Content-Length while the file on disk is ciphertext', async () => {
    const runtime = testRuntime();
    configureStorageKeyring(await createUnsealedKeyring(new DbUserKeyStore(runtime.db)));
    const tileId = crypto.randomUUID();
    seedDoneTile(runtime, 'alice', tileId);
    const path = await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', tileId, 'png', PNG);

    const onDisk = new Uint8Array(await Bun.file(path).arrayBuffer());
    expect(new TextDecoder().decode(onDisk.subarray(0, 22))).toBe('age-encryption.org/v1\n');
    expect(Buffer.from(onDisk).indexOf(Buffer.from(PNG.subarray(0, 16)))).toBe(-1);

    const response = await runtime.app.fetch(imageRequest(`/api/img/${tileId}`, 'alice'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(PNG.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);

    // The lazily generated thumbnail is stored encrypted too.
    const thumb = await runtime.app.fetch(imageRequest(`/api/img/${tileId}/thumb`, 'alice'));
    expect(thumb.status).toBe(200);
    const thumbPath = join(runtime.config.DATA_DIR, 'thumbs', 'alice', `${tileId}.webp`);
    expect(await Bun.file(thumbPath).text().then((text) => text.startsWith('age-encryption.org/v1\n'))).toBe(true);
  });

  test('a tampered artifact aborts the body and logs artifact_decrypt_failed', async () => {
    const runtime = testRuntime({ LOG_LEVEL: 'error' });
    configureStorageKeyring(await createUnsealedKeyring(new DbUserKeyStore(runtime.db)));
    const tileId = crypto.randomUUID();
    seedDoneTile(runtime, 'alice', tileId);
    const big = new Uint8Array(300_000);
    big.set(PNG);
    const path = await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', tileId, 'png', big);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    bytes[bytes.length - 1000] = (bytes[bytes.length - 1000] ?? 0) ^ 0xff;
    writeFileSync(path, bytes);

    const response = await runtime.app.fetch(imageRequest(`/api/img/${tileId}`, 'alice'));
    expect(response.status).toBe(200);
    expect(await rejectionOf(response.arrayBuffer())).toBeInstanceOf(Error);
    expect(runtime.logs.some((line) => line.includes('artifact_decrypt_failed'))).toBe(true);
  });

  test('a sealed read answers 503 when its wait expires and serves after unseal', async () => {
    const runtime = testRuntime();
    const { identity, recipient } = await root();
    const store = new DbUserKeyStore(runtime.db);
    // Writer process: creates the user key and stores the artifact while sealed.
    configureStorageKeyring(new StorageKeyring({ rootRecipient: recipient, store }));
    const tileId = crypto.randomUUID();
    seedDoneTile(runtime, 'alice', tileId);
    await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', tileId, 'png', PNG);

    // Restarted process: same DB, nothing cached, still sealed.
    const restarted = new StorageKeyring({ rootRecipient: recipient, store });
    configureStorageKeyring(restarted);
    const sealed = await runtime.app.fetch(imageRequest(`/api/img/${tileId}`, 'alice', AbortSignal.timeout(50)));
    expect(sealed.status).toBe(503);
    expect(sealed.headers.get('Retry-After')).toBe('5');

    await restarted.unseal(identity);
    const served = await runtime.app.fetch(imageRequest(`/api/img/${tileId}`, 'alice'));
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  test('generation queues while storage is sealed and completes after unseal', async () => {
    const runtime = testRuntime();
    const { identity, recipient } = await root();
    const keyring = new StorageKeyring({ rootRecipient: recipient, store: new DbUserKeyStore(runtime.db) });
    configureStorageKeyring(keyring);

    const response = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'x',
      modelId: 'mock-fast',
      ratio: '1:1',
      count: 1,
    }, 'alice', 'application/json');
    expect(response.status).toBe(201);
    const payload = await response.json() as { batchId: string; status: string };
    expect(payload.status).toBe('queued');

    await keyring.unseal(identity);
    kickQueues({
      db: runtime.db,
      config: runtime.config,
      logger: runtime.logger,
      keyStore: runtime.keyStore,
      healthSnapshot: () => new Map(),
    });
    const deadline = Date.now() + 5_000;
    let status = '';
    while (Date.now() < deadline) {
      status = runtime.db.query<{ status: string }, [string]>('SELECT status FROM batches WHERE id = ?')
        .get(payload.batchId)?.status ?? '';
      if (status === 'done') break;
      await Bun.sleep(25);
    }
    expect(status).toBe('done');
    const tile = runtime.db.query<{ id: string; ext: string }, [string]>(
      "SELECT id, ext FROM tiles WHERE batch_id = ? AND status = 'done'",
    ).get(payload.batchId);
    if (!tile) throw new Error('expected a done tile');
    const stored = await Bun.file(join(runtime.config.DATA_DIR, 'images', 'alice', `${tile.id}.${tile.ext}`)).text();
    expect(stored.startsWith('age-encryption.org/v1\n')).toBe(true);
  });
});

describe('encrypted video playback', () => {
  test('answers Range requests with 206 slices of the plaintext and frees the temp copy when idle', async () => {
    const runtime = testRuntime();
    configureStorageKeyring(await createUnsealedKeyring(new DbUserKeyStore(runtime.db)));
    const tileId = crypto.randomUUID();
    seedDoneClip(runtime, 'alice', tileId);
    const clip = crypto.getRandomValues(new Uint8Array(250_000));
    await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', tileId, 'mp4', clip);

    // Exercise Range and leased-body completion through a real listener.
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: runtime.app.fetch });
    try {
      const url = `http://127.0.0.1:${server.port}/api/img/${tileId}`;
      const ranged = await fetch(url, { headers: { 'Remote-User': 'alice', Range: 'bytes=100000-100099' } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('Content-Range')).toBe(`bytes 100000-100099/${clip.length}`);
      expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(clip.subarray(100_000, 100_100));

      const whole = await fetch(url, { headers: { 'Remote-User': 'alice' } });
      expect(whole.status).toBe(200);
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(clip);
    } finally {
      await server.stop(true);
    }

    // The plaintext copy holds budget until it goes idle, then releases it.
    const cacheBudget = videoCacheBudgetForTests();
    expect(cacheBudget.tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(false);
    sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
    expect(cacheBudget.tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(true);
    cacheBudget.release(VIDEO_CACHE_BUDGET_BYTES);
  });
});

describe('playback copy versioning', () => {
  test('a re-stitched master (same id, new revision) serves the new bytes and drops the old copy', async () => {
    const runtime = testRuntime();
    configureStorageKeyring(await createUnsealedKeyring(new DbUserKeyStore(runtime.db)));
    const dataDir = runtime.config.DATA_DIR;
    const first = crypto.getRandomValues(new Uint8Array(70_000));
    const second = crypto.getRandomValues(new Uint8Array(90_000));
    await writeAtomic(dataDir, 'images', 'alice', 'seq-1', 'mp4', first);
    const v1 = await acquireDecryptedVideo(dataDir, 'alice', 'seq-1', 'mp4', '1');
    if (!v1) throw new Error('missing first lease');
    expect(new Uint8Array(await v1.file.arrayBuffer())).toEqual(first);
    v1.release();

    await writeAtomic(dataDir, 'images', 'alice', 'seq-1', 'mp4', second);
    const v2 = await acquireDecryptedVideo(dataDir, 'alice', 'seq-1', 'mp4', '2');
    if (!v2) throw new Error('missing second lease');
    expect(new Uint8Array(await v2.file.arrayBuffer())).toEqual(second);
    v2.release();
    expect(existsSync(v1.file.name ?? '')).toBe(false);
  });
});

describe('unseal socket', () => {
  test('reports status, rejects a wrong root, unseals, and verifies every artifact', async () => {
    const runtime = testRuntime();
    const { identity, recipient } = await root();
    const wrong = await root();
    const keyring = new StorageKeyring({ rootRecipient: recipient, store: new DbUserKeyStore(runtime.db) });
    configureStorageKeyring(keyring);
    const tileId = crypto.randomUUID();
    seedDoneTile(runtime, 'alice', tileId);
    await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', tileId, 'png', PNG);
    // A stray plaintext file is reported, never silently accepted.
    writeFileSync(join(runtime.config.DATA_DIR, 'images', 'alice', 'stray.png'), PNG);

    const socket = join(tempDir(), 'unseal.sock');
    const server = startUnsealSocket({
      path: socket,
      keyring,
      dataDir: runtime.config.DATA_DIR,
      db: runtime.db,
      logger: runtime.logger,
    });
    try {
      const call = (path: string, init: RequestInit = {}) => fetch(`http://localhost${path}`, { ...init, unix: socket });
      expect(await (await call('/status')).json()).toEqual({ sealed: true });
      expect((await call('/verify', { method: 'POST' })).status).toBe(409);

      const rejected = await call('/unseal', { method: 'POST', body: wrong.identity });
      expect(rejected.status).toBe(403);
      expect(await rejected.text()).not.toContain(wrong.identity);
      expect(keyring.sealed).toBe(true);

      expect(await (await call('/unseal', { method: 'POST', body: `${identity}\n` })).json()).toEqual({ result: 'unsealed' });
      expect(await (await call('/unseal', { method: 'POST', body: identity })).json()).toEqual({ result: 'already-unsealed' });

      const report = await (await call('/verify', { method: 'POST' })).json() as {
        summary: { files: number; failures: number; missing: number; userKeys: number; bytes: number };
        failures: { file: string; reason: string }[];
      };
      expect(report.summary).toMatchObject({ files: 2, failures: 1, missing: 0, userKeys: 1, bytes: PNG.length });
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0]).toMatchObject({ file: 'stray.png', reason: 'plaintext' });
    } finally {
      await server.stop(true);
    }
  });
});

describe('data volume marker', () => {
  test('production refuses a DATA_DIR without the marker and touches nothing', () => {
    const previous = process.env.NODE_ENV;
    const dataDir = tempDir();
    try {
      process.env.NODE_ENV = 'production';
      expect(() => { assertDataVolumeMarker(dataDir); }).toThrow(DataVolumeMarkerMissingError);
      expect(readdirSync(dataDir)).toEqual([]);
      writeFileSync(join(dataDir, DATA_VOLUME_MARKER), '');
      expect(() => { assertDataVolumeMarker(dataDir); }).not.toThrow();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
      else process.env.NODE_ENV = previous;
    }
    const devDir = join(tempDir(), 'fresh');
    mkdirSync(devDir);
    expect(() => { assertDataVolumeMarker(devDir); }).not.toThrow();
    expect(existsSync(join(devDir, DATA_VOLUME_MARKER))).toBe(false);
  });
});
