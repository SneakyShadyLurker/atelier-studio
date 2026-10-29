import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setStorageOpsForTests } from '../storage/files';
import { generateEvents, testRuntime } from './helpers';

async function generatedTileId(app: ReturnType<typeof testRuntime>['app'], userId: string): Promise<string> {
  const events = await generateEvents(app, { prompt: 'x', modelId: 'mock-fast', ratio: '1:1', count: 1 }, userId);
  const tileId = (events.find((event) => event.event === 'tile')?.data as { tileId?: string } | undefined)?.tileId;
  if (!tileId) throw new Error('missing tileId');
  return tileId;
}

function seedDoneTileWithoutArtifact(db: ReturnType<typeof testRuntime>['db'], userId: string): string {
  const now = Date.now();
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  db.query(
    'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(batchId, userId, 'prompt', '1:1', 'mock-fast', 'Mock Fast', now);
  db.query(
    'INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(tileId, batchId, userId, 0, 42, 'done', 'png', 'image/png', null, now);
  return tileId;
}

function seedLoadingTile(db: ReturnType<typeof testRuntime>['db'], userId: string): string {
  const now = Date.now();
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  db.query(
    'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(batchId, userId, 'prompt', '1:1', 'mock-fast', 'Mock Fast', now);
  db.query(
    'INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(tileId, batchId, userId, 0, 42, 'loading', null, null, null, null);
  return tileId;
}

afterEach(() => {
  setStorageOpsForTests(null);
});

describe('auth middleware', () => {
  test('missing Remote-User returns 401 before route work', async () => {
    const { app, db } = testRuntime();
    const res = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'x', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(res.status).toBe(401);
    const batches = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM batches').get();
    expect(batches?.count).toBe(0);
  });

  test('cross-user image access returns 404', async () => {
    const { app } = testRuntime();
    const tileId = await generatedTileId(app, 'alice');
    const img = await app.fetch(new Request(`http://local/api/img/${tileId}`, { headers: { 'Remote-User': 'bob' } }));
    expect(img.status).toBe(404);
    expect(img.headers.get('Cache-Control')).toBeNull();
  });

  test('cross-user thumb access returns 404', async () => {
    const { app } = testRuntime();
    const tileId = await generatedTileId(app, 'alice');
    const img = await app.fetch(new Request(`http://local/api/img/${tileId}/thumb`, { headers: { 'Remote-User': 'bob' } }));
    expect(img.status).toBe(404);
    expect(img.headers.get('Cache-Control')).toBeNull();
  });
});

describe('image route', () => {
  test('serves done tile artifacts without caching authenticated bytes', async () => {
    const { app } = testRuntime();
    const tileId = await generatedTileId(app, 'alice');
    const img = await app.fetch(new Request(`http://local/api/img/${tileId}`, { headers: { 'Remote-User': 'alice' } }));
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/png');
    expect(img.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test('unknown tile 404 omits cache header', async () => {
    const { app } = testRuntime();
    const img = await app.fetch(new Request(`http://local/api/img/${crypto.randomUUID()}`, { headers: { 'Remote-User': 'alice' } }));
    expect(img.status).toBe(404);
    expect(img.headers.get('Cache-Control')).toBeNull();
  });

  test('non-done tile 404 omits cache header', async () => {
    const { app, db } = testRuntime();
    const tileId = seedLoadingTile(db, 'alice');
    const img = await app.fetch(new Request(`http://local/api/img/${tileId}`, { headers: { 'Remote-User': 'alice' } }));
    expect(img.status).toBe(404);
    expect(img.headers.get('Cache-Control')).toBeNull();
  });
});

describe('thumb image route', () => {
  test('serves done tile thumbnails with WebP without caching authenticated bytes', async () => {
    const { app } = testRuntime();
    const tileId = await generatedTileId(app, 'alice');
    const thumb = await app.fetch(new Request(`http://local/api/img/${tileId}/thumb`, { headers: { 'Remote-User': 'alice' } }));
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('Content-Type')).toBe('image/webp');
    expect(thumb.headers.get('Cache-Control')).toBe('private, no-store');
    const bytes = new Uint8Array(await thumb.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);
    expect(Array.from(bytes.slice(8, 12))).toEqual([0x57, 0x45, 0x42, 0x50]);
  });

  test('serves an existing cached thumbnail without the source artifact', async () => {
    const { app, config } = testRuntime();
    const tileId = await generatedTileId(app, 'alice');
    const first = await app.fetch(new Request(`http://local/api/img/${tileId}/thumb`, { headers: { 'Remote-User': 'alice' } }));
    expect(first.status).toBe(200);
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    const thumbPath = join(config.DATA_DIR, 'thumbs', 'alice', `${tileId}.webp`);
    expect(existsSync(thumbPath)).toBe(true);
    unlinkSync(join(config.DATA_DIR, 'images', 'alice', `${tileId}.png`));

    const second = await app.fetch(new Request(`http://local/api/img/${tileId}/thumb`, { headers: { 'Remote-User': 'alice' } }));

    expect(second.status).toBe(200);
    expect(second.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Array.from(new Uint8Array(await second.arrayBuffer()))).toEqual(Array.from(firstBytes));
  });

  test('unknown tile 404 omits cache header', async () => {
    const { app } = testRuntime();
    const img = await app.fetch(new Request(`http://local/api/img/${crypto.randomUUID()}/thumb`, { headers: { 'Remote-User': 'alice' } }));
    expect(img.status).toBe(404);
    expect(img.headers.get('Cache-Control')).toBeNull();
  });

  test('done row with missing source artifact returns 500 without cache header', async () => {
    const { app, db } = testRuntime();
    const tileId = seedDoneTileWithoutArtifact(db, 'alice');
    const img = await app.fetch(new Request(`http://local/api/img/${tileId}/thumb`, { headers: { 'Remote-User': 'alice' } }));
    expect(img.status).toBe(500);
    expect(img.headers.get('Cache-Control')).toBeNull();
  });

  test('deletes a just-written thumb if the tile is permanently deleted before the ownership recheck', async () => {
    const { app, config, db } = testRuntime();
    const tileId = await generatedTileId(app, 'alice');
    const thumbUserDir = join(config.DATA_DIR, 'thumbs', 'alice');
    const fdPaths = new Map<number, string>();
    let sawFinalThumbDirClose = false;

    setStorageOpsForTests({
      openSync: (path, flags, mode) => {
        const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
        fdPaths.set(fd, String(path));
        return fd;
      },
      closeSync: (fd) => {
        const path = fdPaths.get(fd);
        closeSync(fd);
        if (path === thumbUserDir && !sawFinalThumbDirClose) {
          sawFinalThumbDirClose = true;
          db.query('DELETE FROM tiles WHERE id = ? AND user_id = ?').run(tileId, 'alice');
        }
      },
    });

    const thumb = await app.fetch(new Request(`http://local/api/img/${tileId}/thumb`, { headers: { 'Remote-User': 'alice' } }));

    expect(sawFinalThumbDirClose).toBe(true);
    expect(thumb.status).toBe(404);
    expect(thumb.headers.get('Cache-Control')).toBeNull();
    expect(existsSync(join(config.DATA_DIR, 'thumbs', 'alice', `${tileId}.webp`))).toBe(false);
  });
});

test('ordinary browser media requests reauthorize after an account switch even with conditional headers', async () => {
  const { app } = testRuntime();
  const tileId = await generatedTileId(app, 'alice');
  for (const path of [`/api/img/${tileId}`, `/api/img/${tileId}/thumb`]) {
    const first = await app.fetch(new Request(`http://local${path}`, { headers: { 'Remote-User': 'alice' } }));
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('private, no-store');
    await first.arrayBuffer();
    for (const user of ['alice', 'bob']) {
      const response = await app.fetch(new Request(`http://local${path}`, {
        headers: { 'Remote-User': user, 'If-None-Match': '*', 'If-Modified-Since': 'Wed, 21 Oct 2099 07:28:00 GMT' },
      }));
      expect(response.status).toBe(user === 'alice' ? 200 : 404);
      if (user === 'alice') expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await response.arrayBuffer();
    }
  }
});
