import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { fsyncSync, renameSync } from 'node:fs';
import { adoptStandaloneBatch, appendSegment, bumpStitchRevision, markReady } from '../db/sequences';
import { plaintextOf, testRuntime } from '../test/helpers';
import { setStorageOpsForTests, writeAtomic } from '../storage/files';
import {
  resetStitchQueueForTests,
  enqueueSequenceStitch,
  waitForStitchQueueIdle,
} from './stitchQueue';
import {
  SequenceStitchCommandError,
  setSequenceStitchRunnerForTests,
} from '../storage/stitchSequence';
import { settleSequenceAfterBatchTerminal } from './sequenceLifecycle';
import { resetDecryptedVideoCacheForTests } from '../storage/decryptedVideoCache';

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

afterEach(async () => {
  await waitForStitchQueueIdle();
  resetStitchQueueForTests();
  setSequenceStitchRunnerForTests(null);
  setStorageOpsForTests(null);
  resetDecryptedVideoCacheForTests();
});

async function seedSequence(
  db: Database,
  dataDir: string,
  userId = 'alice',
): Promise<{ sequenceId: string; batchIds: readonly [string, string] }> {
  const batch0 = crypto.randomUUID();
  const batch1 = crypto.randomUUID();
  const tile0 = crypto.randomUUID();
  const tile1 = crypto.randomUUID();
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 1)').run(userId);
  const insertBatch = db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
     VALUES (?, ?, ?, '16:9', 'minimax-h3-i2v', 'MiniMax H3', ?, 'done', 'local', 124)`,
  );
  insertBatch.run(batch0, userId, 'first', 1);
  insertBatch.run(batch1, userId, 'second', 2);
  const insertTile = db.query(
    `INSERT INTO tiles
      (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
     VALUES (?, ?, ?, 0, 1, 'done', 'mp4', 'video/mp4', 1)`,
  );
  insertTile.run(tile0, batch0, userId);
  insertTile.run(tile1, batch1, userId);
  await writeAtomic(dataDir, 'images', userId, tile0, 'mp4', MP4);
  await writeAtomic(dataDir, 'images', userId, tile1, 'mp4', MP4);
  const adopted = adoptStandaloneBatch(db, userId, batch0, 10);
  if (adopted.status !== 'ok') throw new Error('expected adoption');
  const appended = appendSegment(db, { error: () => undefined }, userId, adopted.sequenceId, batch0, batch1, 11);
  if (appended.status !== 'ok') throw new Error('expected append');
  return { sequenceId: adopted.sequenceId, batchIds: [batch0, batch1] };
}

function appendQueuedTail(
  db: Database,
  sequenceId: string,
  expectedTailBatchId: string,
): { readonly batchId: string; readonly tileId: string } {
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
     VALUES (?, 'alice', 'queued tail', '16:9', 'minimax-h3-i2v', 'MiniMax H3', 3, 'queued', 'local', 124)`,
  ).run(batchId);
  db.query(
    `INSERT INTO tiles
      (id, batch_id, user_id, tile_index, seed, status)
     VALUES (?, ?, 'alice', 0, 1, 'loading')`,
  ).run(tileId, batchId);
  const appended = appendSegment(
    db,
    { error: () => undefined },
    'alice',
    sequenceId,
    expectedTailBatchId,
    batchId,
  );
  if (appended.status !== 'ok') throw new Error('expected queued tail append');
  return { batchId, tileId };
}

describe('sequence stitch queue', () => {
  test('persists waiting FIFO intent while another sequence owns the worker', async () => {
    const runtime = testRuntime({ COMFYUI_BASE_URL: 'http://127.0.0.1:1', VIDEO_MODELS_ENABLED: 'true', LOCAL_MODELS_USERS: 'alice' });
    const first = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const waiting = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const legacy = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    markReady(runtime.db, waiting.sequenceId, 2, 1);
    markReady(runtime.db, legacy.sequenceId, 2, 1);
    runtime.db.query('UPDATE video_sequences SET master_revision = NULL WHERE id = ?').run(legacy.sequenceId);
    for (const sequence of [waiting, legacy]) await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', sequence.sequenceId, 'mp4', MP4);
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    setSequenceStitchRunnerForTests(async () => {
      if (++calls === 1) { started(); await gate; }
      return MP4;
    });
    enqueueSequenceStitch(first.sequenceId);
    await running;
    try {
      for (const sequence of [waiting, legacy]) {
        enqueueSequenceStitch(sequence.sequenceId);
        expect(runtime.db.query('SELECT master_status, stitch_pending, master_updated_at FROM video_sequences WHERE id = ?').get(sequence.sequenceId))
          .toEqual({ master_status: 'ready', stitch_pending: 1, master_updated_at: 1 });
        const response = await runtime.app.fetch(new Request(`http://local/api/sequences/${sequence.sequenceId}/master`, {
          headers: { 'Remote-User': 'alice' },
        }));
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP4);
      }
    } finally { release(); }
    await waitForStitchQueueIdle();
    expect(calls).toBe(3);
    expect(runtime.db.query('SELECT master_revision, stitch_revision, stitch_pending FROM video_sequences WHERE id = ?').get(waiting.sequenceId))
      .toEqual({ master_revision: 2, stitch_revision: 2, stitch_pending: 0 });
  });

  test('an enqueue deferred for an in-flight tail preserves a valid previous master', async () => {
    const runtime = testRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    markReady(runtime.db, seeded.sequenceId, 2, 1);
    const tail = appendQueuedTail(runtime.db, seeded.sequenceId, seeded.batchIds[1]);
    let calls = 0;
    setSequenceStitchRunnerForTests(() => { calls++; return Promise.resolve(MP4); });
    enqueueSequenceStitch(seeded.sequenceId, tail.batchId);
    await waitForStitchQueueIdle();
    expect(calls).toBe(0);
    expect(runtime.db.query('SELECT master_status, master_revision, stitch_revision FROM video_sequences WHERE id = ?').get(seeded.sequenceId))
      .toEqual({ master_status: 'ready', master_revision: 2, stitch_revision: 3 });
    expect(runtime.db.query('SELECT stitch_pending FROM video_sequences WHERE id = ?').get(seeded.sequenceId)).toEqual({ stitch_pending: 1 });
  });

  test('marks a current revision ready and publishes the master atomically', async () => {
    const runtime = testRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const operations: string[] = [];
    const masterStatus = (): string | undefined => runtime.db.query<{ master_status: string }, [string]>(
      'SELECT master_status FROM video_sequences WHERE id = ?',
    ).get(seeded.sequenceId)?.master_status;
    setStorageOpsForTests({
      fsync: (fd) => {
        operations.push(`fsync:${masterStatus()}`);
        fsyncSync(fd);
      },
      renameSync: (from, to) => {
        operations.push(`rename:${masterStatus()}`);
        renameSync(from, to);
      },
    });
    setSequenceStitchRunnerForTests(() => Promise.resolve(MP4));
    enqueueSequenceStitch(seeded.sequenceId, seeded.batchIds[1]);
    await waitForStitchQueueIdle();

    expect(runtime.db.query<{ master_status: string }, [string]>(
      'SELECT master_status FROM video_sequences WHERE id = ?',
    ).get(seeded.sequenceId)?.master_status).toBe('ready');
    expect(await plaintextOf('alice', `${runtime.config.DATA_DIR}/images/alice/${seeded.sequenceId}.mp4`))
      .toEqual(MP4);
    expect(operations).toEqual([
      'fsync:stitching',
      'rename:stitching',
      'fsync:stitching',
    ]);
  });

  test('restores the previous master when the post-rename revision CAS fails', async () => {
    const runtime = testRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const previous = new Uint8Array([1, 2, 3]);
    const firstAttempt = new Uint8Array([4, 5, 6]);
    const latest = new Uint8Array([7, 8, 9]);
    setSequenceStitchRunnerForTests(() => Promise.resolve(previous));
    enqueueSequenceStitch(seeded.sequenceId, seeded.batchIds[1]);
    await waitForStitchQueueIdle();

    const masterPath = `${runtime.config.DATA_DIR}/images/alice/${seeded.sequenceId}.mp4`;
    const tmpPath = `${masterPath}.tmp`;
    let bumped = false;
    let calls = 0;
    let restoredBeforeRerun: number[] = [];
    setStorageOpsForTests({
      renameSync: (from, to) => {
        renameSync(from, to);
        if (!bumped && from === tmpPath && to === masterPath) {
          bumped = true;
          bumpStitchRevision(runtime.db, seeded.sequenceId);
          // Keep candidate bytes inaccessible under the old publication identity
          // until the guarded commit rejects them and restores the backup.
          expect(runtime.db.query('SELECT master_status FROM video_sequences WHERE id = ?').get(seeded.sequenceId))
            .toEqual({ master_status: 'stitching' });
        }
      },
    });
    setSequenceStitchRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) return firstAttempt;
      restoredBeforeRerun = Array.from(await plaintextOf('alice', masterPath));
      return latest;
    });

    enqueueSequenceStitch(seeded.sequenceId, seeded.batchIds[1]);
    await waitForStitchQueueIdle();

    expect(calls).toBe(2);
    expect(restoredBeforeRerun).toEqual(Array.from(previous));
    expect(await plaintextOf('alice', masterPath)).toEqual(latest);
    expect(runtime.db.query<{ master_status: string }, [string]>(
      'SELECT master_status FROM video_sequences WHERE id = ?',
    ).get(seeded.sequenceId)?.master_status).toBe('ready');
  });

  test('marks ffmpeg failures failed without unlinking segments', async () => {
    const runtime = testRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    setSequenceStitchRunnerForTests(() => Promise.reject(new SequenceStitchCommandError('bad codec')));
    enqueueSequenceStitch(seeded.sequenceId, seeded.batchIds[1]);
    await waitForStitchQueueIdle();

    expect(runtime.db.query<{ master_status: string; count: number }, [string]>(
      `SELECT s.master_status, COUNT(b.id) AS count
         FROM video_sequences s JOIN batches b ON b.sequence_id = s.id
        WHERE s.id = ? GROUP BY s.id`,
    ).get(seeded.sequenceId)).toEqual({ master_status: 'failed', count: 2 });
  });

  test('discards revision-stale publication and re-enqueues the latest revision', async () => {
    const runtime = testRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    let calls = 0;
    setSequenceStitchRunnerForTests(() => {
      calls += 1;
      if (calls === 1) bumpStitchRevision(runtime.db, seeded.sequenceId);
      return Promise.resolve(MP4);
    });
    enqueueSequenceStitch(seeded.sequenceId, seeded.batchIds[1]);
    await waitForStitchQueueIdle();
    expect(calls).toBe(2);
    expect(runtime.db.query<{ master_status: string }, [string]>(
      'SELECT master_status FROM video_sequences WHERE id = ?',
    ).get(seeded.sequenceId)?.master_status).toBe('ready');
  });

  test('coalesces N rapid triggers into at most two serialized runs', async () => {
    const runtime = testRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    let releaseFirst: () => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    setSequenceStitchRunnerForTests(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        signalStarted();
        await firstGate;
      }
      active -= 1;
      return MP4;
    });
    enqueueSequenceStitch(seeded.sequenceId, seeded.batchIds[1]);
    await started;
    for (let index = 0; index < 8; index++) {
      enqueueSequenceStitch(seeded.sequenceId, seeded.batchIds[1]);
    }
    releaseFirst();
    await waitForStitchQueueIdle();
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  test('defers a stale rerun while an appended tail is queued, then stitches after completion', async () => {
    const runtime = testRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    setSequenceStitchRunnerForTests(() => Promise.resolve(new Uint8Array([1])));
    enqueueSequenceStitch(seeded.sequenceId, seeded.batchIds[1]);
    await waitForStitchQueueIdle();

    let release: () => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    setSequenceStitchRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) {
        signalStarted();
        await gate;
      }
      return new Uint8Array([calls + 1]);
    });
    enqueueSequenceStitch(seeded.sequenceId, seeded.batchIds[1]);
    await started;
    const tail = appendQueuedTail(runtime.db, seeded.sequenceId, seeded.batchIds[1]);
    expect(runtime.db.query('SELECT master_status FROM video_sequences WHERE id = ?').get(seeded.sequenceId)).toEqual({ master_status: 'stitching' });
    release();
    await waitForStitchQueueIdle();

    expect(runtime.db.query<{ master_status: string }, [string]>(
      'SELECT master_status FROM video_sequences WHERE id = ?',
    ).get(seeded.sequenceId)?.master_status).toBe('ready');
    expect(await plaintextOf('alice', `${runtime.config.DATA_DIR}/images/alice/${seeded.sequenceId}.mp4`)).toEqual(new Uint8Array([1]));
    expect(runtime.db.query('SELECT stitch_pending FROM video_sequences WHERE id = ?').get(seeded.sequenceId)).toEqual({ stitch_pending: 1 });
    expect(calls).toBe(1);

    runtime.db.query("UPDATE batches SET status = 'done' WHERE id = ?").run(tail.batchId);
    runtime.db.query(
      `UPDATE tiles
          SET status = 'done', ext = 'mp4', mime = 'video/mp4', completed_at = 4
        WHERE id = ?`,
    ).run(tail.tileId);
    await writeAtomic(
      runtime.config.DATA_DIR,
      'images',
      'alice',
      tail.tileId,
      'mp4',
      MP4,
    );
    settleSequenceAfterBatchTerminal(
      runtime.db,
      runtime.config,
      runtime.logger,
      tail.batchId,
      true,
    );
    await waitForStitchQueueIdle();

    expect(calls).toBe(2);
    expect(runtime.db.query<{ master_status: string; count: number }, [string]>(
      `SELECT s.master_status, COUNT(b.id) AS count
         FROM video_sequences s JOIN batches b ON b.sequence_id = s.id
        WHERE s.id = ? GROUP BY s.id`,
    ).get(seeded.sequenceId)).toEqual({ master_status: 'ready', count: 3 });
  });

  test('canceling an in-flight tail enqueues a restitch for the surviving segments', async () => {
    const runtime = testRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const tail = appendQueuedTail(runtime.db, seeded.sequenceId, seeded.batchIds[1]);
    let calls = 0;
    setSequenceStitchRunnerForTests(() => {
      calls += 1;
      return Promise.resolve(MP4);
    });

    settleSequenceAfterBatchTerminal(
      runtime.db,
      runtime.config,
      runtime.logger,
      tail.batchId,
      false,
    );
    await waitForStitchQueueIdle();

    expect(calls).toBe(1);
    expect(runtime.db.query<{ sequence_id: string | null }, [string]>(
      'SELECT sequence_id FROM batches WHERE id = ?',
    ).get(tail.batchId)?.sequence_id).toBeNull();
    expect(runtime.db.query<{ master_status: string; count: number }, [string]>(
      `SELECT s.master_status, COUNT(b.id) AS count
         FROM video_sequences s JOIN batches b ON b.sequence_id = s.id
        WHERE s.id = ? GROUP BY s.id`,
    ).get(seeded.sequenceId)).toEqual({ master_status: 'ready', count: 2 });
  });
});

test('enqueue before a queued tail arrives keeps the previous master ready through FIFO deferral', async () => {
  const runtime = testRuntime();
  const active = await seedSequence(runtime.db, runtime.config.DATA_DIR);
  const waiting = await seedSequence(runtime.db, runtime.config.DATA_DIR);
  markReady(runtime.db, waiting.sequenceId, 2, 20);
  await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', waiting.sequenceId, 'mp4', MP4);
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  setSequenceStitchRunnerForTests(async () => { calls++; started(); await gate; return MP4; });
  enqueueSequenceStitch(active.sequenceId);
  await running;
  try {
    enqueueSequenceStitch(waiting.sequenceId);
    appendQueuedTail(runtime.db, waiting.sequenceId, waiting.batchIds[1]);
    expect(runtime.db.query('SELECT master_status, master_revision, master_updated_at, stitch_pending FROM video_sequences WHERE id = ?').get(waiting.sequenceId))
      .toEqual({ master_status: 'ready', master_revision: 2, master_updated_at: 20, stitch_pending: 1 });
  } finally { release(); }
  await waitForStitchQueueIdle();
  expect(calls).toBe(1);
  expect(runtime.db.query('SELECT master_status, stitch_pending FROM video_sequences WHERE id = ?').get(waiting.sequenceId))
    .toEqual({ master_status: 'ready', stitch_pending: 1 });
  expect(await plaintextOf('alice', `${runtime.config.DATA_DIR}/images/alice/${waiting.sequenceId}.mp4`)).toEqual(MP4);
});

test('an interrupted active publication stays guarded when recovery first defers for a queued tail', async () => {
  const runtime = testRuntime({ COMFYUI_BASE_URL: 'http://127.0.0.1:1', VIDEO_MODELS_ENABLED: 'true', LOCAL_MODELS_USERS: 'alice' });
  const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
  markReady(runtime.db, seeded.sequenceId, 2, 20);
  // A crash after candidate rename can leave new bytes under the old DB
  // publication identity. Neither enqueue nor a deferred run may expose them.
  await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', seeded.sequenceId, 'mp4', new Uint8Array([9]));
  runtime.db.query("UPDATE video_sequences SET master_status = 'stitching' WHERE id = ?").run(seeded.sequenceId);
  appendQueuedTail(runtime.db, seeded.sequenceId, seeded.batchIds[1]);
  let calls = 0;
  setSequenceStitchRunnerForTests(() => { calls++; return Promise.resolve(MP4); });
  enqueueSequenceStitch(seeded.sequenceId);
  await waitForStitchQueueIdle();
  expect(calls).toBe(0);
  expect(runtime.db.query('SELECT master_status, master_updated_at, stitch_pending FROM video_sequences WHERE id = ?').get(seeded.sequenceId))
    .toEqual({ master_status: 'stitching', master_updated_at: 20, stitch_pending: 1 });
  expect((await runtime.app.fetch(new Request(`http://local/api/sequences/${seeded.sequenceId}/master`, { headers: { 'Remote-User': 'alice' } }))).status).toBe(404);
});
