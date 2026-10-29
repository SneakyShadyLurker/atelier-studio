import { describe, expect, test } from 'bun:test';
import { testRuntime } from '../test/helpers';
import { archiveClearVisibleDeletePlanForTests, archiveTotalForTests } from './archive';

function seedCollectionArchive(db: ReturnType<typeof testRuntime>['db']): string {
  const userId = 'alice';
  const collectionId = '11111111-1111-4111-8111-111111111111';
  db.run(`INSERT INTO users (id, created_at) VALUES (?, ?)`, [userId, 1]);
  db.run(`INSERT INTO collections (id, user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`, [
    collectionId,
    userId,
    'favorites',
    0,
    1,
  ]);
  for (let i = 0; i < 4; i += 1) {
    const batchId = `22222222-2222-4222-8222-22222222222${i}`;
    const tileId = `33333333-3333-4333-8333-33333333333${i}`;
    db.run(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, collection_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', i, 'done', 'shared', i < 2 ? collectionId : null],
    );
    db.run(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tileId, batchId, userId, 0, i, 'done', 'png', 'image/png', 10 + i, 20 + i],
    );
  }
  return collectionId;
}

describe('archive total query plan', () => {
  test('collection-scoped totals are driven through batch-id tile lookups', () => {
    const rt = testRuntime();
    const collectionId = seedCollectionArchive(rt.db);

    const result = archiveTotalForTests(rt.db, 'alice', { collectionId });

    expect(result.total).toBe(2);
    expect(result.plan).toContain('idx_tiles_user_batch');
    expect(result.plan).not.toContain('idx_tiles_user_archived_seek');
  });

  test('clear archive visible delete is driven through the archive seek index', () => {
    const rt = testRuntime();
    seedCollectionArchive(rt.db);

    const result = archiveClearVisibleDeletePlanForTests(rt.db, 'alice');

    expect(result.plan).toContain('idx_tiles_user_archived_seek');
  });
});
