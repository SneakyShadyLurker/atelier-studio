import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from './migrate';
import { findBatchByIdempotencyKey } from './idempotency';

function insertBatch(db: Database, id: string, userId: string, key: string | null, archivedAt: number | null = null): void {
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 1)').run(userId);
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at, status, pool, idempotency_key)
     VALUES (?, ?, 'p', '1:1', 'mock-slow', 'Mock Slow', 1, ?, 'queued', 'shared', ?)`,
  ).run(id, userId, archivedAt, key);
}

describe('findBatchByIdempotencyKey', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db, mkdtempSync(join(tmpdir(), 'atelier-idempotency-')));
  });

  afterEach(() => {
    db.close();
  });

  test("returns the caller's batch carrying the key", () => {
    insertBatch(db, 'b1', 'alice', 'k1');

    expect(findBatchByIdempotencyKey(db, 'alice', 'k1')).toMatchObject({ id: 'b1', user_id: 'alice', idempotency_key: 'k1' });
  });

  test("another user's key never matches", () => {
    insertBatch(db, 'b1', 'alice', 'k1');

    expect(findBatchByIdempotencyKey(db, 'bob', 'k1')).toBeNull();
  });

  test('keyless batches never match', () => {
    insertBatch(db, 'b1', 'alice', null);

    expect(findBatchByIdempotencyKey(db, 'alice', 'null')).toBeNull();
    expect(findBatchByIdempotencyKey(db, 'alice', '')).toBeNull();
  });

  test('an archived batch still matches', () => {
    insertBatch(db, 'b1', 'alice', 'k1', 123);

    expect(findBatchByIdempotencyKey(db, 'alice', 'k1')).toMatchObject({ id: 'b1', archived_at: 123 });
  });
});
