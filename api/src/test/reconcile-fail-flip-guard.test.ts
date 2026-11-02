import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startupReconcile } from '../lifecycle/startup-reconcile';
import { testRuntime } from './helpers';

function seedUser(db: ReturnType<typeof testRuntime>['db'], userId: string, now: number): string {
  db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  const batchId = crypto.randomUUID();
  db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
  return batchId;
}

function seedDoneTile(
  db: ReturnType<typeof testRuntime>['db'],
  batchId: string,
  userId: string,
  index: number,
  now: number,
): string {
  const id = crypto.randomUUID();
  db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, batchId, userId, index, index + 1, 'done', 'png', 'image/png', now);
  return id;
}

function statusOf(db: ReturnType<typeof testRuntime>['db'], id: string): { status: string; error: string | null } {
  return db
    .query<{ status: string; error: string | null }, [string]>('SELECT status, error FROM tiles WHERE id = ?')
    .get(id) as { status: string; error: string | null };
}

describe('startup reconciliation — missing-artifact fail-flip guards', () => {
  test('refuses bulk tombstone when missing ratio exceeds threshold (partial mount)', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const batchId = seedUser(db, 'u', now);
    const present = seedDoneTile(db, batchId, 'u', 0, now);
    const missing = [1, 2, 3].map((i) => seedDoneTile(db, batchId, 'u', i, now));
    const dir = join(config.DATA_DIR, 'images', 'u');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${present}.png`), 'present');

    // 3 missing / 4 done = 0.75 > 0.5 threshold → guard trips, nothing flips.
    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS,
      orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
      force: config.RECONCILE_FORCE,
      dbIntegrityOk: true,
    });

    expect(statusOf(db, present)).toEqual({ status: 'done', error: null });
    for (const id of missing) expect(statusOf(db, id)).toEqual({ status: 'done', error: null });
  });

  test('RECONCILE_FORCE=true bypasses the ratio guard and flips missing rows', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const batchId = seedUser(db, 'u', now);
    const present = seedDoneTile(db, batchId, 'u', 0, now);
    const missing = [1, 2, 3].map((i) => seedDoneTile(db, batchId, 'u', i, now));
    const dir = join(config.DATA_DIR, 'images', 'u');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${present}.png`), 'present');

    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS,
      orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
      force: true,
      dbIntegrityOk: true,
    });

    expect(statusOf(db, present)).toEqual({ status: 'done', error: null });
    for (const id of missing) expect(statusOf(db, id)).toEqual({ status: 'failed', error: 'internal error' });
  });

  test('skips fail-flip for a user whose whole images dir is absent (per-user mount anomaly)', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    // User u is healthy (dir + file present) so images/ exists and the whole-root
    // guard does not fire; user v's dir is entirely absent.
    const batchU = seedUser(db, 'u', now);
    const presentU = seedDoneTile(db, batchU, 'u', 0, now);
    const batchV = seedUser(db, 'v', now);
    const rowsV = [0, 1].map((i) => seedDoneTile(db, batchV, 'v', i, now));
    const dirU = join(config.DATA_DIR, 'images', 'u');
    mkdirSync(dirU, { recursive: true });
    writeFileSync(join(dirU, `${presentU}.png`), 'present');

    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS,
      orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
      force: config.RECONCILE_FORCE,
      dbIntegrityOk: true,
    });

    expect(statusOf(db, presentU)).toEqual({ status: 'done', error: null });
    for (const id of rowsV) expect(statusOf(db, id)).toEqual({ status: 'done', error: null });
  });

  test('RECONCILE_FORCE=true tombstones rows whose whole images dir is absent', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const batchU = seedUser(db, 'u', now);
    const presentU = seedDoneTile(db, batchU, 'u', 0, now);
    const batchV = seedUser(db, 'v', now);
    const rowsV = [0, 1].map((i) => seedDoneTile(db, batchV, 'v', i, now));
    const dirU = join(config.DATA_DIR, 'images', 'u');
    mkdirSync(dirU, { recursive: true });
    writeFileSync(join(dirU, `${presentU}.png`), 'present');

    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS,
      orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
      force: true,
      dbIntegrityOk: true,
    });

    expect(statusOf(db, presentU)).toEqual({ status: 'done', error: null });
    for (const id of rowsV) expect(statusOf(db, id)).toEqual({ status: 'failed', error: 'internal error' });
  });

  test('absent-dir rows do not dilute the ratio guarding a present user (no masked mass-tombstone)', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    // Present user A: dir exists, 1 present + 3 missing → 3/4 = 0.75 of A's
    // eligible rows missing, over the 0.5 threshold → must refuse.
    const batchA = seedUser(db, 'a', now);
    const presentA = seedDoneTile(db, batchA, 'a', 0, now);
    const missingA = [1, 2, 3].map((i) => seedDoneTile(db, batchA, 'a', i, now));
    const dirA = join(config.DATA_DIR, 'images', 'a');
    mkdirSync(dirA, { recursive: true });
    writeFileSync(join(dirA, `${presentA}.png`), 'present');
    // Absent-dir user B with many rows. Under a naive doneRows denominator the
    // ratio would be 3/(4+6) = 0.3 < 0.5 and A's genuine loss would wrongly flip.
    const batchB = seedUser(db, 'b', now);
    const rowsB = [0, 1, 2, 3, 4, 5].map((i) => seedDoneTile(db, batchB, 'b', i, now));

    startupReconcile(db, config.DATA_DIR, logger, {
      uploadTtlMs: config.UPLOAD_TTL_MS,
      orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
      force: config.RECONCILE_FORCE,
      dbIntegrityOk: true,
    });

    // A's loss is refused (ratio over eligible = 0.75); B's anomaly is skipped.
    expect(statusOf(db, presentA)).toEqual({ status: 'done', error: null });
    for (const id of missingA) expect(statusOf(db, id)).toEqual({ status: 'done', error: null });
    for (const id of rowsB) expect(statusOf(db, id)).toEqual({ status: 'done', error: null });
  });
});
