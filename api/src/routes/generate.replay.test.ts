import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchStatus, Pool } from '@atelier/shared';
import { migrate } from '../db/migrate';
import { findBatchByIdempotencyKey } from '../db/idempotency';
import type { BatchRow } from '../db/types';
import * as queue from '../orchestrator/queue';
import { buildReplayResponse } from './generate.replay';

function insertBatch(
  db: Database,
  opts: { id: string; status: BatchStatus; pool?: Pool; archivedAt?: number | null; tileIndexes?: readonly number[] },
): BatchRow {
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 1)').run('u1');
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at, status, pool, idempotency_key)
     VALUES (?, 'u1', 'p', '1:1', 'mock-slow', 'Mock Slow', 1, ?, ?, ?, ?)`,
  ).run(opts.id, opts.archivedAt ?? null, opts.status, opts.pool ?? 'shared', `key-${opts.id}`);
  // Insert out of order so the builder's ORDER BY is what sorts them.
  for (const tileIndex of opts.tileIndexes ?? [1, 0]) {
    db.query(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, archived_at)
       VALUES (?, ?, 'u1', ?, ?, ?, ?)`,
    ).run(
      `${opts.id}-t${tileIndex}`,
      opts.id,
      tileIndex,
      100 + tileIndex,
      opts.status === 'done' ? 'done' : 'loading',
      opts.archivedAt ?? null,
    );
  }
  const row = findBatchByIdempotencyKey(db, 'u1', `key-${opts.id}`);
  if (!row) throw new Error('fixture batch missing');
  return row;
}

describe('buildReplayResponse', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db, mkdtempSync(join(tmpdir(), 'atelier-replay-')));
    queue.resetQueueForTests();
  });

  afterEach(() => {
    queue.resetQueueForTests();
    db.close();
  });

  test('a queued batch reports its queue position and tiles in tile_index order', () => {
    const batch = insertBatch(db, { id: 'q1', status: 'queued' });
    queue.enqueue('shared', { batchId: 'other', userId: 'u2', modelId: 'mock-slow', count: 1, queuedAt: 0 });
    queue.enqueue('shared', { batchId: 'q1', userId: 'u1', modelId: 'mock-slow', count: 2, queuedAt: 1 });

    expect(buildReplayResponse(db, batch)).toEqual({
      batchId: 'q1',
      tiles: [
        { tileId: 'q1-t0', tileIndex: 0, seed: 100 },
        { tileId: 'q1-t1', tileIndex: 1, seed: 101 },
      ],
      status: 'queued',
      pool: 'shared',
      queueLengthAhead: 1,
      replayed: true,
    });
  });

  test('a queued batch missing from the in-memory queue omits queueLengthAhead', () => {
    const batch = insertBatch(db, { id: 'q2', status: 'queued' });

    expect(buildReplayResponse(db, batch)).not.toHaveProperty('queueLengthAhead');
  });

  test('a running batch reports running without a queue position', () => {
    const batch = insertBatch(db, { id: 'r1', status: 'running', pool: 'local' });

    const response = buildReplayResponse(db, batch);
    expect(response).toMatchObject({ batchId: 'r1', status: 'running', pool: 'local', replayed: true });
    expect(response).not.toHaveProperty('queueLengthAhead');
    expect(response).not.toHaveProperty('refImageIds');
  });

  test('a done batch reports done', () => {
    const batch = insertBatch(db, { id: 'd1', status: 'done' });

    expect(buildReplayResponse(db, batch)).toMatchObject({ batchId: 'd1', status: 'done', replayed: true });
  });

  test('an archived batch still lists every tile', () => {
    const batch = insertBatch(db, { id: 'a1', status: 'done', archivedAt: 5 });

    expect(buildReplayResponse(db, batch).tiles.map((tile) => tile.tileId)).toEqual(['a1-t0', 'a1-t1']);
  });

  test('a batch with reference images reproduces the reference list in order', () => {
    const batch = insertBatch(db, { id: 'ref1', status: 'running', tileIndexes: [0] });
    for (const uploadId of ['up-b', 'up-a']) {
      db.query(
        `INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at)
         VALUES (?, 'u1', 'png', 'image/png', 1, 1, 1, 'x', 1)`,
      ).run(uploadId);
    }
    db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, ?), (?, ?, ?)')
      .run('ref1-t0', 'up-b', 0, 'ref1-t0', 'up-a', 1);

    expect(buildReplayResponse(db, batch).refImageIds).toEqual(['up-b', 'up-a']);
  });
});
