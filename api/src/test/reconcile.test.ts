import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rebuildQueueFromDb, startupReconcile } from '../lifecycle/startup-reconcile';
import * as queue from '../orchestrator/queue';
import { adoptStandaloneBatch, appendSegment, markFailed, markReady } from '../db/sequences';
import { testRuntime } from './helpers';

interface ReconcileSequenceFixture {
  readonly sequenceId: string;
  readonly batchIds: readonly string[];
  readonly tileIds: readonly string[];
  readonly masterPath: string;
}

function seedReconcileSequence(
  db: Database,
  dataDir: string,
  missingArtifactIndex: number,
): ReconcileSequenceFixture {
  const userId = 'u';
  const imageDir = join(dataDir, 'images', userId);
  const batchIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  const tileIds = Array.from({ length: 3 }, () => crypto.randomUUID());
  mkdirSync(imageDir, { recursive: true });
  db.query('INSERT INTO users (id, created_at) VALUES (?, 1)').run(userId);
  const insertBatch = db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
     VALUES (?, ?, ?, '16:9', 'minimax-h3-i2v', 'MiniMax H3', ?, 'done', 'local', 124)`,
  );
  const insertTile = db.query(
    `INSERT INTO tiles
      (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
     VALUES (?, ?, ?, 0, 1, 'done', 'mp4', 'video/mp4', 1)`,
  );
  for (let index = 0; index < 3; index++) {
    const batchId = batchIds[index];
    const tileId = tileIds[index];
    if (!batchId || !tileId) throw new Error('missing reconcile sequence fixture id');
    insertBatch.run(batchId, userId, `segment ${index}`, index + 1);
    insertTile.run(tileId, batchId, userId);
    if (index !== missingArtifactIndex) writeFileSync(join(imageDir, `${tileId}.mp4`), 'segment');
  }
  const firstBatchId = batchIds[0];
  if (!firstBatchId) throw new Error('missing first reconcile sequence batch');
  const adopted = adoptStandaloneBatch(db, userId, firstBatchId, 10);
  if (adopted.status !== 'ok') throw new Error('expected reconcile sequence adoption');
  let tailBatchId = firstBatchId;
  for (const batchId of batchIds.slice(1)) {
    const appended = appendSegment(db, { error: () => undefined }, userId, adopted.sequenceId, tailBatchId, batchId);
    if (appended.status !== 'ok') throw new Error('expected reconcile sequence append');
    tailBatchId = batchId;
  }
  const masterPath = join(imageDir, `${adopted.sequenceId}.mp4`);
  writeFileSync(masterPath, 'master');
  return { sequenceId: adopted.sequenceId, batchIds, tileIds, masterPath };
}

describe('startup reconciliation', () => {
  test('an append after a failed master recovers when its tail completes before enqueue', () => {
    const { db, config, logger } = testRuntime();
    const seeded = seedReconcileSequence(db, config.DATA_DIR, -1);
    expect(markReady(db, seeded.sequenceId, 3, 1)).toBe(true);
    expect(markFailed(db, seeded.sequenceId, 3, 'sequence stitch failed')).toBe(true);
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    db.query(`INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
      VALUES (?, 'u', 'new tail', '16:9', 'minimax-h3-i2v', 'MiniMax H3', 4, 'queued', 'local', 124)`).run(batchId);
    db.query(`INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
      VALUES (?, ?, 'u', 0, 1, 'loading')`).run(tileId, batchId);
    const tail = seeded.batchIds[2];
    if (!tail) throw new Error('missing original tail');
    expect(appendSegment(db, logger, 'u', seeded.sequenceId, tail, batchId).status).toBe('ok');
    expect(db.query('SELECT master_status, master_error FROM video_sequences WHERE id = ?').get(seeded.sequenceId))
      .toEqual({ master_status: 'idle', master_error: null });
    // Simulate accepted terminal rows and a crash before the lifecycle enqueue.
    writeFileSync(join(config.DATA_DIR, 'images', 'u', `${tileId}.mp4`), 'new segment');
    db.query("UPDATE tiles SET status = 'done', ext = 'mp4', mime = 'video/mp4', completed_at = 2 WHERE id = ?").run(tileId);
    db.query("UPDATE batches SET status = 'done' WHERE id = ?").run(batchId);
    const enqueued: string[] = [];
    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: 1, force: false, dbIntegrityOk: true,
      enqueueSequenceStitch: (id) => { enqueued.push(id); },
    });
    expect(enqueued).toEqual([seeded.sequenceId]);
    expect(db.query('SELECT master_status, master_revision, stitch_revision FROM video_sequences WHERE id = ?').get(seeded.sequenceId))
      .toEqual({ master_status: 'idle', master_revision: 3, stitch_revision: 4 });
  });

  for (const state of ['idle', 'legacy-ready', 'stale-ready', 'current-ready', 'failed', 'queued-tail', 'pending-current-ready', 'pending-queued-tail', 'interrupted-ready'] as const) {
    test(`recovers only eligible unpublished topology: ${state}`, () => {
      const { db, config, logger } = testRuntime();
      const seeded = seedReconcileSequence(db, config.DATA_DIR, -1);
      const status = state === 'idle' ? 'idle' : state === 'failed' ? 'failed' : state === 'interrupted-ready' ? 'stitching' : 'ready';
      const currentRevision = db.query<{ stitch_revision: number }, [string]>(
        'SELECT stitch_revision FROM video_sequences WHERE id = ?',
      ).get(seeded.sequenceId)?.stitch_revision;
      if (currentRevision === undefined) throw new Error('missing sequence revision');
      const published = state === 'legacy-ready' || state === 'idle' ? null
        : ['current-ready', 'pending-current-ready', 'pending-queued-tail', 'interrupted-ready'].includes(state) ? currentRevision : currentRevision - 1;
      db.query('UPDATE video_sequences SET master_status = ?, master_updated_at = 1, master_revision = ? WHERE id = ?')
        .run(status, published, seeded.sequenceId);
      if (state.startsWith('pending-')) db.query('UPDATE video_sequences SET stitch_pending = 1 WHERE id = ?').run(seeded.sequenceId);
      if (state === 'queued-tail' || state === 'pending-queued-tail') {
        db.query("UPDATE batches SET status = 'queued' WHERE id = ?").run(seeded.batchIds[2] ?? '');
        db.query("UPDATE tiles SET status = 'loading', ext = NULL, mime = NULL WHERE id = ?").run(seeded.tileIds[2] ?? '');
        unlinkSync(join(config.DATA_DIR, 'images', 'u', `${seeded.tileIds[2]}.mp4`));
      }
      const enqueued: string[] = [];
      startupReconcile(db, config.DATA_DIR, logger, {
        uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: 1, force: false, dbIntegrityOk: true,
        enqueueSequenceStitch: (id) => { enqueued.push(id); },
      });
      const recover = ['idle', 'legacy-ready', 'stale-ready', 'pending-current-ready', 'pending-queued-tail', 'interrupted-ready'].includes(state);
      expect(enqueued).toEqual(recover ? [seeded.sequenceId] : []);
      expect(db.query<{ master_status: string }, [string]>('SELECT master_status FROM video_sequences WHERE id = ?')
        .get(seeded.sequenceId)?.master_status).toBe(status);
      expect(db.query<{ stitch_pending: number }, [string]>('SELECT stitch_pending FROM video_sequences WHERE id = ?').get(seeded.sequenceId)?.stitch_pending).toBe(recover ? 1 : 0);
      expect(existsSync(seeded.masterPath)).toBe(true);
    });
  }

  test('recovers stitching and missing-ready sequence masters and reaps stale stitch tmp files', () => {
    const { db, config, logger } = testRuntime();
    const userId = 'u';
    const imageDir = join(config.DATA_DIR, 'images', userId);
    mkdirSync(imageDir, { recursive: true });
    db.query('INSERT INTO users (id, created_at) VALUES (?, 1)').run(userId);
    const sequenceIds: string[] = [];
    for (let sequenceIndex = 0; sequenceIndex < 2; sequenceIndex++) {
      const batches = [crypto.randomUUID(), crypto.randomUUID()] as const;
      const tiles = [crypto.randomUUID(), crypto.randomUUID()] as const;
      for (let index = 0; index < 2; index++) {
        const batchId = batches[index];
        const tileId = tiles[index];
        if (!batchId || !tileId) throw new Error('missing startup fixture segment');
        db.query(
          `INSERT INTO batches
            (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
           VALUES (?, ?, ?, '16:9', 'minimax-h3-i2v', 'MiniMax H3', ?, 'done', 'local', 124)`,
        ).run(batchId, userId, `sequence ${sequenceIndex} segment ${index}`, 10 + sequenceIndex * 2 + index);
        db.query(
          `INSERT INTO tiles
            (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
           VALUES (?, ?, ?, 0, 1, 'done', 'mp4', 'video/mp4', 1)`,
        ).run(tileId, batchId, userId);
        writeFileSync(join(imageDir, `${tileId}.mp4`), 'segment');
      }
      const adopted = adoptStandaloneBatch(db, userId, batches[0], 20 + sequenceIndex);
      if (adopted.status !== 'ok') throw new Error('expected startup fixture adoption');
      const appended = appendSegment(
        db,
        logger,
        userId,
        adopted.sequenceId,
        batches[0],
        batches[1],
        30 + sequenceIndex,
      );
      if (appended.status !== 'ok') throw new Error('expected startup fixture append');
      sequenceIds.push(adopted.sequenceId);
    }
    const stitchingId = sequenceIds[0];
    const missingReadyId = sequenceIds[1];
    if (!stitchingId || !missingReadyId) throw new Error('missing startup fixture sequence');
    db.query("UPDATE video_sequences SET master_status = 'stitching' WHERE id = ?").run(stitchingId);
    db.query("UPDATE video_sequences SET master_status = 'ready' WHERE id = ?").run(missingReadyId);
    const stitchingMaster = join(imageDir, `${stitchingId}.mp4`);
    const stitchTmp = `${stitchingMaster}.tmp`;
    writeFileSync(stitchingMaster, 'master');
    writeFileSync(stitchTmp, 'stale tmp');
    const enqueued: string[] = [];

    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS,
      orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
      force: true,
      dbIntegrityOk: true,
      enqueueSequenceStitch: (sequenceId) => { enqueued.push(sequenceId); },
    });

    expect(new Set(enqueued)).toEqual(new Set([stitchingId, missingReadyId]));
    expect(existsSync(stitchTmp)).toBe(false);
    expect(existsSync(stitchingMaster)).toBe(true);

    writeFileSync(stitchTmp, 'keep while integrity is damaged');
    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS,
      orphanThreshold: 1,
      force: false,
      dbIntegrityOk: false,
      enqueueSequenceStitch: () => undefined,
    });
    expect(existsSync(stitchTmp)).toBe(true);
    expect(existsSync(stitchingMaster)).toBe(true);
  });

  test('dissolves a sequence when a middle segment artifact is missing', () => {
    const { db, config, logger } = testRuntime();
    const seeded = seedReconcileSequence(db, config.DATA_DIR, 1);

    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS,
      orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
      force: true,
      dbIntegrityOk: true,
      enqueueSequenceStitch: () => undefined,
    });

    expect(db.query('SELECT id FROM video_sequences WHERE id = ?').get(seeded.sequenceId))
      .toBeNull();
    expect(db.query<{ count: number }, [string, string, string]>(
      'SELECT COUNT(*) AS count FROM batches WHERE sequence_id IS NOT NULL AND id IN (?, ?, ?)',
    ).get(
      seeded.batchIds[0] ?? '',
      seeded.batchIds[1] ?? '',
      seeded.batchIds[2] ?? '',
    )?.count).toBe(0);
    expect(db.query<{ status: string }, [string]>(
      'SELECT status FROM tiles WHERE id = ?',
    ).get(seeded.tileIds[1] ?? '')?.status).toBe('failed');
    expect(existsSync(seeded.masterPath)).toBe(false);
  });

  test('unlinks a missing tail artifact and enqueues a restitch for the remaining sequence', () => {
    const { db, config, logger } = testRuntime();
    const seeded = seedReconcileSequence(db, config.DATA_DIR, 2);
    const enqueued: string[] = [];

    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS,
      orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
      force: true,
      dbIntegrityOk: true,
      enqueueSequenceStitch: (sequenceId) => { enqueued.push(sequenceId); },
    });

    expect(enqueued).toEqual([seeded.sequenceId]);
    expect(db.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM batches WHERE sequence_id = ?',
    ).get(seeded.sequenceId)?.count).toBe(2);
    expect(db.query<{ sequence_id: string | null }, [string]>(
      'SELECT sequence_id FROM batches WHERE id = ?',
    ).get(seeded.batchIds[2] ?? '')?.sequence_id).toBeNull();
    expect(existsSync(seeded.masterPath)).toBe(true);
  });

  test('fails stale loading rows, preserves terminal rows, and reaps tmp/final orphans', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const batchId = crypto.randomUUID();
    const loading = crypto.randomUUID();
    const done = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u', now);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(batchId, 'u', 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(loading, batchId, 'u', 0, 1, 'loading');
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(done, batchId, 'u', 1, 2, 'done', 'png', 'image/png', now);
    const root = join(config.DATA_DIR, 'images');
    const dir = join(root, 'u');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${loading}.png.tmp`), 'tmp');
    writeFileSync(join(dir, `${done}.png`), 'done');
    const orphan = join(dir, `${crypto.randomUUID()}.png`);
    const looseOrphan = join(root, `${crypto.randomUUID()}.png`);
    writeFileSync(orphan, 'orphan');
    writeFileSync(looseOrphan, 'loose orphan');
    // Fixture has 1 known + 3 orphans → ratio 0.75 triggers the orphan-threshold
    // guard (defaults to 0.5). `force: true` bypasses it; the guard itself is
    // exercised separately in the test below.
    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: true, dbIntegrityOk: true });
    expect(db.query<{ status: string; error: string }, [string]>('SELECT status, error FROM tiles WHERE id = ?').get(loading))
      .toEqual({ status: 'failed', error: 'interrupted' });
    expect(db.query<{ status: string }, [string]>('SELECT status FROM tiles WHERE id = ?').get(done)?.status).toBe('done');
    expect(existsSync(join(dir, `${loading}.png.tmp`))).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(looseOrphan)).toBe(false);
    expect(existsSync(join(dir, `${done}.png`))).toBe(true);
  });

  // Regression: a damaged DB can under-return the keep-set, so artifacts whose
  // rows are unreadable look like orphans. The ratio guard cannot catch it —
  // a few rows lost to one corrupt page sit far under the threshold — so a
  // failed integrity check has to refuse the unlink outright.
  test('refuses to unlink orphans when the boot integrity check failed', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const batchId = crypto.randomUUID();
    const done = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u', now);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(batchId, 'u', 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(done, batchId, 'u', 0, 1, 'done', 'png', 'image/png', now);
    const dir = join(config.DATA_DIR, 'images', 'u');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${done}.png`), 'done');
    // Stands in for a real image whose tiles row the corruption made unreadable:
    // one orphan against one known row is a 0.5 ratio, at/below the default
    // threshold, so the existing guard would happily delete it.
    const looksOrphaned = join(dir, `${crypto.randomUUID()}.png`);
    writeFileSync(looksOrphaned, 'real user image');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: false, dbIntegrityOk: false });

    expect(existsSync(looksOrphaned)).toBe(true);
    expect(existsSync(join(dir, `${done}.png`))).toBe(true);
  });

  test('still unlinks orphans on a healthy DB (control for the integrity refusal)', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const batchId = crypto.randomUUID();
    const done = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u', now);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(batchId, 'u', 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(done, batchId, 'u', 0, 1, 'done', 'png', 'image/png', now);
    const dir = join(config.DATA_DIR, 'images', 'u');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${done}.png`), 'done');
    const orphan = join(dir, `${crypto.randomUUID()}.png`);
    writeFileSync(orphan, 'orphan');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: false, dbIntegrityOk: true });

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(dir, `${done}.png`))).toBe(true);
  });

  test('preserves done mp4 artifacts and reaps orphan mp4 artifacts', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const batchId = crypto.randomUUID();
    const done = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u', now);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(batchId, 'u', 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(done, batchId, 'u', 0, 1, 'done', 'mp4', 'video/mp4', now);
    const dir = join(config.DATA_DIR, 'images', 'u');
    mkdirSync(dir, { recursive: true });
    const donePath = join(dir, `${done}.mp4`);
    const orphanPath = join(dir, `${crypto.randomUUID()}.mp4`);
    writeFileSync(donePath, 'done');
    writeFileSync(orphanPath, 'orphan');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: true, dbIntegrityOk: true });

    expect(existsSync(donePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
  });

  test('preserves queued batches, rebuilds queue memory, and marks interrupted running batches done', () => {
    queue.resetQueueForTests();
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const queuedBatch = crypto.randomUUID();
    const queuedTile = crypto.randomUUID();
    const runningBatch = crypto.randomUUID();
    const runningTile = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u', now);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'shared')`,
    ).run(queuedBatch, 'u', 'queued', '1:1', 'mock-slow', 'Mock Slow', now);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 'shared')`,
    ).run(runningBatch, 'u', 'running', '1:1', 'mock-slow', 'Mock Slow', now + 1);
    db.query("INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, 0, 1, 'loading')")
      .run(queuedTile, queuedBatch, 'u');
    db.query("INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, 0, 2, 'loading')")
      .run(runningTile, runningBatch, 'u');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: true, dbIntegrityOk: true });

    expect(db.query<{ status: string }, [string]>('SELECT status FROM tiles WHERE id = ?').get(queuedTile)?.status).toBe('loading');
    expect(db.query<{ status: string }, [string]>('SELECT status FROM batches WHERE id = ?').get(queuedBatch)?.status).toBe('queued');
    expect(queue.positionOf('shared', queuedBatch)).toBe(0);
    expect(db.query<{ status: string; error: string }, [string]>('SELECT status, error FROM tiles WHERE id = ?').get(runningTile))
      .toEqual({ status: 'failed', error: 'interrupted' });
    expect(db.query<{ status: string }, [string]>('SELECT status FROM batches WHERE id = ?').get(runningBatch)?.status).toBe('done');
  });

  test('queue rebuild wrapper logs and continues when rebuildFromDb throws', () => {
    const logs: string[] = [];
    const logger = {
      error: (payload: unknown) => { logs.push(JSON.stringify(payload)); },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      fatal: () => undefined,
      child: () => logger,
    };

    rebuildQueueFromDb({} as never, logger as never);

    expect(logs.join('')).toContain('queue_rebuild_failed');
  });

  test('purges archived rows older than 30 days and removes artifacts', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const expiredAt = now - 31 * 24 * 60 * 60 * 1000;
    const freshAt = now - 29 * 24 * 60 * 60 * 1000;
    const expiredBatch = crypto.randomUUID();
    const freshBatch = crypto.randomUUID();
    const expiredTile = crypto.randomUUID();
    const freshTile = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u', now);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(expiredBatch, 'u', 'old', '1:1', 'mock-fast', 'Mock Fast', now, expiredAt);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(freshBatch, 'u', 'fresh', '1:1', 'mock-fast', 'Mock Fast', now, freshAt);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(expiredTile, expiredBatch, 'u', 0, 1, 'done', 'png', 'image/png', now, expiredAt);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(freshTile, freshBatch, 'u', 0, 2, 'done', 'png', 'image/png', now, freshAt);
    const dir = join(config.DATA_DIR, 'images', 'u');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${expiredTile}.png`), 'old');
    writeFileSync(join(dir, `${freshTile}.png`), 'fresh');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: true, dbIntegrityOk: true });

    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(expiredTile)).toBeNull();
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(expiredBatch)).toBeNull();
    expect(existsSync(join(dir, `${expiredTile}.png`))).toBe(false);
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(freshTile)).toBeTruthy();
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(freshBatch)).toBeTruthy();
    expect(existsSync(join(dir, `${freshTile}.png`))).toBe(true);
  });

  test('reaps orphan upload artifacts at boot', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const userId = 'u';
    const uploadId = crypto.randomUUID();
    const orphanUpload = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, 'sha', ?)",
    ).run(uploadId, userId, now);
    const dir = join(config.DATA_DIR, 'uploads', userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${uploadId}.png`), 'upload');
    const orphan = join(dir, `${orphanUpload}.png`);
    writeFileSync(orphan, 'orphan');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: config.RECONCILE_FORCE, dbIntegrityOk: true });

    expect(existsSync(join(dir, `${uploadId}.png`))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(uploadId)).toBeTruthy();
  });

  test('deletes upload rows whose backing files are missing at boot', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const userId = 'u';
    const missingUpload = crypto.randomUUID();
    const presentUpload = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    const insertUpload = db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, ?, ?)",
    );
    insertUpload.run(missingUpload, userId, 'missing-sha', now);
    insertUpload.run(presentUpload, userId, 'present-sha', now);
    const dir = join(config.DATA_DIR, 'uploads', userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${presentUpload}.png`), 'upload');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: config.RECONCILE_FORCE, dbIntegrityOk: true });

    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(missingUpload)).toBeNull();
    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(presentUpload)).toBeTruthy();
    expect(existsSync(join(dir, `${presentUpload}.png`))).toBe(true);
  });

  test('skips missing upload rows for users whose uploads dir is absent', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const presentUser = 'present-user';
    const absentUser = 'absent-user';
    const presentUpload = crypto.randomUUID();
    const absentUpload = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?), (?, ?)').run(presentUser, now, absentUser, now);
    const insertUpload = db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, ?, ?)",
    );
    insertUpload.run(presentUpload, presentUser, 'present-sha', now);
    insertUpload.run(absentUpload, absentUser, 'absent-sha', now);
    const dir = join(config.DATA_DIR, 'uploads', presentUser);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${presentUpload}.png`), 'upload');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: false, dbIntegrityOk: true });

    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(presentUpload)).toBeTruthy();
    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(absentUpload)).toBeTruthy();
  });

  test('upload missing-artifact ratio guard refuses bulk deletion without force', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const userId = 'u';
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    const insertUpload = db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, ?, ?)",
    );
    const present = crypto.randomUUID();
    const missing = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    insertUpload.run(present, userId, 'present-sha', now);
    for (const id of missing) insertUpload.run(id, userId, `sha-${id}`, now);
    const dir = join(config.DATA_DIR, 'uploads', userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${present}.png`), 'upload');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: false, dbIntegrityOk: true });

    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(present)).toBeTruthy();
    for (const id of missing) expect(db.query('SELECT id FROM uploads WHERE id = ?').get(id)).toBeTruthy();
  });

  test('upload missing-artifact ratio guard deletes missing rows under force', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const userId = 'u';
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    const insertUpload = db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, ?, ?)",
    );
    const present = crypto.randomUUID();
    const missing = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    insertUpload.run(present, userId, 'present-sha', now);
    for (const id of missing) insertUpload.run(id, userId, `sha-${id}`, now);
    const dir = join(config.DATA_DIR, 'uploads', userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${present}.png`), 'upload');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: true, dbIntegrityOk: true });

    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(present)).toBeTruthy();
    for (const id of missing) expect(db.query('SELECT id FROM uploads WHERE id = ?').get(id)).toBeNull();
  });

  test('clears provenance for referenced upload rows whose backing files are missing at boot', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const userId = 'u';
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    const missingUpload = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, 0, 0, 'loading')",
    ).run(tileId, batchId, userId);
    db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, 'sha', ?)",
    ).run(missingUpload, userId, now);
    db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, 0)').run(tileId, missingUpload);
    mkdirSync(join(config.DATA_DIR, 'uploads', userId), { recursive: true });

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: true, dbIntegrityOk: true });

    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(missingUpload)).toBeNull();
    expect(db.query('SELECT upload_id FROM tile_ref_images WHERE upload_id = ?').get(missingUpload)).toBeNull();
  });

  test('nulls a done batch i2v_source_upload_id when the source-still upload is missing at boot', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const userId = 'u';
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    const missingSource = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    // A terminal (done) I2V batch pointing at its source-still upload. batches
    // has no FK on i2v_source_upload_id, so the reconcile must null it itself —
    // queuedBatchesReferencingUploads only covers QUEUED batches, not this one.
    db.query(
      "INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, i2v_source_upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?)",
    ).run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now, missingSource);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, 0, 0, 'done', 'mp4', 'video/mp4', ?)",
    ).run(tileId, batchId, userId, now);
    db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, 'sha', ?)",
    ).run(missingSource, userId, now);
    // The done tile's artifact is present (so the images-mount guard passes);
    // only the source-still UPLOAD's backing file is missing → reaped under force.
    const imagesDir = join(config.DATA_DIR, 'images', userId);
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, `${tileId}.mp4`), 'clip');
    mkdirSync(join(config.DATA_DIR, 'uploads', userId), { recursive: true });

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: true, dbIntegrityOk: true });

    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(missingSource)).toBeNull();
    // The dangling, wire-exposed pointer is cleared (no client 404 veiling the frame).
    expect(
      db.query<{ i2v_source_upload_id: string | null }, [string]>('SELECT i2v_source_upload_id FROM batches WHERE id = ?').get(batchId)?.i2v_source_upload_id,
    ).toBeNull();
    // The done tile is untouched.
    expect(db.query<{ status: string }, [string]>('SELECT status FROM tiles WHERE id = ?').get(tileId)?.status).toBe('done');
  });

  test('fails queued batches whose referenced upload artifacts are missing at boot', () => {
    queue.resetQueueForTests();
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const userId = 'u';
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    const missingUpload = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'shared')`,
    ).run(batchId, userId, 'p', '1:1', 'mock-slow', 'Mock Slow', now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, 0, 0, 'loading')",
    ).run(tileId, batchId, userId);
    db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, 'sha', ?)",
    ).run(missingUpload, userId, now);
    db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, 0)').run(tileId, missingUpload);
    mkdirSync(join(config.DATA_DIR, 'uploads', userId), { recursive: true });

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: true, dbIntegrityOk: true });

    expect(db.query<{ status: string }, [string]>('SELECT status FROM batches WHERE id = ?').get(batchId)?.status).toBe('done');
    expect(db.query<{ status: string; error: string | null }, [string]>('SELECT status, error FROM tiles WHERE id = ?').get(tileId))
      .toEqual({ status: 'failed', error: 'internal error' });
    expect(queue.__queueTest.lengthOf('shared')).toBe(0);
  });

  test('chunks queued-batch upload reference lookup beyond SQLite parameter limit', () => {
    queue.resetQueueForTests();
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const userId = 'u';
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'shared')`,
    ).run(batchId, userId, 'p', '1:1', 'mock-slow', 'Mock Slow', now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, 0, 0, 'loading')",
    ).run(tileId, batchId, userId);
    const insertUpload = db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, ?, ?)",
    );
    for (let i = 0; i < 520; i += 1) {
      const uploadId = crypto.randomUUID();
      insertUpload.run(uploadId, userId, `sha-${i}`, now);
      if (i === 519) db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, 0)').run(tileId, uploadId);
    }
    mkdirSync(join(config.DATA_DIR, 'uploads', userId), { recursive: true });

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: 1, force: false, dbIntegrityOk: true });

    expect(db.query<{ status: string; error: string | null }, [string]>('SELECT status, error FROM tiles WHERE id = ?').get(tileId))
      .toEqual({ status: 'failed', error: 'internal error' });
  });

  test('reaps expired unreferenced uploads but preserves referenced and recent uploads', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const old = now - 10_000;
    const recent = now;
    const userId = 'u';
    const expired = crypto.randomUUID();
    const referenced = crypto.randomUUID();
    const sourceReferenced = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, 0, 0, 'loading')",
    ).run(tileId, batchId, userId);
    const insertUpload = db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, ?, ?)",
    );
    insertUpload.run(expired, userId, 'expired-sha', old);
    insertUpload.run(referenced, userId, 'referenced-sha', old);
    insertUpload.run(sourceReferenced, userId, 'source-referenced-sha', old);
    insertUpload.run(fresh, userId, 'fresh-sha', recent);
    db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, 0)').run(tileId, referenced);
    db.query('UPDATE batches SET i2v_source_upload_id = ? WHERE id = ?').run(sourceReferenced, batchId);
    const dir = join(config.DATA_DIR, 'uploads', userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${expired}.png`), 'expired');
    writeFileSync(join(dir, `${referenced}.png`), 'referenced');
    writeFileSync(join(dir, `${sourceReferenced}.png`), 'source-referenced');
    writeFileSync(join(dir, `${fresh}.png`), 'fresh');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: 5_000, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: config.RECONCILE_FORCE, dbIntegrityOk: true });

    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(expired)).toBeNull();
    expect(existsSync(join(dir, `${expired}.png`))).toBe(false);
    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(referenced)).toBeTruthy();
    expect(existsSync(join(dir, `${referenced}.png`))).toBe(true);
    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(sourceReferenced)).toBeTruthy();
    expect(existsSync(join(dir, `${sourceReferenced}.png`))).toBe(true);
    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(fresh)).toBeTruthy();
    expect(existsSync(join(dir, `${fresh}.png`))).toBe(true);
  });

  test('orphan-threshold guard refuses to mass-unlink when ratio exceeds 0.5', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const userId = 'u';
    const batchId = crypto.randomUUID();
    const knownTile = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(knownTile, batchId, userId, 0, 1, 'done', 'png', 'image/png', now);
    const dir = join(config.DATA_DIR, 'images', userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${knownTile}.png`), 'known');
    // Seed 5 orphans: 1 known + 5 orphans → ratio 5/6 > 0.5 → guard refuses.
    const orphanPaths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const path = join(dir, `${crypto.randomUUID()}.png`);
      writeFileSync(path, 'orphan');
      orphanPaths.push(path);
    }

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: false, dbIntegrityOk: true });

    expect(existsSync(join(dir, `${knownTile}.png`))).toBe(true);
    // None of the orphans were unlinked — the guard caught it.
    for (const path of orphanPaths) expect(existsSync(path)).toBe(true);
  });
});
