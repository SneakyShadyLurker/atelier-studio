import type { Database } from 'bun:sqlite';
import type { BatchRow, TileRow } from '../db/types';
import { ensureUser } from '../db/users';
import type { RegistryEntry } from '../providers/registry';
import type { PreparedBatch, ResolvedGenerateRequest } from '../orchestrator';
import { RefImagesNotFoundError } from './refImages';

export function createBatch(
  db: Database,
  userId: string,
  req: ResolvedGenerateRequest,
  registryEntry: RegistryEntry,
): PreparedBatch {
  const now = Date.now();
  const batchId = crypto.randomUUID();
  // Provenance is best-effort metadata supplied by the client. templateId is an
  // FK into prompt_templates — validate it exists FOR THIS USER before
  // persisting. An unowned/stale id is dropped (null provenance) rather than
  // FK-violating (500) or storing another tenant's id (isolation breach).
  // Generation must still succeed (Finding B).
  const provenance = (() => {
    const p = req.provenance;
    if (!p) return null;
    const owned = db
      .query<{ id: string }, [string, string]>(
        'SELECT id FROM prompt_templates WHERE id = ? AND user_id = ?',
      )
      .get(p.templateId, userId);
    return owned ? p : null;
  })();
  const batch: BatchRow = {
    id: batchId,
    user_id: userId,
    prompt: req.prompt,
    ratio: req.ratio,
    model_id: req.modelId,
    model_label: registryEntry.model.name,
    created_at: now,
    archived_at: null,
    collection_id: null,
    pinned: 0,
    status: 'queued',
    pool: registryEntry.model.pool,
    template_id: provenance?.templateId ?? null,
    roll_seed: provenance?.rollSeed ?? null,
    roll_pins: provenance ? JSON.stringify(provenance.pins) : null,
    i2v_source_upload_id: req.i2vSourceUploadId ?? null,
    motion_prompt: req.motionPrompt ?? null,
    duration_frames: req.durationFrames ?? null,
    sequence_id: null,
    sequence_index: null,
    // Written at dispatch by whichever graph actually rendered the segment.
    context_frames: 0,
    // Written by the queued→running transition (db/queueOps).
    started_at: null,
    idempotency_key: req.idempotencyKey ?? null,
  };
  const tiles: TileRow[] = Array.from({ length: req.count }, (_, tileIndex) => ({
    id: crypto.randomUUID(),
    batch_id: batchId,
    user_id: userId,
    tile_index: tileIndex,
    // DECISION: When the client does not supply a seed, use stable display-order
    // seeds so the mock provider remains deterministic in tests.
    seed: (req.seed ?? 1) + tileIndex,
    status: 'loading',
    ext: null,
    mime: null,
    error: null,
    completed_at: null,
    archived_at: null,
  }));

  db.transaction(() => {
    ensureUser(db, userId, now);
    // The existing user/created_at index supplies a durable acceptance clock.
    // UUID order cannot break same-millisecond ties, and wall time can regress.
    // Include every row (running, completed or archived), across all pools.
    const latest = db.query<{ created_at: number }, [string]>(
      'SELECT created_at FROM batches WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    ).get(userId);
    batch.created_at = Math.max(now, latest === null ? now : latest.created_at + 1);
    // Write every BatchRow column explicitly. Relying on DB-level defaults for
    // archived_at/collection_id/pinned would let a future migration's column
    // default drift from the typed shape we just constructed in memory.
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at, collection_id, pinned, status, pool, template_id, roll_seed, roll_pins, i2v_source_upload_id, motion_prompt, duration_frames, sequence_id, sequence_index, context_frames, started_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      batch.id,
      batch.user_id,
      batch.prompt,
      batch.ratio,
      batch.model_id,
      batch.model_label,
      batch.created_at,
      batch.archived_at,
      batch.collection_id,
      batch.pinned,
      batch.status,
      batch.pool,
      batch.template_id,
      batch.roll_seed,
      batch.roll_pins,
      batch.i2v_source_upload_id,
      batch.motion_prompt,
      batch.duration_frames,
      batch.sequence_id,
      batch.sequence_index,
      batch.context_frames,
      batch.started_at,
      batch.idempotency_key,
    );
    // Same shape for tiles: ext/mime/error/completed_at/archived_at are NULL on insert.
    const insertTile = db.query(
      'INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertRef = db.query<{ upload_id: string }, [string, number, string, string]>(
      `INSERT INTO tile_ref_images (tile_id, upload_id, position)
       SELECT ?, id, ? FROM uploads WHERE id = ? AND user_id = ?
       RETURNING upload_id`,
    );
    for (const tile of tiles) {
      insertTile.run(
        tile.id,
        tile.batch_id,
        tile.user_id,
        tile.tile_index,
        tile.seed,
        tile.status,
        tile.ext,
        tile.mime,
        tile.error,
        tile.completed_at,
        tile.archived_at,
      );
      if (req.refImageIds) {
        for (const [position, uploadId] of req.refImageIds.entries()) {
          const inserted = insertRef.get(tile.id, position, uploadId, userId);
          if (!inserted) throw new RefImagesNotFoundError();
        }
      }
    }
  }).immediate();

  return { batch, tiles };
}
