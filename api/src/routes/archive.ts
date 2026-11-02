import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ArchivedTile, ArchivePage, MediaExt, MediaMime, Ratio } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { deleteArtifact } from '../storage/files';
import { ArchiveQuerySchema, ArchiveTileParamSchema } from './archive.schema';
import { ThreadDeleteQuerySchema } from './history.schema';
import { uploadIdsForBatchScope } from '../storage/uploadStore';
import { releaseRequestUploads } from './_uploads';
import { parseDeleteKeepUploads } from './_deleteUploads';
import { refImageIdsByTile } from '../orchestrator/refImages';
import { tileArtifactUrls } from '../orchestrator/tileEvents';
import { decodeCursor, encodeCursor } from './_cursor';
import { invalidFieldResponse, parseParams, parseQuery } from './_http';
import { ARCHIVE_VISIBLE_PREDICATE } from '../db/predicates';
import {
  applySequenceMutationEffect,
  preparePermanentBatchDeletion,
  type SequenceMutationEffect,
} from '../orchestrator/sequenceLifecycle';

interface ArchivedTileRow {
  id: string;
  batch_id: string;
  batch_created_at: number;
  prompt: string;
  model_label: string;
  tile_index: number;
  seed: number;
  ext: MediaExt;
  mime: MediaMime;
  ratio: Ratio;
  completed_at: number;
  archived_at: number;
}

function unlinkArtifactBestEffort(c: Context<AppEnv>, userId: string, tileId: string, ext: MediaExt): void {
  try {
    deleteArtifact(c.var.config.DATA_DIR, 'images', userId, tileId, ext);
  } catch (error) {
    c.var.logger.warn({ err: error, userId, tileId, ext }, 'archive delete: artifact unlink failed; will be reaped at next boot');
  }
  try {
    deleteArtifact(c.var.config.DATA_DIR, 'thumbs', userId, tileId, 'webp');
  } catch (error) {
    c.var.logger.warn({ err: error, userId, tileId }, 'thumb unlink failed; will be reaped at next boot');
  }
}

function toArchivedTileWithRefs(row: ArchivedTileRow, refImageIds: readonly string[]): ArchivedTile {
  const provenance = refImageIds.length > 0 ? { refImageIds } : {};
  return {
    id: row.id,
    batchId: row.batch_id,
    prompt: row.prompt,
    modelLabel: row.model_label,
    seed: row.seed,
    status: 'done',
    ...provenance,
    ...tileArtifactUrls(row.id),
    ext: row.ext,
    mime: row.mime,
    ratio: row.ratio,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
  };
}

interface ArchiveCursor {
  archivedAt: number;
  batchId: string;
  tileIndex: number;
}

interface ArchiveScopeFilter {
  // `'null'` is the sentinel for "no collection" (mirrors the GET /history
  // query schema). Conceptually `string | 'null'`, but eslint flags the
  // literal as redundant because `string` is wider; the runtime branch on
  // `'null'` in scopeClauses is what distinguishes the two cases.
  collectionId?: string;
  pinned?: true;
}

function scopeClauses(scope: ArchiveScopeFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (scope.collectionId === 'null') {
    clauses.push('batches.collection_id IS NULL');
  } else if (scope.collectionId !== undefined) {
    clauses.push('batches.collection_id = ?');
    params.push(scope.collectionId);
  }
  if (scope.pinned === true) clauses.push('batches.pinned = 1');
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params };
}

// Order: most-recently-archived first, then batch id DESC, then tile_index
// ASC so a batch's tiles ride together in stable index order. Sorted on
// tiles.batch_id (identical to batches.id under the FK join) rather than the
// joined column so the partial covering index idx_tiles_user_archived_seek
// satisfies the whole ORDER BY on the tiles table alone — no cross-table
// TEMP B-TREE. Cursor encodes (archivedAt, batchId, tileIndex).
//
// NOT created_at: ordering by batch creation made pagination
// non-deterministic for batches archived out of creation order
// (architecture.md:187 — corrected in v6). Keep archived_at as the sort key.
function listArchive(
  db: AppEnv['Variables']['db'],
  userId: string,
  limit: number,
  cursor: ArchiveCursor | null,
  scope: ArchiveScopeFilter,
): ArchivedTileRow[] {
  const baseSelect = `SELECT tiles.id,
                tiles.batch_id,
                batches.created_at AS batch_created_at,
                batches.prompt,
                batches.model_label,
                tiles.tile_index,
                tiles.seed,
                tiles.ext,
                tiles.mime,
                batches.ratio,
                tiles.completed_at,
                tiles.archived_at
         FROM tiles
         JOIN batches ON batches.id = tiles.batch_id AND batches.user_id = tiles.user_id
         WHERE tiles.user_id = ?
           AND ${ARCHIVE_VISIBLE_PREDICATE}`;
  const orderBy = 'ORDER BY tiles.archived_at DESC, tiles.batch_id DESC, tiles.tile_index ASC';
  const scopeSql = scopeClauses(scope);
  if (!cursor) {
    return db
      .query<ArchivedTileRow, (string | number)[]>(`${baseSelect}${scopeSql.sql} ${orderBy} LIMIT ?`)
      .all(userId, ...scopeSql.params, limit);
  }
  return db
    .query<ArchivedTileRow, (string | number)[]>(
      `${baseSelect}${scopeSql.sql}
           AND (tiles.archived_at < ?
                OR (tiles.archived_at = ? AND tiles.batch_id < ?)
                OR (tiles.archived_at = ? AND tiles.batch_id = ? AND tiles.tile_index > ?))
         ${orderBy} LIMIT ?`,
    )
    .all(
      userId,
      ...scopeSql.params,
      cursor.archivedAt,
      cursor.archivedAt,
      cursor.batchId,
      cursor.archivedAt,
      cursor.batchId,
      cursor.tileIndex,
      limit,
    );
}

function archiveTotal(db: AppEnv['Variables']['db'], userId: string, scope: ArchiveScopeFilter): number {
  if (scope.collectionId !== undefined) return archiveTotalViaBatches(db, userId, scope).total;
  const scopeSql = scopeClauses(scope);
  // Mirror the JOIN from listArchive so collection_id / pinned filters can
  // reach batches columns; the row counts must match the list's filter or the
  // header total drifts from what the page actually renders.
  const row = db
    .query<{ count: number }, (string | number)[]>(
      `SELECT COUNT(*) AS count
         FROM tiles
         JOIN batches ON batches.id = tiles.batch_id AND batches.user_id = tiles.user_id
        WHERE tiles.user_id = ?
          AND ${ARCHIVE_VISIBLE_PREDICATE}${scopeSql.sql}`,
    )
    .get(userId, ...scopeSql.params);
  return row?.count ?? 0;
}

function archiveTotalViaBatches(
  db: AppEnv['Variables']['db'],
  userId: string,
  scope: ArchiveScopeFilter,
  includePlan = false,
): { total: number; plan: string } {
  const collectionSql = scope.collectionId === 'null'
    ? 'batches.collection_id IS NULL'
    : 'batches.collection_id = ?';
  const pinnedSql = scope.pinned === true ? ' AND batches.pinned = 1' : '';
  const sql = `SELECT COUNT(*) AS count
         FROM batches
         CROSS JOIN tiles
        WHERE batches.user_id = ?
          AND ${collectionSql}${pinnedSql}
          AND tiles.user_id = batches.user_id
          AND tiles.batch_id = batches.id
          AND ${ARCHIVE_VISIBLE_PREDICATE}`;
  const params = scope.collectionId === 'null'
    ? [userId]
    : [userId, scope.collectionId ?? ''];
  const row = db.query<{ count: number }, (string | number)[]>(sql).get(...params);
  const plan = includePlan
    ? db
      .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((part) => part.detail)
      .join('\n')
    : '';
  return { total: row?.count ?? 0, plan };
}

export function archiveTotalForTests(
  db: AppEnv['Variables']['db'],
  userId: string,
  scope: ArchiveScopeFilter,
): { total: number; plan: string } {
  return archiveTotalViaBatches(db, userId, scope, true);
}

const ArchiveCursorSchema = z.object({
  archivedAt: z.number().int().nonnegative(),
  batchId: z.uuid(),
  tileIndex: z.number().int().nonnegative(),
});

const encodeArchiveCursor = (cursor: ArchiveCursor): string => encodeCursor(cursor);
const decodeArchiveCursor = (raw: string | undefined): ArchiveCursor | null =>
  decodeCursor(raw, ArchiveCursorSchema);

export const archiveRoutes = new Hono<AppEnv>()
  .get('/archive', (c) => {
    const query = parseQuery(c, ArchiveQuerySchema);
    if (!query.ok) return query.response;
    const cursor = decodeArchiveCursor(query.value.cursor);
    if (query.value.cursor && !cursor) return invalidFieldResponse(c, 'cursor', 'invalid cursor');
    const scope: ArchiveScopeFilter = {
      ...(query.value.collectionId !== undefined ? { collectionId: query.value.collectionId } : {}),
      ...(query.value.pinned === true ? { pinned: true as const } : {}),
    };
    const rows = listArchive(c.var.db, c.var.userId, query.value.limit + 1, cursor, scope);
    const pageRows = rows.slice(0, query.value.limit);
    const refIdsByTile = refImageIdsByTile(c.var.db, c.var.userId, pageRows.map((row) => row.id), { archivedOnly: true });
    const last = pageRows.at(-1);
    const hasNext = rows.length > query.value.limit && last !== undefined;
    const page: ArchivePage = {
      items: pageRows.map((row) => toArchivedTileWithRefs(row, refIdsByTile.get(row.id) ?? [])),
      nextCursor: hasNext
        ? encodeArchiveCursor({
            archivedAt: last.archived_at,
            batchId: last.batch_id,
            tileIndex: last.tile_index,
          })
        : null,
      // First page only (no cursor): the COUNT is index-assisted but still
      // O(matching rows) and the value can't change between pages of one
      // scroll, so subsequent pages send null and the client carries the
      // first page's total forward.
      total: cursor ? null : archiveTotal(c.var.db, c.var.userId, scope),
    };
    return c.json(page);
  })
  .post('/archive/:tileId/restore', (c) => {
    const params = parseParams(c, ArchiveTileParamSchema);
    if (!params.ok) return params.response;
    // Defense-in-depth: only restore done tiles. The new contract is that
    // archived rows are always status='done' (failed/loading hard-deleted on
    // user removal, with migration3 purging legacy phantom rows on boot), but
    // a stale archived failed/loading row reaching this endpoint between
    // deploy and migration boot would otherwise be silently restored to
    // history.
    const tile = c.var.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM tiles WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL AND status = 'done'",
      )
      .get(params.value.tileId, c.var.userId);
    if (tile) {
      c.var.db.transaction(() => {
        c.var.db.query('UPDATE tiles SET archived_at = NULL WHERE id = ? AND user_id = ?')
          .run(params.value.tileId, c.var.userId);
        c.var.db.query(
          'UPDATE batches SET archived_at = NULL WHERE user_id = ? AND id = (SELECT batch_id FROM tiles WHERE id = ? AND user_id = ?)',
        )
          .run(c.var.userId, params.value.tileId, c.var.userId);
      })();
    }
    return c.body(null, 204);
  })
  .delete('/archive/:tileId', async (c) => {
    const params = parseParams(c, ArchiveTileParamSchema);
    if (!params.ok) return params.response;
    const query = parseQuery(c, ThreadDeleteQuerySchema);
    if (!query.ok) return query.response;
    const keepUploads = await parseDeleteKeepUploads(c, query.value.keepUploads);
    if (!keepUploads.ok) return keepUploads.response;
    let sequenceEffect: SequenceMutationEffect = { kind: 'none' };
    let releasedUploadIds: string[] = [];
    const deleted = c.var.db.transaction(() => {
      const batch = c.var.db.query<{ batch_id: string }, [string, string]>(
        'SELECT batch_id FROM tiles WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL',
      ).get(params.value.tileId, c.var.userId);
      if (batch) {
        releasedUploadIds = uploadIdsForBatchScope(
          c.var.db,
          'SELECT id FROM batches WHERE id = ? AND user_id = ?',
          [batch.batch_id, c.var.userId],
        );
        sequenceEffect = preparePermanentBatchDeletion(
          c.var.db,
          c.var.userId,
          batch.batch_id,
        );
      }
      const row = c.var.db
        .query<{ ext: MediaExt | null; batch_id: string; archived_at: number }, [string, string]>(
          'DELETE FROM tiles WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL RETURNING ext, batch_id, archived_at',
        )
        .get(params.value.tileId, c.var.userId);
      if (row) {
        c.var.db.query(
          `DELETE FROM batches
           WHERE user_id = ?
             AND id = ?
             AND archived_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM tiles WHERE user_id = ? AND batch_id = ?)`,
        )
          .run(c.var.userId, row.batch_id, c.var.userId, row.batch_id);
      }
      return row;
    })();
    applySequenceMutationEffect(c.var.config, c.var.logger, sequenceEffect);
    if (deleted?.ext) unlinkArtifactBestEffort(c, c.var.userId, params.value.tileId, deleted.ext);
    releaseRequestUploads(c, releasedUploadIds, keepUploads.value);
    return c.body(null, 204);
  })
  .delete('/archive', async (c) => {
    const query = parseQuery(c, ThreadDeleteQuerySchema);
    if (!query.ok) return query.response;
    const keepUploads = await parseDeleteKeepUploads(c, query.value.keepUploads);
    if (!keepUploads.ok) return keepUploads.response;
    let releasedUploadIds: string[] = [];
    // DELETE...RETURNING inside the transaction keeps the artifact list in
    // lock-step with the rows actually removed. A concurrent restore between
    // SELECT and DELETE would otherwise leave the restored tile pointing at
    // an unlinked artifact. The same predicate (archived_at IS NOT NULL +
    // ext IS NOT NULL) gates both the delete and the unlink — anything with
    // ext IS NULL (legacy phantom rows) gets a follow-up sweep without
    // attempting a non-existent unlink.
    const sequenceEffects: SequenceMutationEffect[] = [];
    const artifacts = c.var.db.transaction(() => {
      const batchIds = c.var.db.query<{ batch_id: string }, [string]>(
        `SELECT DISTINCT batch_id FROM tiles
          WHERE user_id = ? AND ${ARCHIVE_VISIBLE_PREDICATE}`,
      ).all(c.var.userId).map((row) => row.batch_id);
      releasedUploadIds = uploadIdsForBatchScope(
        c.var.db,
        'SELECT DISTINCT batch_id FROM tiles WHERE user_id = ? AND archived_at IS NOT NULL',
        [c.var.userId],
      );
      for (const batchId of batchIds) {
        sequenceEffects.push(
          preparePermanentBatchDeletion(c.var.db, c.var.userId, batchId),
        );
      }
      const removed = c.var.db
        .query<{ id: string; ext: MediaExt }, [string]>(
          `DELETE FROM tiles
            WHERE user_id = ?
              AND ${ARCHIVE_VISIBLE_PREDICATE}
            RETURNING id, ext`,
        )
        .all(c.var.userId);
      c.var.db
        .query('DELETE FROM tiles WHERE user_id = ? AND archived_at IS NOT NULL')
        .run(c.var.userId);
      c.var.db.query(
        `DELETE FROM batches
         WHERE user_id = ?
           AND archived_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM tiles WHERE tiles.user_id = batches.user_id AND tiles.batch_id = batches.id)`,
      )
        .run(c.var.userId);
      return removed;
    })();
    const dissolved = new Set(
      sequenceEffects.flatMap((effect) => effect.kind === 'delete-master' ? [effect.sequenceId] : []),
    );
    for (const effect of sequenceEffects) {
      if (effect.kind === 'restitch' && dissolved.has(effect.sequenceId)) continue;
      applySequenceMutationEffect(c.var.config, c.var.logger, effect);
    }
    for (const artifact of artifacts) unlinkArtifactBestEffort(c, c.var.userId, artifact.id, artifact.ext);
    releaseRequestUploads(c, releasedUploadIds, keepUploads.value);
    return c.body(null, 204);
  });

export function archiveClearVisibleDeletePlanForTests(
  db: AppEnv['Variables']['db'],
  userId: string,
): { plan: string } {
  const rows = db
    .query<{ detail: string }, [string]>(
      `EXPLAIN QUERY PLAN
       DELETE FROM tiles
        WHERE user_id = ?
          AND ${ARCHIVE_VISIBLE_PREDICATE}
       RETURNING id, ext`,
    )
    .all(userId);
  return { plan: rows.map((row) => row.detail).join('\n') };
}
