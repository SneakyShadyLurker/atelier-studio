import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import type { TileExt } from '@atelier/shared';
import { type ArtifactFile, deleteArtifact, findOrphans, namedArtifactRoot } from '../storage/files';
import { releaseUploads, SQL_UPLOAD_UNREFERENCED } from '../storage/uploadStore';
import type { AppLogger } from '../observability/logger';
import * as queue from '../orchestrator/queue';
import { finalizeBatch } from '../orchestrator/finalize';
import { autoUnlinkBatch, markStitchQueued } from '../db/sequences';
import {
  applySequenceMutationEffect,
  preparePermanentBatchDeletion,
  type SequenceMutationEffect,
} from '../orchestrator/sequenceLifecycle';
import { deleteSequenceMaster, enqueueSequenceStitch } from '../orchestrator/stitchQueue';
import { runDbMaintenance } from '../db/client';
import { DB_CORRUPTION_EVENT } from '../db/integrity';

const MAX_SQLITE_PARAMS_PER_QUERY = 500;

// One-shot directory scan that bundles every artifact filename present
// under `<dataDir>/<rootName>/<userId>/` into a `Set<filename>` per user.
// Replaces the per-row `existsSync` filter in done-tile and upload
// reconciliation (the prior shape was O(N) blocking stat(2) syscalls under
// a bind-mount with stat latency on the boot critical path; the
// reconcile now pays one `readdir` per user-dir regardless of row count).
// Missing per-user dirs are reported as an empty set so the caller's
// "missing artifact" branch fires correctly.
function indexArtifactRoot(dataDir: string, rootName: 'images' | 'uploads'): Map<string, Set<string>> {
  const root = namedArtifactRoot(dataDir, rootName);
  const byUser = new Map<string, Set<string>>();
  let userDirs: readonly { name: string; isDirectory(): boolean }[];
  try {
    userDirs = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return byUser;
    throw error;
  }
  for (const entry of userDirs) {
    if (!entry.isDirectory()) continue;
    const userId = entry.name;
    const userDir = `${root}/${userId}`;
    let names: readonly { name: string; isFile(): boolean }[];
    try {
      names = readdirSync(userDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const set = new Set<string>();
    for (const child of names) {
      if (child.isFile()) set.add(child.name);
    }
    byUser.set(userId, set);
  }
  return byUser;
}

function artifactPresent(
  index: ReadonlyMap<string, ReadonlySet<string>>,
  userId: string,
  filename: string,
): boolean {
  return index.get(userId)?.has(filename) ?? false;
}

const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// When the DB is empty but the bind mount has artifacts (DB volume reset
// while artifacts persisted from a prior install), allow trivial cleanup but
// refuse mass deletion without explicit operator opt-in.
const EMPTY_DB_ORPHAN_COUNT_LIMIT = 100;

export interface ReconcileOptions {
  uploadTtlMs: number;
  /** 0..1 fraction; orphan ratios above this trip the refuse path. */
  orphanThreshold: number;
  /** One-boot override flag for the orphan guard. */
  force: boolean;
  /**
   * Result of the boot-time integrity check. False means the DB is damaged, so
   * the "known" set this sweep diffs against may be missing rows that still
   * have live artifacts on disk — unlinking then destroys real user images.
   * The ratio guard below can't catch it: a handful of rows lost to a single
   * corrupt page sits far under `orphanThreshold`.
   */
  dbIntegrityOk: boolean;
  enqueueSequenceStitch?: (sequenceId: string) => void;
  /** Queue slots for a recovered batch; see `queueSlotsFor` in providers/registry. */
  queueSlotsFor?: (modelId: string, loadingTiles: number) => number;
}

function gateOrphans(
  orphans: readonly ArtifactFile[],
  knownCount: number,
  logger: AppLogger,
  rootName: string,
  opts: ReconcileOptions,
): readonly ArtifactFile[] {
  if (orphans.length === 0) return orphans;
  // Damaged DB → the keep-set is untrustworthy; never unlink on its say-so.
  // Checked before the ratio maths because corruption-induced orphan counts are
  // typically small enough to slip under the threshold. `force` still wins, so
  // an operator who has verified the mount can recover the disk-full case.
  if (!opts.dbIntegrityOk && !opts.force) {
    logger.error(
      { orphans: orphans.length, knownCount, rootName, event: DB_CORRUPTION_EVENT },
      'db integrity check failed; refusing to unlink artifacts (keep-set may be incomplete). Repair the DB first — docs/deployment.md § Database corruption.',
    );
    return [];
  }
  // Two refuse-paths:
  // (a) Known data on disk + orphan ratio above threshold → partial mount
  //     or DB drift; the in-memory `known` set doesn't match disk.
  // (b) Empty DB + lots of orphans → DB volume reset but bind mount still
  //     holds artifacts from a prior install; refuse mass deletion. Trivial
  //     orphan cleanup (a handful of stray tmp files) stays automatic.
  const total = knownCount + orphans.length;
  const ratio = orphans.length / total;
  const shouldRefuse =
    (knownCount > 0 && ratio > opts.orphanThreshold) ||
    (knownCount === 0 && orphans.length > EMPTY_DB_ORPHAN_COUNT_LIMIT);
  if (!shouldRefuse) return orphans;
  if (opts.force) {
    logger.warn({ ratio, orphans: orphans.length, knownCount, rootName }, 'RECONCILE_FORCE=true: bypassing orphan guard');
    return orphans;
  }
  logger.error(
    { ratio, threshold: opts.orphanThreshold, orphans: orphans.length, knownCount, emptyDbLimit: EMPTY_DB_ORPHAN_COUNT_LIMIT, rootName },
    'orphan guard tripped; refusing to unlink. Set RECONCILE_FORCE=true after verifying the artifact mount.',
  );
  return [];
}

export function startupReconcile(
  db: Database,
  dataDir: string,
  logger: AppLogger,
  options: ReconcileOptions,
): void {
  const { uploadTtlMs } = options;
  const now = Date.now();
  const interruptedLoading = db
    .query<{ id: string; batch_id: string; user_id: string }, []>(
      `SELECT tiles.id, tiles.batch_id, tiles.user_id
         FROM tiles
         JOIN batches ON batches.id = tiles.batch_id AND batches.user_id = tiles.user_id
        WHERE tiles.status = 'loading'
          AND batches.status = 'running'`,
    )
    .all();
  if (interruptedLoading.length > 0) {
    db.query(
      `UPDATE tiles
          SET status = 'failed', error = 'interrupted', completed_at = ?
        WHERE status = 'loading'
          AND EXISTS (
            SELECT 1 FROM batches
             WHERE batches.id = tiles.batch_id
               AND batches.user_id = tiles.user_id
               AND batches.status = 'running'
          )`,
    )
      .run(now);
    logger.warn({ count: interruptedLoading.length }, 'reconciled interrupted loading tiles');
    const interruptedBatches = new Map(
      interruptedLoading.map((row) => [row.batch_id, row.user_id] as const),
    );
    for (const [batchId, userId] of interruptedBatches) {
      const unlinked = autoUnlinkBatch(db, userId, batchId, now);
      if (unlinked.status === 'dissolved') {
        deleteSequenceMaster(dataDir, unlinked.sequence.userId, unlinked.sequence.id, logger);
      }
    }
  }
  const completedRunning = db
    .query(
      `UPDATE batches
          SET status = 'done'
        WHERE status IN ('running','queued')
          AND NOT EXISTS (
            SELECT 1 FROM tiles
             WHERE tiles.batch_id = batches.id
               AND tiles.user_id = batches.user_id
               AND tiles.status = 'loading'
          )`,
    )
    .run();
  if (completedRunning.changes > 0) {
    logger.warn({ count: completedRunning.changes }, 'reconciled interrupted running batches');
  }
  rebuildQueueFromDb(db, logger, options.queueSlotsFor);

  // Only fail-flip live (non-archived) done rows. Archived rows are user-soft-
  // deleted; flipping them to 'failed' hides them from the archive view (which
  // filters status='done'), losing visibility on tiles the user explicitly
  // chose to keep until the 30-day TTL purge. A missing artifact under an
  // archived row will surface as a 404 on /api/img/:tileId at view time —
  // same failure mode as any other missing-file path — without mutating state.
  const doneRows = db
    .query<{ id: string; batch_id: string; ext: string; user_id: string }, []>(
      "SELECT id, batch_id, ext, user_id FROM tiles WHERE status = 'done' AND ext IS NOT NULL AND archived_at IS NULL",
    )
    .all();
  // Threshold guard. If `images/` is missing entirely
  // (volume restore brought the SQLite back without the artifact mount,
  // bind mount renamed, etc.), every done row would falsely tombstone.
  // Bail loudly before mutating anything user-visible. The operator can
  // either restore the mount or accept the data loss explicitly.
  const imagesRoot = namedArtifactRoot(dataDir, 'images');
  if (doneRows.length > 0 && !existsSync(imagesRoot)) {
    logger.error(
      { dataDir, doneCount: doneRows.length },
      'images/ directory missing on boot but `done` tiles exist; refusing to bulk-tombstone — restore the mount or rerun after wiping atelier.sqlite',
    );
    throw new Error(
      `startup reconciliation refused: ${doneRows.length} done tiles but images/ is missing at ${imagesRoot}`,
    );
  }
  // Index every artifact filename under images/ in one readdirSync pass per
  // user-dir, then check presence in O(1) per row — replaces N blocking
  // existsSync syscalls under a bind-mount with stat latency.
  const imagesIndex = indexArtifactRoot(dataDir, 'images');
  // A user with live `done` tiles always has an images/<userId>/ dir (writeAtomic
  // creates it on first write). Partition rows by whether that dir exists at all:
  // an absent dir is a per-user mount anomaly (the per-user analogue of the
  // whole-`images/` guard above), NOT genuine per-tile loss — so it is handled
  // separately from, and crucially must NOT dilute the ratio of, real missing
  // files. (A 1000-row absent-dir user could otherwise average away a different
  // user's genuine 60%-loss and let it tombstone.)
  const eligible: typeof doneRows = [];
  const absentDirRows: typeof doneRows = [];
  const usersMissingDir = new Set<string>();
  for (const row of doneRows) {
    if (imagesIndex.has(row.user_id)) {
      eligible.push(row);
    } else {
      absentDirRows.push(row);
      usersMissingDir.add(row.user_id);
    }
  }
  const missing = eligible.filter((row) => !artifactPresent(imagesIndex, row.user_id, `${row.id}.${row.ext}`));

  // Ratio guard, mirroring gateOrphans on the unlink path. A fail-flip is equally
  // irreversible (a failed tile can never be restored; a reappearing artifact
  // becomes an orphan), so refuse a bulk tombstone when an implausible fraction
  // of ELIGIBLE rows are missing — the signature of a partial/empty mount. The
  // denominator is `eligible`, never all done rows, so an excluded absent-dir
  // user cannot dilute the ratio. RECONCILE_FORCE=true overrides for one boot.
  const flipRatio = eligible.length > 0 ? missing.length / eligible.length : 0;
  const ratioTripped = missing.length > 0 && flipRatio > options.orphanThreshold;
  const toFlip: typeof doneRows = [];
  if (missing.length > 0) {
    if (ratioTripped && !options.force) {
      logger.error(
        { ratio: flipRatio, threshold: options.orphanThreshold, missing: missing.length, eligible: eligible.length },
        'missing-artifact ratio above threshold; refusing to bulk-tombstone done tiles. Set RECONCILE_FORCE=true after verifying the artifact mount.',
      );
    } else {
      if (ratioTripped) {
        logger.warn(
          { ratio: flipRatio, missing: missing.length, eligible: eligible.length },
          'RECONCILE_FORCE=true: bypassing missing-artifact ratio guard',
        );
      }
      toFlip.push(...missing);
    }
  }
  // Absent whole-user-dir rows: by default a mount anomaly — leave them `done`
  // (they 404 at view time until the mount is restored, no irreversible change).
  // Under RECONCILE_FORCE the operator has verified the loss is genuine, so
  // tombstone them too — uniform force semantics with the ratio override above
  // (and parity with the pre-guard behavior, which flipped these unconditionally).
  if (absentDirRows.length > 0) {
    if (options.force) {
      logger.warn(
        { users: usersMissingDir.size, rows: absentDirRows.length },
        'RECONCILE_FORCE=true: tombstoning done tiles whose per-user images dir is absent',
      );
      toFlip.push(...absentDirRows);
    } else {
      logger.error(
        { users: usersMissingDir.size },
        'per-user images dir absent for users with done tiles; skipping fail-flip for their rows (set RECONCILE_FORCE=true to tombstone) — restore the artifact mount',
      );
    }
  }
  const stitchesAlreadyEnqueued = new Set<string>();
  if (toFlip.length > 0) {
    const markMissing = db.query(
      "UPDATE tiles SET status = 'failed', error = 'internal error', completed_at = ? WHERE id = ? AND status = 'done' AND archived_at IS NULL",
    );
    const missingArtifactEffects: SequenceMutationEffect[] = [];
    db.transaction(() => {
      const affectedBatches = new Map<string, string>();
      for (const row of toFlip) {
        markMissing.run(now, row.id);
        affectedBatches.set(row.batch_id, row.user_id);
      }
      for (const [batchId, userId] of affectedBatches) {
        missingArtifactEffects.push(preparePermanentBatchDeletion(db, userId, batchId));
      }
    })();
    const dissolvedSequences = new Set(
      missingArtifactEffects.flatMap(
        (effect) => effect.kind === 'delete-master' ? [effect.sequenceId] : [],
      ),
    );
    for (const effect of missingArtifactEffects) {
      if (effect.kind === 'restitch' && dissolvedSequences.has(effect.sequenceId)) continue;
      if (effect.kind === 'restitch' && options.enqueueSequenceStitch) {
        markStitchQueued(db, effect.sequenceId);
        options.enqueueSequenceStitch(effect.sequenceId);
        stitchesAlreadyEnqueued.add(effect.sequenceId);
      } else {
        applySequenceMutationEffect({ DATA_DIR: dataDir }, logger, effect);
        if (effect.kind === 'restitch') stitchesAlreadyEnqueued.add(effect.sequenceId);
      }
    }
    logger.error({ count: toFlip.length }, 'reconciled done tiles with missing artifacts');
  }

  const known = new Set(
    db
      .query<{ name: string }, []>("SELECT user_id || '/' || id || '.' || ext AS name FROM tiles WHERE status = 'done' AND ext IS NOT NULL")
      .all()
      .map((row) => row.name),
  );
  const masterRows = db.query<{
    id: string;
    user_id: string;
    master_status: string;
    master_revision: number | null;
    stitch_pending: number;
    stitch_revision: number;
    completed: number;
  }, []>(
    `SELECT s.id, s.user_id, s.master_status, s.master_revision, s.stitch_pending, s.stitch_revision,
            ((SELECT COUNT(*) FROM batches b WHERE b.sequence_id = s.id AND b.user_id = s.user_id) >= 2
             AND NOT EXISTS (
               SELECT 1 FROM batches b WHERE b.sequence_id = s.id AND b.user_id = s.user_id
                 AND (b.status != 'done' OR NOT EXISTS (
                   SELECT 1 FROM tiles t WHERE t.batch_id = b.id AND t.user_id = b.user_id
                     AND t.status = 'done' AND t.ext = 'mp4' AND t.mime = 'video/mp4'
                 ))
             )) AS completed
       FROM video_sequences s`,
  ).all();
  for (const row of masterRows) known.add(`${row.user_id}/${row.id}.mp4`);
  const sequencesToRecover = new Set(
    masterRows.flatMap((row) => {
      if (row.master_status === 'stitching' || row.stitch_pending) return [row.id];
      if (
        row.completed
        && ['idle', 'ready'].includes(row.master_status)
        && (row.master_status === 'idle' || row.master_revision === null || row.master_revision !== row.stitch_revision)
      ) return [row.id];
      if (
        row.master_status === 'ready'
        && !artifactPresent(imagesIndex, row.user_id, `${row.id}.mp4`)
      ) return [row.id];
      return [];
    }),
  );

  for (const file of gateOrphans(findOrphans(dataDir, 'images', known), known.size, logger, 'images', options)) {
    try {
      unlinkSync(file.path);
      logger.warn({ path: file.path, userId: file.userId, tileId: file.artifactId, temporary: file.temporary }, 'removed orphan artifact');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const knownThumbs = new Set(
    db
      .query<{ name: string }, []>(
        "SELECT user_id || '/' || id || '.webp' AS name FROM tiles WHERE status = 'done'",
      )
      .all()
      .map((row) => row.name),
  );
  for (const file of gateOrphans(findOrphans(dataDir, 'thumbs', knownThumbs), knownThumbs.size, logger, 'thumbs', options)) {
    try {
      unlinkSync(file.path);
      logger.warn({ path: file.path, userId: file.userId, tileId: file.artifactId, temporary: file.temporary }, 'removed orphan thumb');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const uploadRows = db
    .query<{ id: string; ext: TileExt; user_id: string }, []>('SELECT id, ext, user_id FROM uploads')
    .all();
  const uploadsRoot = namedArtifactRoot(dataDir, 'uploads');
  if (uploadRows.length > 0 && !existsSync(uploadsRoot)) {
    logger.error(
      { dataDir, uploadCount: uploadRows.length },
      'uploads/ directory missing on boot but upload rows exist; refusing to bulk-delete — restore the mount or rerun after wiping stale upload rows',
    );
    throw new Error(
      `startup reconciliation refused: ${uploadRows.length} upload rows but uploads/ is missing at ${uploadsRoot}`,
    );
  }
  const uploadsIndex = indexArtifactRoot(dataDir, 'uploads');
  const eligibleUploads: typeof uploadRows = [];
  const absentDirUploads: typeof uploadRows = [];
  const uploadsUsersMissingDir = new Set<string>();
  for (const row of uploadRows) {
    if (uploadsIndex.has(row.user_id)) {
      eligibleUploads.push(row);
    } else {
      absentDirUploads.push(row);
      uploadsUsersMissingDir.add(row.user_id);
    }
  }
  const missingUploads = eligibleUploads.filter((row) => !artifactPresent(uploadsIndex, row.user_id, `${row.id}.${row.ext}`));
  const uploadMissingRatio = eligibleUploads.length > 0 ? missingUploads.length / eligibleUploads.length : 0;
  const uploadRatioTripped = missingUploads.length > 0 && uploadMissingRatio > options.orphanThreshold;
  const uploadsToDelete: typeof uploadRows = [];
  if (missingUploads.length > 0) {
    if (uploadRatioTripped && !options.force) {
      logger.error(
        { ratio: uploadMissingRatio, threshold: options.orphanThreshold, missing: missingUploads.length, eligible: eligibleUploads.length },
        'missing-upload ratio above threshold; refusing to bulk-delete upload rows. Set RECONCILE_FORCE=true after verifying the artifact mount.',
      );
    } else {
      if (uploadRatioTripped) {
        logger.warn(
          { ratio: uploadMissingRatio, missing: missingUploads.length, eligible: eligibleUploads.length },
          'RECONCILE_FORCE=true: bypassing missing-upload ratio guard',
        );
      }
      uploadsToDelete.push(...missingUploads);
    }
  }
  if (absentDirUploads.length > 0) {
    if (options.force) {
      logger.warn(
        { users: uploadsUsersMissingDir.size, rows: absentDirUploads.length },
        'RECONCILE_FORCE=true: deleting upload rows whose per-user uploads dir is absent',
      );
      uploadsToDelete.push(...absentDirUploads);
    } else {
      logger.error(
        { users: uploadsUsersMissingDir.size },
        'per-user uploads dir absent for users with upload rows; skipping destructive upload reconciliation for their rows (set RECONCILE_FORCE=true to delete) — restore the artifact mount',
      );
    }
  }
  if (uploadsToDelete.length > 0) {
    const deleteUploadRefs = db.query('DELETE FROM tile_ref_images WHERE upload_id = ?');
    const deleteUpload = db.query('DELETE FROM uploads WHERE id = ?');
    // batches.i2v_source_upload_id has no DB-level FK (no ON DELETE SET NULL),
    // so referential integrity for the I2V source still is enforced here in app
    // code: null the column on any batch (done OR queued) that points at a
    // deleted upload, else a terminal batch keeps a dangling, wire-exposed id
    // and the client 404s veiling the source frame.
    const clearI2vSource = db.query('UPDATE batches SET i2v_source_upload_id = NULL WHERE i2v_source_upload_id = ?');
    const failQueuedTiles = db.query(
      `UPDATE tiles
          SET status = 'failed', error = 'internal error', completed_at = ?
        WHERE batch_id = ?
          AND status = 'loading'`,
    );
    const dissolvedMasters: { readonly id: string; readonly userId: string }[] = [];
    db.transaction(() => {
      const affectedQueuedBatches = queuedBatchesReferencingUploads(db, uploadsToDelete.map((row) => row.id));
      for (const batchId of affectedQueuedBatches) {
        failQueuedTiles.run(now, batchId);
        finalizeBatch(db, batchId);
        const owner = db.query<{ user_id: string }, [string]>(
          'SELECT user_id FROM batches WHERE id = ?',
        ).get(batchId);
        if (owner) {
          const unlinked = autoUnlinkBatch(db, owner.user_id, batchId, now);
          if (unlinked.status === 'dissolved') {
            dissolvedMasters.push({ id: unlinked.sequence.id, userId: unlinked.sequence.userId });
          }
        }
      }
      for (const row of uploadsToDelete) {
        deleteUploadRefs.run(row.id);
        clearI2vSource.run(row.id);
        deleteUpload.run(row.id);
      }
    })();
    for (const master of dissolvedMasters) {
      deleteSequenceMaster(dataDir, master.userId, master.id, logger);
    }
    rebuildQueueFromDb(db, logger, options.queueSlotsFor);
    logger.warn({ count: uploadsToDelete.length }, 'reconciled upload rows with missing artifacts');
  }

  const knownUploads = new Set(uploadRows.map((row) => `${row.user_id}/${row.id}.${row.ext}`));
  for (const file of gateOrphans(findOrphans(dataDir, 'uploads', knownUploads), knownUploads.size, logger, 'uploads', options)) {
    try {
      unlinkSync(file.path);
      logger.warn({ path: file.path, userId: file.userId, uploadId: file.artifactId, temporary: file.temporary }, 'removed orphan upload artifact');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const uploadCutoff = now - uploadTtlMs;
  const expiredUploads = db
    .query<{ id: string; user_id: string; ext: TileExt }, [number]>(
      `SELECT id, user_id, ext
       FROM uploads
       WHERE created_at < ?
         AND ${SQL_UPLOAD_UNREFERENCED}`,
    )
    .all(uploadCutoff);
  if (expiredUploads.length > 0) {
    const deleteExpired = db.query(
      `DELETE FROM uploads
       WHERE id = ?
         AND created_at < ?
         AND ${SQL_UPLOAD_UNREFERENCED}`,
    );
    db.transaction(() => {
      for (const row of expiredUploads) deleteExpired.run(row.id, uploadCutoff);
    })();
    for (const row of expiredUploads) {
      try {
        deleteArtifact(dataDir, 'uploads', row.user_id, row.id, row.ext);
      } catch (error) {
        logger.warn({ err: error, uploadId: row.id, ext: row.ext }, 'upload TTL reaper: artifact unlink failed');
      }
    }
    logger.info({ count: expiredUploads.length }, 'reaped expired unreferenced uploads');
  }

  const cutoff = Date.now() - ARCHIVE_TTL_MS;
  const tileDeleteStmt = db.query<{ id: string; user_id: string; ext: TileExt | null }, [number]>(
    'DELETE FROM tiles WHERE archived_at IS NOT NULL AND archived_at < ? RETURNING id, user_id, ext',
  );
  const batchDeleteStmt = db.query(
    `DELETE FROM batches
       WHERE archived_at IS NOT NULL
         AND archived_at < ?
         AND NOT EXISTS (SELECT 1 FROM tiles WHERE tiles.user_id = batches.user_id AND tiles.batch_id = batches.id)`,
  );
  // Tile-row and batch-row deletes commit atomically (same as every other
  // reconcile block + the archive route). RETURNING makes the unlink list
  // exactly the rows removed, closing the prior SELECT-then-DELETE window
  // where a crash could leave a tile-less archived batch across a boot.
  // The file-unlink loop stays OUTSIDE the txn — fs work can't roll back.
  const sequenceEffects: SequenceMutationEffect[] = [];
  const { deletedTiles, batchesPurged, purgedUploads } = db.transaction(() => {
    const expiringBatchIds = db.query<{ batch_id: string }, [number]>(
      `SELECT DISTINCT batch_id FROM tiles
        WHERE archived_at IS NOT NULL AND archived_at < ?`,
    ).all(cutoff).map((row) => row.batch_id);
    const uploadsByUser = new Map<string, string[]>();
    for (const row of db.query<{ id: string; user_id: string }, [number]>(
      `SELECT id, user_id FROM uploads
        WHERE id IN (
          SELECT tri.upload_id FROM tile_ref_images tri JOIN tiles t ON t.id = tri.tile_id
           WHERE t.archived_at IS NOT NULL AND t.archived_at < ?1
          UNION
          SELECT b.i2v_source_upload_id FROM batches b JOIN tiles t ON t.batch_id = b.id
           WHERE t.archived_at IS NOT NULL AND t.archived_at < ?1
        )`,
    ).all(cutoff)) {
      const ids = uploadsByUser.get(row.user_id);
      if (ids) ids.push(row.id);
      else uploadsByUser.set(row.user_id, [row.id]);
    }
    for (const batchId of expiringBatchIds) {
      sequenceEffects.push(preparePermanentBatchDeletion(db, db.query<{ user_id: string }, [string]>(
        'SELECT user_id FROM batches WHERE id = ?',
      ).get(batchId)?.user_id ?? '', batchId));
    }
    const deleted = tileDeleteStmt.all(cutoff);
    const batchResult = batchDeleteStmt.run(cutoff);
    return { deletedTiles: deleted, batchesPurged: batchResult.changes, purgedUploads: uploadsByUser };
  })();
  for (const [userId, uploadIds] of purgedUploads) {
    releaseUploads({ db, dataDir, logger, userId, uploadIds });
  }
  const dissolvedSequences = new Set(
    sequenceEffects.flatMap((effect) => effect.kind === 'delete-master' ? [effect.sequenceId] : []),
  );
  for (const effect of sequenceEffects) {
    if (effect.kind === 'restitch' && dissolvedSequences.has(effect.sequenceId)) continue;
    applySequenceMutationEffect({ DATA_DIR: dataDir }, logger, effect);
  }
  for (const tile of deletedTiles) {
    if (!tile.ext) continue;
    try {
      deleteArtifact(dataDir, 'images', tile.user_id, tile.id, tile.ext);
    } catch (error) {
      logger.warn({ err: error, tileId: tile.id, ext: tile.ext }, 'archive purge: artifact unlink failed; will be reaped at next boot');
    }
    try {
      deleteArtifact(dataDir, 'thumbs', tile.user_id, tile.id, 'webp');
    } catch (error) {
      logger.warn({ err: error, tileId: tile.id }, 'archive purge: thumb unlink failed; will be reaped at next boot');
    }
  }
  if (deletedTiles.length > 0 || batchesPurged > 0) {
    logger.info({ tilesPurged: deletedTiles.length, batchesPurged }, 'archive purge complete');
  }

  // Reclaim the WAL space + FTS5 tombstones the bulk purge above leaves behind.
  runDbMaintenance(db, logger);
  for (const sequenceId of sequencesToRecover) {
    if (stitchesAlreadyEnqueued.has(sequenceId)) continue;
    markStitchQueued(db, sequenceId);
    if (options.enqueueSequenceStitch) options.enqueueSequenceStitch(sequenceId);
    else enqueueSequenceStitch(sequenceId, null);
  }
}

export function rebuildQueueFromDb(
  db: Database,
  logger: AppLogger,
  slotsFor?: (modelId: string, loadingTiles: number) => number,
): void {
  try {
    queue.rebuildFromDb(db, logger, slotsFor);
  } catch (error) {
    logger.error(
      { err: error, event: 'queue_rebuild_failed' },
      'queue rebuild failed during startup reconciliation; continuing boot',
    );
  }
}

function queuedBatchesReferencingUploads(db: Database, uploadIds: readonly string[]): string[] {
  if (uploadIds.length === 0) return [];
  const batchIds = new Set<string>();
  for (let start = 0; start < uploadIds.length; start += MAX_SQLITE_PARAMS_PER_QUERY) {
    const chunk = uploadIds.slice(start, start + MAX_SQLITE_PARAMS_PER_QUERY);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .query<{ batch_id: string }, string[]>(
        `SELECT DISTINCT t.batch_id
           FROM tile_ref_images tri
           JOIN tiles t ON t.id = tri.tile_id
           JOIN batches b ON b.id = t.batch_id AND b.user_id = t.user_id
          WHERE tri.upload_id IN (${placeholders})
            AND b.status = 'queued'
          UNION
          SELECT DISTINCT id AS batch_id
            FROM batches
           WHERE i2v_source_upload_id IN (${placeholders})
             AND status = 'queued'`,
      )
      .all(...chunk, ...chunk);
    for (const row of rows) batchIds.add(row.batch_id);
  }
  return [...batchIds];
}
