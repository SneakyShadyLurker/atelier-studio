import type { Database } from 'bun:sqlite';
import { isVideoDurationFrames } from '@atelier/shared';

export interface ExtendSource {
  readonly tileId: string;
  // The resolving query filters `t.ext = 'mp4'`.
  readonly ext: 'mp4';
  /**
   * Frame index one past the predecessor's DELIVERED end. The handoff tail is
   * cut backwards from here rather than from the end of the file: a guided
   * segment renders past this point (H3's clip grid has no point at exactly
   * `context + duration`) and the stitcher drops the excess, so anchoring on
   * the file's last frame would continue from content no viewer ever sees.
   */
  readonly endFrame: number;
}

/**
 * Resolves the segment an extension continues, from the PERSISTED handoff
 * upload rather than the in-flight request.
 *
 * This indirection is load-bearing. `extendsTileId` exists only on the request
 * built by `POST /api/generate`; `buildQueuedRequestForBatch` rebuilds a
 * dequeued or boot-re-enqueued batch from its row and cannot restore it. Since
 * the local pool is serialized, an Extend submitted while any other local
 * render is in flight takes exactly that rebuilt path — so keying the
 * continuation off the request would have silently disabled the feature for
 * the common case, with no failure and no test catching it.
 *
 * `uploads.source_tile_id` names the provenance-checked predecessor. Replaying
 * that upload in a standalone Retry/Re-roll does not make it a continuation.
 * When a continuation batch ID is supplied, require its current persisted
 * membership and the preceding segment in the same owned sequence. Returns
 * null for missing/unfinished predecessors or a legacy row with no duration.
 */
export function resolveExtendSource(
  db: Database,
  userId: string,
  i2vSourceUploadId: string | null,
  continuationBatchId?: string,
): ExtendSource | null {
  if (i2vSourceUploadId === null) return null;
  const row = db
    .query<
      { tile_id: string; ext: 'mp4'; duration_frames: number | null; context_frames: number },
      [string, string, string | null, string | null]
    >(
      `SELECT t.id AS tile_id, t.ext, b.duration_frames, b.context_frames
         FROM uploads u
         JOIN tiles t ON t.id = u.source_tile_id AND t.user_id = u.user_id
         JOIN batches b ON b.id = t.batch_id AND b.user_id = t.user_id
        WHERE u.id = ? AND u.user_id = ?
          AND u.source_tile_id IS NOT NULL
          AND t.status = 'done' AND t.ext = 'mp4'
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM batches continuation
            JOIN video_sequences s ON s.id = continuation.sequence_id AND s.user_id = continuation.user_id
            WHERE continuation.id = ? AND continuation.user_id = u.user_id
              AND continuation.i2v_source_upload_id = u.id
              AND continuation.sequence_index > 0
              AND b.sequence_id = continuation.sequence_id
              AND b.sequence_index = continuation.sequence_index - 1
              AND b.status = 'done'
          ))`,
    )
    .get(i2vSourceUploadId, userId, continuationBatchId ?? null, continuationBatchId ?? null);
  if (!row || !isVideoDurationFrames(row.duration_frames)) return null;
  return {
    tileId: row.tile_id,
    ext: row.ext,
    endFrame: row.context_frames + row.duration_frames,
  };
}
