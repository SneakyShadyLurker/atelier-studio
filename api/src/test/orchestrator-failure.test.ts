import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { TileRow } from '../db/types';
import { __orchestratorTest } from '../orchestrator';

const decoder = new TextDecoder();

test('emitFailed reads archived state inside the cleanup transaction', () => {
  let inTransaction = false;
  const archivedReadInsideTransaction: { value: boolean | null } = { value: null };
  const db = {
    transaction<T>(fn: () => T) {
      return () => {
        inTransaction = true;
        try {
          return fn();
        } finally {
          inTransaction = false;
        }
      };
    },
    query(sql: string) {
      return {
        get() {
          if (sql.includes('SELECT archived_at, batch_id FROM tiles')) {
            archivedReadInsideTransaction.value = inTransaction;
            return { archived_at: 1, batch_id: 'b1' };
          }
          if (sql.includes('SELECT COUNT(*) AS count FROM tiles')) return { count: 0 };
          return null;
        },
        run() {
          return { changes: 1 };
        },
      };
    },
  };
  const tile: TileRow = {
    id: 't1',
    batch_id: 'b1',
    user_id: 'u1',
    tile_index: 0,
    seed: 1,
    status: 'loading',
    ext: null,
    mime: null,
    error: null,
    completed_at: null,
    archived_at: 1,
  };
  const frames: string[] = [];

  __orchestratorTest.emitFailed(db as unknown as Database, (frame) => frames.push(decoder.decode(frame.bytes)), tile, 'internal error');

  expect(archivedReadInsideTransaction.value).toBe(true);
  expect(frames).toEqual([]);
});

test('emitFailed never contradicts an already committed done tile', () => {
  const db = terminalTileDb('done', null, 100);
  const frames: string[] = [];

  __orchestratorTest.emitFailed(db, (frame) => frames.push(decoder.decode(frame.bytes)), tileRow('done'), 'internal error');

  expect(frames).toEqual([]);
  expect(db.query<{ status: string }, []>('SELECT status FROM tiles').get()?.status).toBe('done');
  db.close();
});

test('emitFailed replays the persisted failure from a concurrent DB writer', () => {
  const db = terminalTileDb('failed', 'timed out', 123);
  const frames: string[] = [];

  __orchestratorTest.emitFailed(db, (frame) => frames.push(decoder.decode(frame.bytes)), tileRow('loading'), 'internal error');

  expect(frames).toHaveLength(1);
  expect(frames[0]).toContain('"error":"timed out"');
  expect(frames[0]).toContain('"completedAt":123');
  db.close();
});

test('emitFailed keeps the persisted categories when a different failure loses the race', () => {
  const db = terminalTileDb('failed', 'content-policy violation', 123);
  db.query('UPDATE tiles SET moderation_reason=?, moderation_categories=?').run('sexual-age', '["nudity"]');
  const frames: string[] = [];
  __orchestratorTest.emitFailed(db, (frame) => frames.push(decoder.decode(frame.bytes)), tileRow('loading'), 'content-policy violation', {
    reason: 'sexual-age', categories: ['sexual-age'], target: 'image',
  });
  expect(frames).toHaveLength(1);
  expect(frames[0]).toContain('"categories":["nudity"]');
  expect(frames[0]).not.toContain('"categories":["sexual-age"]');
  db.close();
});

function terminalTileDb(status: string, error: string | null, completedAt: number): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE tiles (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    moderation_reason TEXT,
    moderation_categories TEXT,
    completed_at INTEGER,
    archived_at INTEGER
  )`);
  db.query('INSERT INTO tiles (id, batch_id, status, error, completed_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)')
    .run('t1', 'b1', status, error, completedAt);
  return db;
}

function tileRow(status: TileRow['status']): TileRow {
  return {
    id: 't1',
    batch_id: 'b1',
    user_id: 'u1',
    tile_index: 0,
    seed: 1,
    status,
    ext: null,
    mime: null,
    error: null,
    completed_at: null,
    archived_at: null,
  };
}
