import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { RegistryEntry } from '../providers/registry';
import type { Provider } from '../providers/types';
import { createBatch } from '../orchestrator/createBatch';
import { loadRefImages } from '../orchestrator/refImages';
import { writeAtomic } from '../storage/files';
import { createGenerationStream } from './streamHarness';
import { parseSseText, testRuntime } from './helpers';
import { pngBytes, progressiveJpegBytes } from './image-fixtures';

const pngFixture = pngBytes();
const jpegFixture = progressiveJpegBytes();

function seedUploadRow(
  db: Database,
  userId: string,
  uploadId: string,
  ext: 'png' | 'jpg',
  mime: 'image/png' | 'image/jpeg',
  sizeBytes: number,
): void {
  const now = Date.now();
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  db.query(
    'INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, ?, ?, ?, 64, 64, ?, ?)',
  ).run(uploadId, userId, ext, mime, sizeBytes, `sha-${uploadId}`, now);
}

const mockRefProvider: Provider = {
  id: 'mock-ref',
  backend: 'cloud',
  async *generate(req) {
    await Promise.resolve();
    yield {
      status: 'ready',
      bytes: pngFixture,
      ext: 'png',
      mime: 'image/png',
      seed: req.seed,
      index: 0,
    };
  },
};

function registryEntry(): RegistryEntry {
  return {
    model: {
      id: 'mock-ref',
      name: 'Mock Ref',
      backend: 'cloud',
      tag: 'test',
      latency: 'instant',
      supportedRatios: ['1:1'],
      supportsReferenceImages: true,
      pool: 'shared',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
    },
    bind: () => mockRefProvider,
    timeoutMs: () => 10_000,
  };
}

describe('orchestrator reference images', () => {
  test('createBatch writes tile_ref_images rows in input order for every tile', () => {
    const { db } = testRuntime();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    seedUploadRow(db, 'alice', first, 'png', 'image/png', 1);
    seedUploadRow(db, 'alice', second, 'png', 'image/png', 1);

    const prepared = createBatch(db, 'alice', {
      prompt: 'x',
      modelId: 'mock-ref',
      ratio: '1:1',
      count: 2,
      refImageIds: [second, first],
    }, registryEntry());

    const rows = db
      .query<{ tile_id: string; upload_id: string; position: number }, []>(
        'SELECT tile_id, upload_id, position FROM tile_ref_images ORDER BY tile_id, position',
      )
      .all();
    expect(rows).toHaveLength(4);
    for (const tile of prepared.tiles) {
      expect(rows.filter((row) => row.tile_id === tile.id)).toEqual([
        { tile_id: tile.id, upload_id: second, position: 0 },
        { tile_id: tile.id, upload_id: first, position: 1 },
      ]);
    }
  });

  test('loadRefImages validates ownership and preserves input order', async () => {
    const { db, config } = testRuntime();
    const pngId = crypto.randomUUID();
    const jpegId = crypto.randomUUID();
    const bobId = crypto.randomUUID();
    seedUploadRow(db, 'alice', pngId, 'png', 'image/png', pngFixture.byteLength);
    seedUploadRow(db, 'alice', jpegId, 'jpg', 'image/jpeg', jpegFixture.byteLength);
    seedUploadRow(db, 'bob', bobId, 'png', 'image/png', pngFixture.byteLength);
    await writeAtomic(config.DATA_DIR, 'uploads', 'alice', pngId, 'png', pngFixture);
    await writeAtomic(config.DATA_DIR, 'uploads', 'alice', jpegId, 'jpg', jpegFixture);
    await writeAtomic(config.DATA_DIR, 'uploads', 'bob', bobId, 'png', pngFixture);

    const loaded = await loadRefImages(db, config.DATA_DIR, 'alice', [jpegId, pngId]);
    expect(loaded?.map((image) => image.mime)).toEqual(['image/jpeg', 'image/png']);
    expect(Array.from(loaded?.[0]?.bytes ?? [])).toEqual(Array.from(jpegFixture));
    expect(await loadRefImages(db, config.DATA_DIR, 'alice', [crypto.randomUUID()])).toBeNull();
    expect(await loadRefImages(db, config.DATA_DIR, 'alice', [bobId])).toBeNull();
    expect(await loadRefImages(db, config.DATA_DIR, 'alice', [])).toBeNull();
  });

  test('batch replay carries refImageIds', async () => {
    const runtime = testRuntime();
    const { db, config, logger } = runtime;
    const fetch: typeof runtime.fetch = (...args) => runtime.fetch(...args);
    const uploadId = crypto.randomUUID();
    seedUploadRow(db, 'alice', uploadId, 'png', 'image/png', pngFixture.byteLength);

    const disconnect = new AbortController();
    let settled = 0;
    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'alice',
      request: {
        prompt: 'x',
        modelId: 'mock-ref',
        ratio: '1:1',
        count: 1,
        refImageIds: [uploadId],
        refImages: [{ bytes: pngFixture, mime: 'image/png' }],
      },
      registryEntry: registryEntry(),
      boundProvider: mockRefProvider,
      disconnectSignal: disconnect.signal,
      onTileSettled: () => { settled += 1; },
      onSyncFailure: () => { settled = -1; },
    });

    await new Response(stream).text();
    const batch = db.query<{ id: string }, []>('SELECT id FROM batches ORDER BY created_at DESC LIMIT 1').get();
    if (!batch) throw new Error('expected batch row');
    const replay = await fetch(`/api/batches/${batch.id}/events`, {
      headers: { 'Remote-User': 'alice' },
    });
    const events = parseSseText(await replay.text());

    expect(events[0]?.event).toBe('batch');
    expect(events[0]?.data).toMatchObject({ refImageIds: [uploadId] });
    expect(settled).toBe(1);
  });
});
