import type { Database } from 'bun:sqlite';
import type { Config } from '../config';
import { isMediaExt } from '@atelier/shared';
import type { ByokProvider, Model, ModelAvailability, ModelGate, TileErrorCategory } from '@atelier/shared';
import { isLocalModelGated } from '../providers/registry';
import { artifactFilePath } from '../storage/files';
import { failBatchTerminally, type FailBatchTerminallyOptions } from './failBatchTerminally';
import type { QueueEntry } from './queue';
import * as bus from './bus';

interface LoggerLike {
  error(messageOrObject: unknown, message?: string): void;
  warn(messageOrObject: unknown, message?: string): void;
  info(messageOrObject: unknown, message?: string): void;
}

export interface DequeueContext {
  readonly db: Database;
  readonly config: Config;
  readonly logger: LoggerLike;
  readonly registry: {
    findModel(modelId: string, config: Config): { model: Pick<Model, 'id' | 'pool' | 'maxCountPerBatch'> & ModelGate } | null;
    healthSnapshot(): ReadonlyMap<string, Pick<ModelAvailability, 'ok' | 'reason'>>;
  };
}

export type RevalidateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TileErrorCategory };

export function revalidateAtDequeue(ctx: DequeueContext, entry: QueueEntry): RevalidateResult {
  const row = ctx.db
    .query<{
      user_id: string;
      archived_at: number | null;
      loading_count: number;
    }, [string]>(
      `SELECT b.user_id, b.archived_at,
              (SELECT COUNT(*) FROM tiles t
                WHERE t.batch_id = b.id
                  AND t.user_id = b.user_id
                  AND t.status = 'loading'
                  AND t.archived_at IS NULL) AS loading_count
         FROM batches b
        WHERE b.id = ?`,
    )
    .get(entry.batchId);

  if (!row) return { ok: false, reason: 'internal error' };
  if (row.user_id !== entry.userId) return { ok: false, reason: 'internal error' };
  if (row.archived_at !== null) return { ok: false, reason: 'internal error' };
  if (row.loading_count <= 0) return { ok: false, reason: 'internal error' };

  const model = ctx.registry.findModel(entry.modelId, ctx.config);
  if (!model) return { ok: false, reason: 'upstream rejected' };
  if (isLocalModelGated(ctx.config, entry.userId, model)) return { ok: false, reason: 'upstream rejected' };
  if (row.loading_count > model.model.maxCountPerBatch) return { ok: false, reason: 'upstream rejected' };
  if (model.model.requiresKey && !byokKeyExists(ctx.db, entry.userId, model.model.requiresKey.provider)) {
    return { ok: false, reason: 'internal error' };
  }

  // A seed entry (ok:false, no reason) only means the first probe has not
  // finished since boot; a recovered queued batch should try its host rather
  // than fail on the absence of evidence. A probed-offline entry carries a reason.
  const health = ctx.registry.healthSnapshot().get(entry.modelId);
  if (health && !health.ok && health.reason !== undefined) return { ok: false, reason: 'upstream rejected' };
  if (!queuedRefArtifactsExist(ctx.db, ctx.config.DATA_DIR, entry.batchId, entry.userId)) {
    return { ok: false, reason: 'upstream rejected' };
  }

  return { ok: true };
}

function byokKeyExists(db: Database, userId: string, provider: ByokProvider): boolean {
  const row = db
    .query<{ present: number }, [string, ByokProvider]>(
      'SELECT 1 AS present FROM user_provider_keys WHERE user_id = ? AND provider = ?',
    )
    .get(userId, provider);
  return row !== null;
}

function queuedRefArtifactsExist(
  db: Database,
  dataDir: string,
  batchId: string,
  userId: string,
): boolean {
  const refCount = db
    .query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) AS count
         FROM tile_ref_images tri
         JOIN tiles t ON t.id = tri.tile_id
        WHERE t.batch_id = ?
          AND t.user_id = ?`,
    )
    .get(batchId, userId)?.count ?? 0;
  if (refCount === 0) return true;

  const rows = db
    .query<{ id: string | null; ext: string | null }, [string, string]>(
      `SELECT u.id, u.ext
         FROM tile_ref_images tri
         JOIN tiles t ON t.id = tri.tile_id
         LEFT JOIN uploads u ON u.id = tri.upload_id AND u.user_id = t.user_id
        WHERE t.batch_id = ?
          AND t.user_id = ?
        GROUP BY tri.upload_id
        ORDER BY MIN(tri.position) ASC`,
    )
    .all(batchId, userId);
  return rows.every((row) => row.id !== null
    && row.ext !== null
    && isMediaExt(row.ext)
    && artifactFilePath(dataDir, 'uploads', userId, row.id, row.ext) !== null);
}

export function failBatchAtDequeue(
  ctx: DequeueContext,
  entry: QueueEntry,
  reason: TileErrorCategory,
  options: Pick<FailBatchTerminallyOptions, 'emitDoneOnEmpty'> = {},
): void {
  // failLoadingTiles (inside failBatchTerminally) emits the per-tile `failed`
  // frames ordered by tile_index, then `done`. emitDoneOnEmpty:false preserves
  // this path's gate: a batch with no loading tiles (already terminal'd by
  // another writer, or loadPreparedBatch returned null) must not re-emit
  // `done`. An owned retry may still owe done after a partial terminal write.
  // The bus is always closed (idempotent) so a late subscriber that
  // arrived after a prior terminal path cannot stay subscribed forever.
  failBatchTerminally(ctx.db, ctx.config, ctx.logger, entry.batchId, reason, {
    emitTerminal: (frame) => { bus.broadcastTerminal(entry.batchId, frame); },
    close: () => { bus.closeBatch(entry.batchId); },
    emitDoneOnEmpty: options.emitDoneOnEmpty ?? false,
  });
}
