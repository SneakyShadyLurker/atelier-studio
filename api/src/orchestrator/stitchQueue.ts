import type { Database } from 'bun:sqlite';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';
import { markFailed, markReady, markStitchQueued, markStitching, restorePreviousReadyPublication } from '../db/sequences';
import { reportIfCorruption } from '../db/integrity';
import type { AppLogger } from '../observability/logger';
import { artifactFilePath, deleteArtifact, namedArtifactDir, writeAtomicPublishThenCommit } from '../storage/files';
import { stitchSequence, type SequenceStitchSegment } from '../storage/stitchSequence';
import { storageKeyring } from '../storage/crypto';
import { withDecryptedArtifactFiles } from '../storage/decryptedTemp';

interface StitchQueueRuntime {
  readonly db: Database;
  readonly config: Config;
  readonly logger: AppLogger;
}

interface PendingSequence {
  batchId: string | null;
  queued: boolean;
  running: boolean;
  rerun: boolean;
}

interface SequenceRow {
  readonly id: string;
  readonly user_id: string;
  readonly stitch_revision: number;
  readonly master_status: string;
  readonly master_updated_at: number | null;
}

interface SegmentRow {
  readonly batch_id: string;
  readonly tile_id: string;
  readonly ext: 'mp4';
  readonly duration_frames: number;
  readonly context_frames: number;
}

interface LinkedSegmentRow {
  readonly status: string;
}

interface StitchSnapshotSegment extends Omit<SequenceStitchSegment, 'path'> {
  readonly tileId: string;
  readonly ext: 'mp4';
}

interface StitchSnapshot {
  readonly sequenceId: string;
  readonly userId: string;
  readonly revision: number;
  readonly previousReadyPublication: number | null;
  readonly segments: readonly StitchSnapshotSegment[];
}

// The single stitch worker waits (unbounded) for the storage root instead of
// failing a stitch it could complete seconds later.
const NEVER_ABORT = new AbortController().signal;

let runtime: StitchQueueRuntime | null = null;
let workerRunning = false;
const pending = new Map<string, PendingSequence>();
const fifo: string[] = [];
const idleWaiters = new Set<() => void>();

export function configureStitchQueue(next: StitchQueueRuntime): void {
  runtime = next;
}

export function enqueueSequenceStitch(sequenceId: string, batchId: string | null = null): void {
  const configured = runtime;
  if (!configured) throw new Error('sequence stitch queue is not configured');
  markStitchQueued(configured.db, sequenceId);
  const existing = pending.get(sequenceId);
  if (existing) {
    existing.batchId = batchId ?? existing.batchId;
    if (existing.running) existing.rerun = true;
    configured.logger.info(
      {
        event: 'sequence_stitch_coalesced',
        sequenceId,
        stitchRevision: currentRevision(configured.db, sequenceId),
        batchId: existing.batchId,
      },
      'sequence stitch coalesced',
    );
    return;
  }
  pending.set(sequenceId, { batchId, queued: true, running: false, rerun: false });
  fifo.push(sequenceId);
  void pump();
}

export function waitForStitchQueueIdle(): Promise<void> {
  if (!workerRunning && fifo.length === 0 && pending.size === 0) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.add(resolve); });
}

export function resetStitchQueueForTests(): void {
  if (workerRunning) throw new Error('cannot reset sequence stitch queue while running');
  runtime = null;
  fifo.length = 0;
  pending.clear();
  resolveIdleWaiters();
}

export function deleteSequenceMaster(
  dataDir: string,
  userId: string,
  sequenceId: string,
  logger: Pick<AppLogger, 'warn'>,
): void {
  try {
    deleteArtifact(dataDir, 'images', userId, sequenceId, 'mp4');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        { err: error, sequenceId, userId },
        'sequence master unlink failed; will be reaped at next boot',
      );
    }
  }
}

async function pump(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    for (;;) {
      const sequenceId = fifo.shift();
      if (!sequenceId) break;
      const state = pending.get(sequenceId);
      const configured = runtime;
      if (!state || !configured) continue;
      state.queued = false;
      state.running = true;
      const triggeringBatchId = state.batchId;
      await runStitch(configured, sequenceId, triggeringBatchId);
      state.running = false;
      if (state.rerun) {
        state.rerun = false;
        state.queued = true;
        fifo.push(sequenceId);
      } else {
        pending.delete(sequenceId);
      }
    }
  } finally {
    workerRunning = false;
    if (fifo.length > 0) void pump();
    else if (pending.size === 0) resolveIdleWaiters();
  }
}

async function runStitch(
  configured: StitchQueueRuntime,
  sequenceId: string,
  batchId: string | null,
): Promise<void> {
  let snapshot: StitchSnapshot | null = null;
  let publicationStarted = false;
  try {
    await (await storageKeyring()).awaitUnsealed(NEVER_ABORT);
    snapshot = snapshotSequence(configured, sequenceId);
    if (!snapshot) return;
    if (!markStitching(configured.db, sequenceId, snapshot.revision)) {
      logStale(configured.logger, sequenceId, snapshot.revision, batchId);
      enqueueSequenceStitch(sequenceId, batchId);
      return;
    }
    configured.logger.info(
      {
        event: 'sequence_stitch_start',
        sequenceId,
        stitchRevision: snapshot.revision,
        batchId,
      },
      'sequence stitch started',
    );
    const stitchInput = snapshot;
    const bytes = await withDecryptedArtifactFiles(
      configured.config.DATA_DIR,
      stitchInput.segments.map((segment) => ({
        root: 'images' as const,
        userId: stitchInput.userId,
        artifactId: segment.tileId,
        ext: segment.ext,
      })),
      {},
      (paths) => stitchSequence(
        stitchInput.segments.map((segment, index) => {
          const path = paths[index];
          if (path === undefined) throw new Error('decrypted stitch segment missing');
          return { path, durationFrames: segment.durationFrames, contextFrames: segment.contextFrames };
        }),
        {
          timeoutBaselineMs: configured.config.SEQUENCE_STITCH_TIMEOUT_MS,
          maxOutputBytes: configured.config.SEQUENCE_MASTER_MAX_BYTES,
        },
      ),
    );
    if (bytes === null) throw new Error('video sequence segment artifact missing');
    const completedAt = Date.now();
    publicationStarted = true;
    const publishedPath = await writeAtomicPublishThenCommit(
      configured.config.DATA_DIR,
      'images',
      snapshot.userId,
      sequenceId,
      'mp4',
      bytes,
      () => markReady(configured.db, sequenceId, snapshot?.revision ?? -1, completedAt),
    );
    if (publishedPath === null) {
      if (snapshot.previousReadyPublication !== null) {
        restorePreviousReadyPublication(configured.db, sequenceId, snapshot.previousReadyPublication);
      }
      logStale(configured.logger, sequenceId, snapshot.revision, batchId);
      enqueueSequenceStitch(sequenceId, batchId);
      return;
    }
    configured.logger.info(
      {
        event: 'sequence_stitch_done',
        sequenceId,
        stitchRevision: snapshot.revision,
        batchId,
      },
      'sequence stitch completed',
    );
  } catch (error) {
    reportIfCorruption(error, configured.logger, {
      phase: 'sequence_stitch',
      sequenceId,
      batchId,
    });
    let revision = snapshot?.revision ?? null;
    if (revision === null) {
      try {
        revision = currentRevision(configured.db, sequenceId);
      } catch (revisionError) {
        reportIfCorruption(revisionError, configured.logger, {
          phase: 'sequence_stitch_revision',
          sequenceId,
          batchId,
        });
      }
    }
    try {
      if (revision !== null && !markFailed(configured.db, sequenceId, revision, 'sequence stitch failed')) {
        if (!publicationStarted && snapshot?.previousReadyPublication != null) {
          restorePreviousReadyPublication(configured.db, sequenceId, snapshot.previousReadyPublication);
        }
        logStale(configured.logger, sequenceId, revision, batchId);
        enqueueSequenceStitch(sequenceId, batchId);
        return;
      }
    } catch (dbError) {
      reportIfCorruption(dbError, configured.logger, {
        phase: 'sequence_stitch_mark_failed',
        sequenceId,
        batchId,
      });
    }
    configured.logger.error(
      {
        err: error,
        event: 'sequence_stitch_failed',
        sequenceId,
        stitchRevision: revision,
        batchId,
      },
      'sequence stitch failed',
    );
  } finally {
    if (snapshot) {
      const tmp = join(
        namedArtifactDir(configured.config.DATA_DIR, 'images', snapshot.userId),
        `${sequenceId}.mp4.tmp`,
      );
      try {
        unlinkSync(tmp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          configured.logger.warn(
            { err: error, sequenceId, stitchRevision: snapshot.revision, batchId },
            'sequence stitch temporary artifact cleanup failed',
          );
        }
      }
    }
  }
}

function snapshotSequence(configured: StitchQueueRuntime, sequenceId: string): StitchSnapshot | null {
  const sequence = configured.db.query<SequenceRow, [string]>(
    'SELECT id, user_id, stitch_revision, master_status, master_updated_at FROM video_sequences WHERE id = ?',
  ).get(sequenceId);
  if (!sequence) return null;
  const segments = configured.db.query<SegmentRow, [string, string]>(
    `SELECT b.id AS batch_id, t.id AS tile_id, t.ext, b.duration_frames, b.context_frames
       FROM batches b
       JOIN tiles t ON t.batch_id = b.id AND t.user_id = b.user_id
      WHERE b.sequence_id = ?
        AND b.user_id = ?
        AND b.sequence_index IS NOT NULL
        AND b.duration_frames IS NOT NULL
        AND b.status = 'done'
        AND t.status = 'done'
        AND t.mime = 'video/mp4'
        AND t.ext = 'mp4'
      ORDER BY b.sequence_index ASC`,
  ).all(sequenceId, sequence.user_id);
  const linked = configured.db.query<LinkedSegmentRow, [string, string]>(
    `SELECT status FROM batches
      WHERE sequence_id = ? AND user_id = ?
      ORDER BY sequence_index ASC`,
  ).all(sequenceId, sequence.user_id);
  const inFlightTail = linked.length > 0
    && linked.slice(0, -1).every((segment) => segment.status === 'done')
    && ['queued', 'running'].includes(linked.at(-1)?.status ?? '')
    && segments.length + 1 === linked.length;
  if (inFlightTail) return null;
  if (segments.length < 2 || segments.length !== linked.length) {
    throw new Error('video sequence has incomplete terminal segment artifacts');
  }
  const dataDir = configured.config.DATA_DIR;
  const stitchSegments = segments.map((segment) => ({
    tileId: segment.tile_id,
    ext: segment.ext,
    durationFrames: segment.duration_frames,
    contextFrames: segment.context_frames,
  }));
  const missing = stitchSegments.find((segment) =>
    artifactFilePath(dataDir, 'images', sequence.user_id, segment.tileId, segment.ext) === null);
  if (missing) throw new Error('video sequence segment artifact missing');
  return {
    sequenceId,
    userId: sequence.user_id,
    revision: sequence.stitch_revision,
    previousReadyPublication: sequence.master_status === 'ready'
      && artifactFilePath(dataDir, 'images', sequence.user_id, sequenceId, 'mp4') !== null
      ? sequence.master_updated_at : null,
    segments: stitchSegments,
  };
}

function currentRevision(db: Database, sequenceId: string): number | null {
  return db.query<{ stitch_revision: number }, [string]>(
    'SELECT stitch_revision FROM video_sequences WHERE id = ?',
  ).get(sequenceId)?.stitch_revision ?? null;
}

function logStale(
  logger: AppLogger,
  sequenceId: string,
  stitchRevision: number,
  batchId: string | null,
): void {
  logger.info(
    {
      event: 'sequence_stitch_discarded_stale',
      sequenceId,
      stitchRevision,
      batchId,
    },
    'discarded stale sequence stitch',
  );
}

function resolveIdleWaiters(): void {
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
}
