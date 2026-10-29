import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { writeAtomic } from '../storage/files';
import { setFfmpegRunnerForTests } from '../storage/posterFrame';
import { testRuntime } from '../test/helpers';

const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x6d, 0x70, 0x34, 0x32,
]);

async function onePixelPng(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 72, g: 96, b: 128 },
    },
  }).png().toBuffer();
  return new Uint8Array(buffer);
}

async function seedDoneVideoTile(runtime: ReturnType<typeof testRuntime>, userId: string): Promise<string> {
  const now = Date.now();
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  runtime.db.query(
    'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(batchId, userId, 'motion prompt', '16:9', 'minimax-h3-i2v', 'MiniMax H3 I2V', now);
  runtime.db.query(
    'INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(tileId, batchId, userId, 0, 42, 'done', 'mp4', 'video/mp4', null, now);
  await writeAtomic(runtime.config.DATA_DIR, 'images', userId, tileId, 'mp4', MP4_BYTES);
  return tileId;
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

afterEach(() => {
  setFfmpegRunnerForTests(null);
});

describe('video thumbnail route', () => {
  test('extracts a poster frame for a video tile thumbnail cache miss', async () => {
    const runtime = testRuntime();
    const tileId = await seedDoneVideoTile(runtime, 'alice');
    const png = await onePixelPng();
    const calls: Uint8Array[] = [];
    setFfmpegRunnerForTests((_args, input) => {
      calls.push(input);
      return Promise.resolve(png);
    });

    const thumb = await runtime.fetch(`/api/img/${tileId}/thumb`, {
      headers: { 'Remote-User': 'alice' },
    });

    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('Content-Type')).toBe('image/webp');
    expect(thumb.headers.get('Cache-Control')).toBe('private, no-store');
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    expect(isWebp(bytes)).toBe(true);
    expect(calls).toEqual([MP4_BYTES]);
    expect(existsSync(join(runtime.config.DATA_DIR, 'thumbs', 'alice', `${tileId}.webp`))).toBe(true);
  });

  test('serves and caches a neutral poster when poster extraction fails', async () => {
    const runtime = testRuntime();
    const tileId = await seedDoneVideoTile(runtime, 'alice');
    let attempts = 0;
    setFfmpegRunnerForTests(() => {
      attempts += 1;
      return Promise.reject(new Error('ffmpeg failed'));
    });

    const first = await runtime.fetch(`/api/img/${tileId}/thumb`, {
      headers: { 'Remote-User': 'alice' },
    });

    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Type')).toBe('image/webp');
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    expect(isWebp(firstBytes)).toBe(true);
    expect(attempts).toBe(1);
    expect(existsSync(join(runtime.config.DATA_DIR, 'thumbs', 'alice', `${tileId}.webp`))).toBe(true);

    const second = await runtime.fetch(`/api/img/${tileId}/thumb`, {
      headers: { 'Remote-User': 'alice' },
    });

    expect(second.status).toBe(200);
    expect(second.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Array.from(new Uint8Array(await second.arrayBuffer()))).toEqual(Array.from(firstBytes));
    expect(attempts).toBe(1);
  });

  test('video artifact reads always reach origin authorization', async () => {
    const runtime = testRuntime();
    const tileId = await seedDoneVideoTile(runtime, 'alice');
    for (const user of ['alice', 'bob']) {
      const response = await runtime.fetch(`/api/img/${tileId}`, { headers: { 'Remote-User': user } });
      expect(response.status).toBe(user === 'alice' ? 200 : 404);
      if (user === 'alice') expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await response.arrayBuffer();
    }
  });
});
