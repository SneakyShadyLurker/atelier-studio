import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeAtomic } from '../storage/files';
import { join } from 'node:path';
import { adoptStandaloneBatch, appendSegment } from '../db/sequences';
import { setSequenceStitchRunnerForTests } from '../storage/stitchSequence';
import { testRuntime } from '../test/helpers';
import {
  resetStitchQueueForTests,
  waitForStitchQueueIdle,
} from './stitchQueue';
import { settleSequenceAfterBatchTerminal } from './sequenceLifecycle';

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

afterEach(async () => {
  await waitForStitchQueueIdle();
  resetStitchQueueForTests();
  setSequenceStitchRunnerForTests(null);
});

interface SeededSequence {
  readonly sequenceId: string;
  readonly batchIds: readonly string[];
  readonly tileIds: readonly string[];
}

function seedSequence(
  db: Database,
  dataDir: string,
  segmentCount: number,
  archived = false,
): SeededSequence {
  const userId = 'alice';
  const batchIds = Array.from({ length: segmentCount }, () => crypto.randomUUID());
  const tileIds = Array.from({ length: segmentCount }, () => crypto.randomUUID());
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 1)').run(userId);
  const insertBatch = db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at,
       status, pool, duration_frames)
     VALUES (?, ?, ?, '16:9', 'minimax-h3-i2v', 'MiniMax H3', ?, ?, 'done', 'local', 124)`,
  );
  const insertTile = db.query(
    `INSERT INTO tiles
      (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at, archived_at)
     VALUES (?, ?, ?, 0, 1, 'done', 'mp4', 'video/mp4', 1, ?)`,
  );
  const imageDir = join(dataDir, 'images', userId);
  mkdirSync(imageDir, { recursive: true });
  for (let index = 0; index < segmentCount; index++) {
    const batchId = batchIds[index];
    const tileId = tileIds[index];
    if (!batchId || !tileId) throw new Error('missing sequence fixture id');
    insertBatch.run(batchId, userId, `segment ${index}`, index + 1, archived ? 100 : null);
    insertTile.run(tileId, batchId, userId, archived ? 100 : null);
    writeFileSync(join(imageDir, `${tileId}.mp4`), MP4);
  }
  const firstBatchId = batchIds[0];
  if (!firstBatchId) throw new Error('missing first fixture batch');
  const adopted = adoptStandaloneBatch(db, userId, firstBatchId, 10);
  if (adopted.status !== 'ok') throw new Error('expected sequence adoption');
  let tailBatchId = firstBatchId;
  for (const batchId of batchIds.slice(1)) {
    const appended = appendSegment(
      db,
      { error: () => undefined },
      userId,
      adopted.sequenceId,
      tailBatchId,
      batchId,
      11,
    );
    if (appended.status !== 'ok') throw new Error('expected sequence append');
    tailBatchId = batchId;
  }
  return { sequenceId: adopted.sequenceId, batchIds, tileIds };
}

describe('video sequence lifecycle integration', () => {
  test('terminal failure auto-unlinks and dissolves a sequence below two segments', () => {
    const runtime = testRuntime();
    const seeded = seedSequence(runtime.db, runtime.config.DATA_DIR, 2);
    const tailBatchId = seeded.batchIds[1];
    if (!tailBatchId) throw new Error('missing tail fixture batch');
    const masterPath = join(
      runtime.config.DATA_DIR,
      'images',
      'alice',
      `${seeded.sequenceId}.mp4`,
    );
    writeFileSync(masterPath, MP4);

    settleSequenceAfterBatchTerminal(
      runtime.db,
      runtime.config,
      runtime.logger,
      tailBatchId,
      false,
    );

    expect(runtime.db.query('SELECT id FROM video_sequences WHERE id = ?').get(seeded.sequenceId))
      .toBeNull();
    expect(runtime.db.query<{ count: number }, [string, string]>(
      'SELECT COUNT(*) AS count FROM batches WHERE sequence_id IS NOT NULL AND id IN (?, ?)',
    ).get(seeded.batchIds[0] ?? '', tailBatchId)?.count).toBe(0);
    expect(existsSync(masterPath)).toBe(false);
  });

  test('queued cancellation auto-unlinks and dissolves a sequence below two segments', async () => {
    const runtime = testRuntime();
    const seeded = seedSequence(runtime.db, runtime.config.DATA_DIR, 2);
    const tailBatchId = seeded.batchIds[1];
    const tailTileId = seeded.tileIds[1];
    if (!tailBatchId || !tailTileId) throw new Error('missing tail fixture');
    runtime.db.query("UPDATE batches SET status = 'queued' WHERE id = ?").run(tailBatchId);
    runtime.db.query(
      "UPDATE tiles SET status = 'loading', ext = NULL, mime = NULL, completed_at = NULL WHERE id = ?",
    ).run(tailTileId);

    const response = await runtime.app.fetch(new Request(
      `http://local/api/history/${tailBatchId}`,
      { method: 'DELETE', headers: { 'Remote-User': 'alice' } },
    ));

    expect(response.status).toBe(204);
    expect(runtime.db.query('SELECT id FROM video_sequences WHERE id = ?').get(seeded.sequenceId))
      .toBeNull();
    expect(runtime.db.query<{ sequence_id: string | null }, [string]>(
      'SELECT sequence_id FROM batches WHERE id = ?',
    ).get(seeded.batchIds[0] ?? '')?.sequence_id).toBeNull();
  });

  test('permanent deletion discards a tail but dissolves on a non-tail segment', async () => {
    const runtime = testRuntime();
    const seeded = seedSequence(runtime.db, runtime.config.DATA_DIR, 3, true);
    // This test re-stitches, which decrypts the segments: store them through
    // the real (encrypting) artifact writer.
    for (const tileId of seeded.tileIds) {
      await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', tileId, 'mp4', MP4);
    }
    const tailTileId = seeded.tileIds[2];
    const firstTileId = seeded.tileIds[0];
    const survivorBatchId = seeded.batchIds[1];
    if (!tailTileId || !firstTileId || !survivorBatchId) throw new Error('missing deletion fixture');
    setSequenceStitchRunnerForTests(() => Promise.resolve(MP4));

    const tailDelete = await runtime.app.fetch(new Request(
      `http://local/api/archive/${tailTileId}`,
      { method: 'DELETE', headers: { 'Remote-User': 'alice' } },
    ));
    expect(tailDelete.status).toBe(204);
    await waitForStitchQueueIdle();
    expect(runtime.db.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM batches WHERE sequence_id = ?',
    ).get(seeded.sequenceId)?.count).toBe(2);
    const masterPath = join(
      runtime.config.DATA_DIR,
      'images',
      'alice',
      `${seeded.sequenceId}.mp4`,
    );
    expect(existsSync(masterPath)).toBe(true);

    const nonTailDelete = await runtime.app.fetch(new Request(
      `http://local/api/archive/${firstTileId}`,
      { method: 'DELETE', headers: { 'Remote-User': 'alice' } },
    ));
    expect(nonTailDelete.status).toBe(204);
    expect(runtime.db.query('SELECT id FROM video_sequences WHERE id = ?').get(seeded.sequenceId))
      .toBeNull();
    expect(runtime.db.query<{ sequence_id: string | null }, [string]>(
      'SELECT sequence_id FROM batches WHERE id = ?',
    ).get(survivorBatchId)?.sequence_id).toBeNull();
    expect(existsSync(masterPath)).toBe(false);
  });
});
