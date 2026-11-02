import type { Database } from 'bun:sqlite';
import type { VideoSequenceMasterStatus, VideoSequenceSummary } from '@atelier/shared';
import type { AppLogger } from '../observability/logger';
import { isUniqueConstraintError } from './constraints';
import { reportIfCorruption } from './integrity';
import type { BatchRow } from './types';

export interface SequenceTail {
  readonly sequenceIndex: number;
  readonly batch: BatchRow;
}

export interface DissolvedSequence {
  readonly id: string;
  readonly userId: string;
  readonly stitchRevision: number;
  readonly masterUpdatedAt: number | null;
  readonly unlinkedBatchIds: readonly string[];
}

export type AdoptStandaloneBatchResult =
  | { readonly status: 'ok'; readonly sequenceId: string; readonly stitchRevision: number }
  | { readonly status: 'conflict' };

export type AppendSegmentResult =
  | {
      readonly status: 'ok';
      readonly sequenceId: string;
      readonly sequenceIndex: number;
      readonly stitchRevision: number;
    }
  | { readonly status: 'conflict' }
  | { readonly status: 'not-found' };

export type UnlinkBatchResult =
  | {
      readonly status: 'ok';
      readonly sequenceId: string;
      readonly stitchRevision: number;
      readonly remainingSegmentCount: number;
    }
  | { readonly status: 'not-found' };

export type AutoUnlinkBatchResult =
  | { readonly status: 'not-linked' }
  | {
      readonly status: 'unlinked';
      readonly sequenceId: string;
      readonly stitchRevision: number;
      readonly remainingSegmentCount: number;
    }
  | { readonly status: 'dissolved'; readonly sequence: DissolvedSequence };

export type DissolveSequenceResult =
  | { readonly status: 'dissolved'; readonly sequence: DissolvedSequence }
  | { readonly status: 'not-found' };

interface SequenceOwnershipRow {
  readonly id: string;
  readonly user_id: string;
  readonly master_updated_at: number | null;
}

interface SequenceSummaryRow {
  readonly id: string;
  readonly master_status: VideoSequenceMasterStatus;
  readonly master_updated_at: number | null;
  readonly segment_count: number;
  readonly total_duration_frames: number;
}

export function bumpStitchRevision(db: Database, sequenceId: string, at = Date.now()): number | null {
  return db.query<{ stitch_revision: number }, [number, string]>(
    `UPDATE video_sequences
        SET stitch_revision = stitch_revision + 1,
            master_status = CASE WHEN master_status = 'failed' THEN 'idle' ELSE master_status END,
            master_error = CASE WHEN master_status = 'failed' THEN NULL ELSE master_error END,
            updated_at = ?
      WHERE id = ?
      RETURNING stitch_revision`,
  ).get(at, sequenceId)?.stitch_revision ?? null;
}

export function adoptStandaloneBatch(
  db: Database,
  userId: string,
  batchId: string,
  at = Date.now(),
): AdoptStandaloneBatchResult {
  return db.transaction((): AdoptStandaloneBatchResult => {
    const sequenceId = crypto.randomUUID();
    db.query(
      `INSERT INTO video_sequences
        (id, user_id, created_at, updated_at, master_status, master_error, master_updated_at, stitch_revision)
       VALUES (?, ?, ?, ?, 'idle', NULL, NULL, 0)`,
    ).run(sequenceId, userId, at, at);
    const adoption = db.query(
      `UPDATE batches
          SET sequence_id = ?, sequence_index = 0
        WHERE id = ? AND user_id = ? AND sequence_id IS NULL`,
    ).run(sequenceId, batchId, userId);
    if (adoption.changes !== 1) {
      db.query('DELETE FROM video_sequences WHERE id = ?').run(sequenceId);
      return { status: 'conflict' };
    }
    const stitchRevision = bumpStitchRevision(db, sequenceId, at);
    if (stitchRevision === null) throw new Error('adopted video sequence disappeared');
    return { status: 'ok', sequenceId, stitchRevision };
  }).immediate();
}

export function appendSegment(
  db: Database,
  logger: Pick<AppLogger, 'error'>,
  userId: string,
  sequenceId: string,
  expectedTailBatchId: string,
  batchId: string,
  at = Date.now(),
): AppendSegmentResult {
  try {
    return db.transaction((): AppendSegmentResult => {
      const owned = db.query<{ id: string }, [string, string]>(
        'SELECT id FROM video_sequences WHERE id = ? AND user_id = ?',
      ).get(sequenceId, userId);
      if (!owned) return { status: 'not-found' };

      const tail = getSequenceTail(db, userId, sequenceId);
      if (tail?.batch.id !== expectedTailBatchId) return { status: 'conflict' };
      const sequenceIndex = tail.sequenceIndex + 1;
      const append = db.query(
        `UPDATE batches
            SET sequence_id = ?, sequence_index = ?
          WHERE id = ? AND user_id = ? AND sequence_id IS NULL`,
      ).run(sequenceId, sequenceIndex, batchId, userId);
      if (append.changes !== 1) return { status: 'conflict' };

      const stitchRevision = bumpStitchRevision(db, sequenceId, at);
      if (stitchRevision === null) throw new Error('appended video sequence disappeared');
      return { status: 'ok', sequenceId, sequenceIndex, stitchRevision };
    }).immediate();
  } catch (error) {
    reportIfCorruption(error, logger, { phase: 'sequence_append', sequenceId, batchId });
    if (isUniqueConstraintError(error, 'batches')) return { status: 'conflict' };
    throw error;
  }
}

export function getSequenceTail(
  db: Database,
  userId: string,
  sequenceId: string,
): SequenceTail | null {
  const batch = db.query<BatchRow, [string, string]>(
    `SELECT b.*
       FROM batches b
       JOIN video_sequences s ON s.id = b.sequence_id AND s.user_id = b.user_id
      WHERE s.id = ? AND s.user_id = ?
      ORDER BY b.sequence_index DESC
      LIMIT 1`,
  ).get(sequenceId, userId);
  if (!batch) return null;
  if (batch.sequence_index === null) throw new Error('video sequence batch has no sequence index');
  return { sequenceIndex: batch.sequence_index, batch };
}

export function unlinkBatch(
  db: Database,
  userId: string,
  sequenceId: string,
  batchId: string,
  at = Date.now(),
): UnlinkBatchResult {
  return db.transaction((): UnlinkBatchResult => {
    const unlink = db.query(
      `UPDATE batches
          SET sequence_id = NULL, sequence_index = NULL
        WHERE id = ? AND user_id = ? AND sequence_id = ?
          AND EXISTS (
            SELECT 1 FROM video_sequences
             WHERE id = ? AND user_id = ?
          )`,
    ).run(batchId, userId, sequenceId, sequenceId, userId);
    if (unlink.changes !== 1) return { status: 'not-found' };
    const stitchRevision = bumpStitchRevision(db, sequenceId, at);
    if (stitchRevision === null) throw new Error('unlinked video sequence disappeared');
    const remainingSegmentCount = countSegments(db, sequenceId);
    return { status: 'ok', sequenceId, stitchRevision, remainingSegmentCount };
  }).immediate();
}

export function autoUnlinkBatch(
  db: Database,
  userId: string,
  batchId: string,
  at = Date.now(),
): AutoUnlinkBatchResult {
  return db.transaction((): AutoUnlinkBatchResult => {
    const membership = db.query<{ sequence_id: string }, [string, string]>(
      `SELECT b.sequence_id
         FROM batches b
         JOIN video_sequences s ON s.id = b.sequence_id AND s.user_id = b.user_id
        WHERE b.id = ? AND b.user_id = ?`,
    ).get(batchId, userId);
    if (!membership) return { status: 'not-linked' };

    db.query(
      'UPDATE batches SET sequence_id = NULL, sequence_index = NULL WHERE id = ? AND user_id = ? AND sequence_id = ?',
    ).run(batchId, userId, membership.sequence_id);
    const stitchRevision = bumpStitchRevision(db, membership.sequence_id, at);
    if (stitchRevision === null) throw new Error('auto-unlinked video sequence disappeared');
    const remainingSegmentCount = countSegments(db, membership.sequence_id);
    if (remainingSegmentCount >= 2) {
      return {
        status: 'unlinked',
        sequenceId: membership.sequence_id,
        stitchRevision,
        remainingSegmentCount,
      };
    }
    const sequence = dissolveOwnedSequence(
      db,
      membership.sequence_id,
      userId,
      stitchRevision,
      [batchId],
    );
    if (!sequence) throw new Error('auto-unlinked video sequence disappeared before dissolve');
    return { status: 'dissolved', sequence };
  }).immediate();
}

export function dissolveSequence(
  db: Database,
  userId: string,
  sequenceId: string,
  at = Date.now(),
): DissolveSequenceResult {
  return db.transaction((): DissolveSequenceResult => {
    const owned = getOwnedSequence(db, sequenceId, userId);
    if (!owned) return { status: 'not-found' };
    const stitchRevision = bumpStitchRevision(db, sequenceId, at);
    if (stitchRevision === null) throw new Error('video sequence disappeared before dissolve');
    const sequence = dissolveOwnedSequence(db, sequenceId, userId, stitchRevision);
    if (!sequence) throw new Error('video sequence disappeared during dissolve');
    return { status: 'dissolved', sequence };
  }).immediate();
}

export function markStitching(db: Database, sequenceId: string, revision: number): boolean {
  return db.query(
    `UPDATE video_sequences
        SET master_status = 'stitching', master_error = NULL, updated_at = ?
      WHERE id = ? AND stitch_revision = ?`,
  ).run(Date.now(), sequenceId, revision).changes === 1;
}

// Persist the FIFO's intent before placing it in memory. Deferral for an
// in-flight tail preserves a valid old master; its revision mismatch will
// recover the completed topology even if completion crashes before enqueue.
export function markStitchQueued(db: Database, sequenceId: string): void {
  db.query(
    `UPDATE video_sequences
        SET stitch_pending = 1, updated_at = ?
      WHERE id = ?
        AND (SELECT COUNT(*) FROM batches b WHERE b.sequence_id = video_sequences.id) >= 2
      `,
  ).run(Date.now(), sequenceId);
}

// Only a worker that observed this publication ready before its active run may
// restore availability after completing a stale rollback. Boot cannot infer
// whether final bytes belong to the old publication or an uncommitted candidate.
export function restorePreviousReadyPublication(db: Database, sequenceId: string, publication: number): void {
  db.query(`UPDATE video_sequences SET master_status = 'ready'
    WHERE id = ? AND master_status = 'stitching' AND master_updated_at = ?`).run(sequenceId, publication);
}

export function markReady(
  db: Database,
  sequenceId: string,
  revision: number,
  at: number,
): boolean {
  return db.query(
    `UPDATE video_sequences
        SET master_status = 'ready', master_error = NULL,
            master_updated_at = MAX(?, COALESCE(master_updated_at + 1, ?)),
            master_revision = ?, stitch_pending = 0, updated_at = ?
      WHERE id = ? AND stitch_revision = ?`,
  ).run(at, at, revision, at, sequenceId, revision).changes === 1;
}

export function markFailed(
  db: Database,
  sequenceId: string,
  revision: number,
  error: string,
): boolean {
  return db.query(
    `UPDATE video_sequences
        SET master_status = 'failed', master_error = ?, stitch_pending = 0, updated_at = ?
      WHERE id = ? AND stitch_revision = ?`,
  ).run(error, Date.now(), sequenceId, revision).changes === 1;
}

export function fetchSequenceSummaries(
  db: Database,
  userId: string,
  sequenceIds: readonly string[],
): ReadonlyMap<string, VideoSequenceSummary> {
  const uniqueIds = [...new Set(sequenceIds)];
  if (uniqueIds.length === 0) return new Map();
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = db.query<SequenceSummaryRow, string[]>(
    `SELECT s.id,
            s.master_status,
            s.master_updated_at,
            COUNT(b.id) AS segment_count,
            COALESCE(SUM(b.duration_frames), 0) AS total_duration_frames
       FROM video_sequences s
       JOIN batches b ON b.sequence_id = s.id AND b.user_id = s.user_id
      WHERE s.user_id = ? AND s.id IN (${placeholders})
      GROUP BY s.id, s.master_status, s.master_updated_at`,
  ).all(userId, ...uniqueIds);
  return new Map(rows.map((row) => [
    row.id,
    {
      id: row.id,
      segmentCount: row.segment_count,
      totalDurationFrames: row.total_duration_frames,
      masterStatus: row.master_status,
      ...(row.master_updated_at !== null ? { masterUpdatedAt: row.master_updated_at } : {}),
    },
  ]));
}

function countSegments(db: Database, sequenceId: string): number {
  return db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) AS count FROM batches WHERE sequence_id = ?',
  ).get(sequenceId)?.count ?? 0;
}

function getOwnedSequence(
  db: Database,
  sequenceId: string,
  userId: string,
): SequenceOwnershipRow | null {
  return db.query<SequenceOwnershipRow, [string, string]>(
    'SELECT id, user_id, master_updated_at FROM video_sequences WHERE id = ? AND user_id = ?',
  ).get(sequenceId, userId) ?? null;
}

function dissolveOwnedSequence(
  db: Database,
  sequenceId: string,
  userId: string,
  stitchRevision: number,
  alreadyUnlinkedBatchIds: readonly string[] = [],
): DissolvedSequence | null {
  const owned = getOwnedSequence(db, sequenceId, userId);
  if (!owned) return null;
  const linkedBatchIds = db.query<{ id: string }, [string, string]>(
    'SELECT id FROM batches WHERE sequence_id = ? AND user_id = ? ORDER BY sequence_index ASC',
  ).all(sequenceId, userId).map((row) => row.id);
  db.query(
    'UPDATE batches SET sequence_id = NULL, sequence_index = NULL WHERE sequence_id = ? AND user_id = ?',
  ).run(sequenceId, userId);
  db.query('DELETE FROM video_sequences WHERE id = ? AND user_id = ?').run(sequenceId, userId);
  return {
    id: owned.id,
    userId: owned.user_id,
    stitchRevision,
    masterUpdatedAt: owned.master_updated_at,
    unlinkedBatchIds: [...alreadyUnlinkedBatchIds, ...linkedBatchIds],
  };
}
