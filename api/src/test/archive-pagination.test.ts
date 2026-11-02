import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchivePage } from '@atelier/shared';
import { testRuntime } from './helpers';

// /archive cursor pagination. Ordering: batches.created_at DESC,
// batches.id DESC, tiles.tile_index ASC — newest scan first, tiles within
// a scan in stable index order. Cursor encodes (createdAt, batchId,
// tileIndex). These tests lock the page-boundary, intra-batch tie-break,
// inter-batch tie-break (same created_at), and invalid-cursor behaviors.

interface SeedTile {
  tileId: string;
  tileIndex: number;
}
interface SeedBatch {
  batchId: string;
  createdAt: number;
  archivedAt: number;
  tiles: SeedTile[];
}

function seedArchived(
  db: ReturnType<typeof testRuntime>['db'],
  dataDir: string,
  batches: SeedBatch[],
  userId = 'test',
): void {
  const now = Date.now();
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  for (const batch of batches) {
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(batch.batchId, userId, 'prompt', '1:1', 'mock-fast', 'Mock Fast', batch.createdAt, batch.archivedAt);
    for (const tile of batch.tiles) {
      db.query(
        'INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(tile.tileId, batch.batchId, userId, tile.tileIndex, 42, 'done', 'png', 'image/png', null, now, batch.archivedAt);
      const dir = join(dataDir, 'images', userId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${tile.tileId}.png`), 'artifact');
    }
  }
}

async function fetchArchive(app: ReturnType<typeof testRuntime>['app'], qs = ''): Promise<{ status: number; body: ArchivePage | { error: string } }> {
  const res = await app.fetch(
    new Request(`http://local/api/archive${qs}`, { headers: { 'Remote-User': 'test' } }),
  );
  return { status: res.status, body: (await res.json()) as ArchivePage | { error: string } };
}

describe('archive pagination', () => {
  test('single page returns nextCursor: null when results fit; total reflects all', async () => {
    const { app, db, config } = testRuntime();
    seedArchived(db, config.DATA_DIR, [
      { batchId: '11111111-0000-4000-8000-000000000001', createdAt: 100, archivedAt: 100, tiles: [{ tileId: '00000000-0000-4000-8000-000000000001', tileIndex: 0 }] },
      { batchId: '22222222-0000-4000-8000-000000000001', createdAt: 200, archivedAt: 200, tiles: [{ tileId: '00000000-0000-4000-8000-000000000002', tileIndex: 0 }] },
    ]);
    const { status, body } = await fetchArchive(app, '?limit=10');
    expect(status).toBe(200);
    if (!('items' in body)) throw new Error('expected ArchivePage');
    expect(body.items.length).toBe(2);
    expect(body.nextCursor).toBeNull();
    expect(body.total).toBe(2);
  });

  test('cursor round-trip: page1 → page2 returns the older scans', async () => {
    const { app, db, config } = testRuntime();
    seedArchived(db, config.DATA_DIR, [
      { batchId: '11111111-0000-4000-8000-000000000001', createdAt: 100, archivedAt: 100, tiles: [{ tileId: '00000000-0000-4000-8000-000000000001', tileIndex: 0 }] },
      { batchId: '22222222-0000-4000-8000-000000000001', createdAt: 200, archivedAt: 200, tiles: [{ tileId: '00000000-0000-4000-8000-000000000002', tileIndex: 0 }] },
      { batchId: '33333333-0000-4000-8000-000000000001', createdAt: 300, archivedAt: 300, tiles: [{ tileId: '00000000-0000-4000-8000-000000000003', tileIndex: 0 }] },
      { batchId: '44444444-0000-4000-8000-000000000001', createdAt: 400, archivedAt: 400, tiles: [{ tileId: '00000000-0000-4000-8000-000000000004', tileIndex: 0 }] },
    ]);
    const page1 = await fetchArchive(app, '?limit=2');
    expect(page1.status).toBe(200);
    if (!('items' in page1.body)) throw new Error('expected page1');
    expect(page1.body.items.length).toBe(2);
    expect(page1.body.items.map((t) => t.archivedAt)).toEqual([400, 300]);
    expect(page1.body.total).toBe(4);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await fetchArchive(app, `?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor ?? '')}`);
    expect(page2.status).toBe(200);
    if (!('items' in page2.body)) throw new Error('expected page2');
    expect(page2.body.items.length).toBe(2);
    expect(page2.body.items.map((t) => t.archivedAt)).toEqual([200, 100]);
    // total is sent only on the cursor-less first page; subsequent pages
    // carry null and the client reuses page 1's count.
    expect(page2.body.total).toBeNull();
    expect(page2.body.nextCursor).toBeNull();
  });

  test('intra-batch tiles are ordered by tile_index ASC and ride together', async () => {
    const { app, db, config } = testRuntime();
    seedArchived(db, config.DATA_DIR, [
      {
        batchId: 'aaaaaaaa-0000-4000-8000-000000000001',
        createdAt: 500,
        archivedAt: 500,
        tiles: [
          { tileId: '00000000-0000-4000-8000-000000000010', tileIndex: 2 },
          { tileId: '00000000-0000-4000-8000-000000000011', tileIndex: 0 },
          { tileId: '00000000-0000-4000-8000-000000000012', tileIndex: 1 },
        ],
      },
    ]);
    const { body } = await fetchArchive(app, '?limit=10');
    if (!('items' in body)) throw new Error('expected page');
    // tile_index 0, 1, 2 → ids ending 11, 12, 10
    expect(body.items.map((t) => t.id.slice(-2))).toEqual(['11', '12', '10']);
  });

  test('cross-batch tie-break on same created_at uses batch id DESC', async () => {
    const { app, db, config } = testRuntime();
    seedArchived(db, config.DATA_DIR, [
      { batchId: 'aaaaaaaa-0000-4000-8000-000000000001', createdAt: 500, archivedAt: 500, tiles: [{ tileId: '00000000-0000-4000-8000-0000000000a1', tileIndex: 0 }] },
      { batchId: 'bbbbbbbb-0000-4000-8000-000000000001', createdAt: 500, archivedAt: 500, tiles: [{ tileId: '00000000-0000-4000-8000-0000000000b1', tileIndex: 0 }] },
      { batchId: 'cccccccc-0000-4000-8000-000000000001', createdAt: 500, archivedAt: 500, tiles: [{ tileId: '00000000-0000-4000-8000-0000000000c1', tileIndex: 0 }] },
    ]);
    const page1 = await fetchArchive(app, '?limit=2');
    if (!('items' in page1.body)) throw new Error('expected page1');
    // id DESC on batch_id: c > b > a → page1 = [c, b], page2 = [a].
    expect(page1.body.items.map((t) => t.batchId[0])).toEqual(['c', 'b']);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await fetchArchive(app, `?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor ?? '')}`);
    if (!('items' in page2.body)) throw new Error('expected page2');
    expect(page2.body.items.map((t) => t.batchId[0])).toEqual(['a']);
    expect(page2.body.nextCursor).toBeNull();
  });

  test('cursor mid-batch resumes at the next tile_index within that batch', async () => {
    const { app, db, config } = testRuntime();
    seedArchived(db, config.DATA_DIR, [
      {
        batchId: 'aaaaaaaa-0000-4000-8000-000000000002',
        createdAt: 600,
        archivedAt: 600,
        tiles: [
          { tileId: '00000000-0000-4000-8000-000000000020', tileIndex: 0 },
          { tileId: '00000000-0000-4000-8000-000000000021', tileIndex: 1 },
          { tileId: '00000000-0000-4000-8000-000000000022', tileIndex: 2 },
          { tileId: '00000000-0000-4000-8000-000000000023', tileIndex: 3 },
        ],
      },
    ]);
    const page1 = await fetchArchive(app, '?limit=2');
    if (!('items' in page1.body)) throw new Error('expected page1');
    expect(page1.body.items.map((t) => t.id.slice(-2))).toEqual(['20', '21']);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await fetchArchive(app, `?limit=10&cursor=${encodeURIComponent(page1.body.nextCursor ?? '')}`);
    if (!('items' in page2.body)) throw new Error('expected page2');
    expect(page2.body.items.map((t) => t.id.slice(-2))).toEqual(['22', '23']);
    expect(page2.body.nextCursor).toBeNull();
  });

  test('invalid cursor returns 400', async () => {
    const { app, db, config } = testRuntime();
    seedArchived(db, config.DATA_DIR, [
      { batchId: '11111111-0000-4000-8000-000000000001', createdAt: 100, archivedAt: 100, tiles: [{ tileId: '00000000-0000-4000-8000-000000000001', tileIndex: 0 }] },
    ]);
    const { status, body } = await fetchArchive(app, '?cursor=not-base64-json');
    expect(status).toBe(400);
    expect('error' in body && body.error).toBe('validation failed');
  });
});
