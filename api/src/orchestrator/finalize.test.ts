import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../db/migrate';
import { finalizeBatch } from './finalize';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db, '/tmp');
});

function seed(batchStatus: string, tileStatuses: string[]): void {
  db.run("INSERT OR IGNORE INTO users (id, created_at) VALUES ('u1', ?)", [Date.now()]);
  db.run(
    `INSERT INTO batches (id, user_id, prompt, model_id, model_label, ratio, created_at, status, pool)
     VALUES ('b1', 'u1', 'p', 'gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', '1:1', ?, ?, 'shared')`,
    [Date.now(), batchStatus],
  );
  tileStatuses.forEach((status, index) => {
    db.run(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
       VALUES (?, 'b1', 'u1', ?, 0, ?)`,
      [`t${index}`, index, status],
    );
  });
}

test('finalizeBatch flips running to done when all tiles terminal', () => {
  seed('running', ['done', 'failed']);
  finalizeBatch(db, 'b1');
  const row = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get();
  expect(row?.status).toBe('done');
});

test('finalizeBatch is a no-op if any tile is still loading', () => {
  seed('running', ['done', 'loading']);
  finalizeBatch(db, 'b1');
  const row = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get();
  expect(row?.status).toBe('running');
});

test('finalizeBatch is idempotent on already done batches', () => {
  seed('done', ['done']);
  finalizeBatch(db, 'b1');
  const row = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get();
  expect(row?.status).toBe('done');
});
