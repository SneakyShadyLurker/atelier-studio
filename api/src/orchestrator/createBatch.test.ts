import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate';
import type { ResolvedGenerateRequest } from '../orchestrator';
import type { RegistryEntry } from '../providers/registry';
import { findModel } from '../providers/registry';
import { tempDir, testConfig } from '../test/helpers';
import { createBatch } from './createBatch';
import * as queue from './queue';

function fakeRegistryEntry(): RegistryEntry {
  return {
    model: { id: 'mock-slow', name: 'Mock Slow', pool: 'shared' },
  } as unknown as RegistryEntry;
}

const baseRequest: ResolvedGenerateRequest = {
  prompt: 'a lighthouse',
  modelId: 'mock-slow',
  ratio: '1:1',
  count: 1,
};

function storedKey(db: Database, batchId: string): string | null | undefined {
  return db
    .query<{ idempotency_key: string | null }, [string]>('SELECT idempotency_key FROM batches WHERE id = ?')
    .get(batchId)?.idempotency_key;
}

describe('createBatch — idempotency key', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db, mkdtempSync(join(tmpdir(), 'atelier-create-batch-')));
  });

  afterEach(() => {
    db.close();
  });

  test('persists the request idempotency key on the batch row', () => {
    const prepared = createBatch(db, 'u1', { ...baseRequest, idempotencyKey: 'k1' }, fakeRegistryEntry());

    expect(prepared.batch.idempotency_key).toBe('k1');
    expect(storedKey(db, prepared.batch.id)).toBe('k1');
  });

  test('persists NULL when the request carries no key', () => {
    const prepared = createBatch(db, 'u1', baseRequest, fakeRegistryEntry());

    expect(prepared.batch.idempotency_key).toBeNull();
    expect(storedKey(db, prepared.batch.id)).toBeNull();
  });

  test('a second batch with the same user and key violates the unique index', () => {
    createBatch(db, 'u1', { ...baseRequest, idempotencyKey: 'k1' }, fakeRegistryEntry());

    expect(() => createBatch(db, 'u1', { ...baseRequest, idempotencyKey: 'k1' }, fakeRegistryEntry())).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' }),
    );
    expect(db.query('SELECT COUNT(*) AS n FROM batches').get()).toEqual({ n: 1 });
  });
});

describe('createBatch acceptance order', () => {
  let db: Database;
  let dbPath: string;
  let config: ReturnType<typeof testConfig>;

  beforeEach(() => {
    const dataDir = tempDir();
    dbPath = join(dataDir, 'ordering.sqlite');
    db = new Database(dbPath);
    migrate(db, dataDir);
    config = testConfig({ DATA_DIR: dataDir });
    queue.resetQueueForTests();
  });

  afterEach(() => {
    db.close();
    queue.resetQueueForTests();
  });

  function create(userId = 'alice', modelId = 'mock-fast', extra: { refImageIds?: string[]; idempotencyKey?: string } = {}) {
    const entry = findModel(modelId, config);
    if (!entry) throw new Error('expected registered model');
    return createBatch(db, userId, { prompt: 'portrait', modelId, ratio: '1:1', count: 1, ...extra }, entry);
  }

  test('equal-millisecond acceptance order survives reversed UUID order and database reopen', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(10_000);
    const ids = spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('ffffffff-ffff-4fff-8fff-ffffffffffff')
      .mockReturnValueOnce('ffffffff-ffff-4fff-8fff-fffffffffffe')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000000')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001');
    try {
      const first = create();
      const second = create();
      expect(first.batch.created_at).toBe(10_000);
      expect(second.batch.created_at).toBe(10_001);
      db.close();
      db = new Database(dbPath);

      queue.rebuildFromDb(db);
      expect(queue.entries('shared').map((entry) => entry.batchId)).toEqual([first.batch.id, second.batch.id]);
      expect(db.query<{ id: string }, [string]>(
        'SELECT id FROM batches WHERE user_id=? ORDER BY created_at DESC, id DESC',
      ).all('alice').map((row) => row.id)).toEqual([second.batch.id, first.batch.id]);
    } finally {
      clock.mockRestore();
      ids.mockRestore();
    }
  });

  test('the persisted per-user clock spans pools and archived rows across restart and backward wall time', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(20_000);
    try {
      const first = create();
      const local = create('alice', 'moss-image-sft');
      db.run("UPDATE batches SET status='done', archived_at=20000 WHERE id=?", [local.batch.id]);
      db.close();
      db = new Database(dbPath);
      clock.mockReturnValue(19_000);
      const afterRestart = create('alice', 'gemini-3-pro-image-preview');
      const otherUser = create('bob');
      expect([first.batch.created_at, local.batch.created_at, afterRestart.batch.created_at])
        .toEqual([20_000, 20_001, 20_002]);
      expect(otherUser.batch.created_at).toBe(19_000);

      clock.mockReturnValue(30_000);
      expect(create().batch.created_at).toBe(30_000);
    } finally { clock.mockRestore(); }
  });

  test('failed reference or duplicate-key inserts do not consume a persisted timestamp', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(40_000);
    try {
      const first = create('alice', 'mock-fast', { idempotencyKey: 'accepted' });
      expect(() => create('alice', 'mock-fast', { refImageIds: ['missing-upload'] })).toThrow();
      expect(() => create('alice', 'mock-fast', { idempotencyKey: 'accepted' })).toThrow();
      const next = create();
      expect(next.batch.created_at).toBe(first.batch.created_at + 1);
      expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM batches').get()?.count).toBe(2);
      expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM tiles').get()?.count).toBe(2);
    } finally { clock.mockRestore(); }
  });
});
