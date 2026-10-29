import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchivePage, TileErrorCategory, TileExt, TileMime } from '@atelier/shared';
import { testRuntime } from './helpers';

interface SeedTileOptions {
  userId?: string;
  archivedAt?: number | null;
  batchArchivedAt?: number | null;
  status?: 'done' | 'failed' | 'loading';
  ratio?: '1:1' | '4:5';
  ext?: TileExt | null;
  mime?: TileMime | null;
  error?: TileErrorCategory | null;
  tileId?: string;
  batchId?: string;
  collectionId?: string | null;
  pinned?: boolean;
  refImageIds?: readonly string[];
}

function seedTile(
  db: ReturnType<typeof testRuntime>['db'],
  dataDir: string,
  options: SeedTileOptions = {},
): { batchId: string; tileId: string; file: string | null } {
  const now = Date.now();
  const userId = options.userId ?? 'test';
  const batchId = options.batchId ?? crypto.randomUUID();
  const tileId = options.tileId ?? crypto.randomUUID();
  const status = options.status ?? 'done';
  const archivedAt = options.archivedAt === undefined ? now : options.archivedAt;
  const batchArchivedAt = options.batchArchivedAt === undefined ? null : options.batchArchivedAt;
  const ext = options.ext === undefined ? (status === 'done' ? 'png' : null) : options.ext;
  const mime = options.mime === undefined ? (status === 'done' ? 'image/png' : null) : options.mime;
  const error = options.error === undefined ? (status === 'failed' ? 'internal error' : null) : options.error;
  const completedAt = status === 'loading' ? null : now;
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  db.query(
    `INSERT INTO batches
       (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at, collection_id, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .run(
      batchId,
      userId,
      'prompt',
      options.ratio ?? '1:1',
      'mock-fast',
      'Mock Fast',
      now,
      batchArchivedAt,
      options.collectionId ?? null,
      options.pinned === true ? 1 : 0,
    );
  db.query(
    'INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .run(tileId, batchId, userId, 0, 42, status, ext, mime, error, completedAt, archivedAt);
  for (const [position, uploadId] of (options.refImageIds ?? []).entries()) {
    db.query(
      'INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .run(uploadId, userId, 'png', 'image/png', 8, 1, 1, `sha-${uploadId}`, now);
    db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, ?)')
      .run(tileId, uploadId, position);
  }
  if (!ext) return { batchId, tileId, file: null };
  const dir = join(dataDir, 'images', userId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tileId}.${ext}`);
  writeFileSync(file, 'artifact');
  return { batchId, tileId, file };
}

describe('archive route', () => {
  test('lists archived done tiles scoped to the current user, hiding failed/loading rows', async () => {
    const { app, db, config } = testRuntime();
    const older = seedTile(db, config.DATA_DIR, { archivedAt: 100, batchArchivedAt: 100, ratio: '4:5' });
    const newer = seedTile(db, config.DATA_DIR, { archivedAt: 200, batchArchivedAt: 200 });
    seedTile(db, config.DATA_DIR, { userId: 'other', archivedAt: 300, batchArchivedAt: 300 });
    seedTile(db, config.DATA_DIR, { archivedAt: null, batchArchivedAt: null });
    // Phantom rows from a pre-migration schema: archived failed/loading tiles.
    // The route filters them out at the SQL boundary so the count never lies.
    seedTile(db, config.DATA_DIR, { archivedAt: 400, batchArchivedAt: 400, status: 'failed' });
    seedTile(db, config.DATA_DIR, { archivedAt: 500, batchArchivedAt: 500, status: 'loading' });

    const res = await app.fetch(new Request('http://local/api/archive', { headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArchivePage;
    expect(body.items.map((item) => item.id)).toEqual([newer.tileId, older.tileId]);
    expect(body.items[0]).toMatchObject({
      status: 'done',
      url: `/api/img/${newer.tileId}`,
      thumbUrl: `/api/img/${newer.tileId}/thumb`,
      batchId: newer.batchId,
      prompt: 'prompt',
      modelLabel: 'Mock Fast',
    });
    expect(body.items[1]).toMatchObject({
      status: 'done',
      url: `/api/img/${older.tileId}`,
      thumbUrl: `/api/img/${older.tileId}/thumb`,
      ratio: '4:5',
    });
  });

  test('lists archived done tiles with ordered reference image ids', async () => {
    const { app, db, config } = testRuntime();
    const referenced = seedTile(db, config.DATA_DIR, {
      archivedAt: 100,
      batchArchivedAt: 100,
      refImageIds: ['upload-second', 'upload-first'],
    });
    seedTile(db, config.DATA_DIR, {
      userId: 'other',
      archivedAt: 200,
      batchArchivedAt: 200,
      refImageIds: ['upload-other'],
    });

    const res = await app.fetch(new Request('http://local/api/archive', { headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArchivePage;
    expect(body.items.find((item) => item.id === referenced.tileId)?.refImageIds).toEqual(['upload-second', 'upload-first']);
  });

  test('restore unarchives the tile and parent batch', async () => {
    const { app, db, config } = testRuntime();
    const { batchId, tileId } = seedTile(db, config.DATA_DIR, { archivedAt: 100, batchArchivedAt: 100 });

    const res = await app.fetch(new Request(`http://local/api/archive/${tileId}/restore`, { method: 'POST', headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(204);
    expect(db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM tiles WHERE id = ?').get(tileId)?.archived_at)
      .toBeNull();
    expect(db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM batches WHERE id = ?').get(batchId)?.archived_at)
      .toBeNull();
    const history = await app.fetch(new Request('http://local/api/history', { headers: { 'Remote-User': 'test' } }));
    expect(((await history.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  test('restore preserves collection assignment and pinned state', async () => {
    const { app, db, config } = testRuntime();
    const collectionId = crypto.randomUUID();
    const now = Date.now();
    db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run('test', now);
    db.query('INSERT INTO collections (id, user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(collectionId, 'test', 'Logos', 0, now);
    const { batchId, tileId } = seedTile(db, config.DATA_DIR, {
      archivedAt: 100,
      batchArchivedAt: 100,
      collectionId,
      pinned: true,
    });

    const res = await app.fetch(new Request(`http://local/api/archive/${tileId}/restore`, { method: 'POST', headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(204);
    expect(
      db.query<{ collection_id: string | null; pinned: 0 | 1 }, [string]>(
        'SELECT collection_id, pinned FROM batches WHERE id = ?',
      ).get(batchId),
    ).toEqual({ collection_id: collectionId, pinned: 1 });
  });

  test('permanently deletes an archived tile and artifact', async () => {
    const { app, db, config } = testRuntime();
    const { tileId, file } = seedTile(db, config.DATA_DIR, { archivedAt: 100, batchArchivedAt: null });
    if (!file) throw new Error('missing artifact');

    const res = await app.fetch(new Request(`http://local/api/archive/${tileId}`, { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(204);
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(tileId)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  test('permanent tile delete cascades archived parent batch when it was the last tile', async () => {
    const { app, db, config } = testRuntime();
    const { batchId, tileId } = seedTile(db, config.DATA_DIR, { archivedAt: 100, batchArchivedAt: 100 });

    const res = await app.fetch(new Request(`http://local/api/archive/${tileId}`, { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(204);
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(tileId)).toBeNull();
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(batchId)).toBeNull();
  });

  test('purge-all wipes archived rows and artifacts for the current user', async () => {
    const { app, db, config } = testRuntime();
    const archived = seedTile(db, config.DATA_DIR, { archivedAt: 100, batchArchivedAt: 100 });
    const other = seedTile(db, config.DATA_DIR, { userId: 'other', archivedAt: 100, batchArchivedAt: 100 });
    const visible = seedTile(db, config.DATA_DIR, { archivedAt: null, batchArchivedAt: null });

    const res = await app.fetch(new Request('http://local/api/archive', { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(204);
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(archived.tileId)).toBeNull();
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(archived.batchId)).toBeNull();
    expect(existsSync(archived.file ?? '')).toBe(false);
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(other.tileId)).toBeTruthy();
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(visible.tileId)).toBeTruthy();
    expect(existsSync(other.file ?? '')).toBe(true);
    expect(existsSync(visible.file ?? '')).toBe(true);
  });

  test('archive GET filters by collectionId=null, collectionId=<id>, and pinned=true', async () => {
    const { app, db, config } = testRuntime();
    const collectionId = crypto.randomUUID();
    db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run('test', Date.now());
    db.query('INSERT INTO collections (id, user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(collectionId, 'test', 'Logos', 0, Date.now());
    const unsorted = seedTile(db, config.DATA_DIR, { archivedAt: 100, batchArchivedAt: 100, collectionId: null });
    const pinnedRow = seedTile(db, config.DATA_DIR, { archivedAt: 200, batchArchivedAt: 200, collectionId: null, pinned: true });
    const inLogos = seedTile(db, config.DATA_DIR, { archivedAt: 300, batchArchivedAt: 300, collectionId });

    const byUnsorted = await app.fetch(new Request('http://local/api/archive?collectionId=null', { headers: { 'Remote-User': 'test' } }));
    expect(byUnsorted.status).toBe(200);
    const unsortedBody = await byUnsorted.json() as ArchivePage;
    expect(unsortedBody.items.map((tile) => tile.id).sort()).toEqual([unsorted.tileId, pinnedRow.tileId].sort());
    expect(unsortedBody.total).toBe(2);

    const byCollection = await app.fetch(new Request(`http://local/api/archive?collectionId=${collectionId}`, { headers: { 'Remote-User': 'test' } }));
    const collectionBody = await byCollection.json() as ArchivePage;
    expect(collectionBody.items.map((tile) => tile.id)).toEqual([inLogos.tileId]);
    expect(collectionBody.total).toBe(1);

    const byPinned = await app.fetch(new Request('http://local/api/archive?pinned=true', { headers: { 'Remote-User': 'test' } }));
    const pinnedBody = await byPinned.json() as ArchivePage;
    expect(pinnedBody.items.map((tile) => tile.id)).toEqual([pinnedRow.tileId]);
    expect(pinnedBody.total).toBe(1);
  });

  test('archive GET strict schema rejects unknown query params', async () => {
    const { app } = testRuntime();
    for (const qs of ['view=archive', 'foo=bar', 'q=hello']) {
      const res = await app.fetch(new Request(`http://local/api/archive?${qs}`, { headers: { 'Remote-User': 'test' } }));
      expect(res.status).toBe(400);
    }
  });

  test('archive mutations are idempotent for missing targets and empty purges', async () => {
    const { app } = testRuntime();
    const missing = crypto.randomUUID();

    const restore = await app.fetch(new Request(`http://local/api/archive/${missing}/restore`, { method: 'POST', headers: { 'Remote-User': 'test' } }));
    expect(restore.status).toBe(204);
    const del = await app.fetch(new Request(`http://local/api/archive/${missing}`, { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(del.status).toBe(204);
    const purge = await app.fetch(new Request('http://local/api/archive', { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(purge.status).toBe(204);
  });
});
