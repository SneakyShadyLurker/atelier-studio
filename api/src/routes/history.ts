import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { invalidFieldResponse, parseBody, parseParams, parseQuery } from './_http';
import { decodeCursor, encodeCursor } from './_cursor';
import { isVideoDurationFrames } from '@atelier/shared';
import type { Batch, HistoryPage, Pool, StorySummary, Tile, VideoSequenceSummary } from '@atelier/shared';
import type { BatchRow, TileRow } from '../db/types';
import { BATCH_COLUMNS, TILE_COLUMNS } from '../db/columns';
import { tileModeration } from '../db/moderation';
import type { AppEnv } from '../server-env';
import { ClientDisconnectedError, UserCanceledError } from '../orchestrator/cancellation';
import { refImageIdsByTile } from '../orchestrator/refImages';
import * as registry from '../orchestrator/registry';
import { PatchBatchBody } from './collections.schema';
import { HistoryDeleteQuerySchema, HistoryQuerySchema, ThreadDeleteQuerySchema, TileDeleteParamSchema, UuidParamSchema } from './history.schema';
import { uploadIdsForBatchScope } from '../storage/uploadStore';
import { releaseRequestUploads } from './_uploads';
import { parseDeleteKeepUploads } from './_deleteUploads';
import { tileArtifactUrls } from '../orchestrator/tileEvents';
import { softArchiveOrDeleteBatch, softArchiveOrDeleteTile, SQL_TOMBSTONE_DELETE_STATUSES } from '../db/tombstone';
import * as queue from '../orchestrator/queue';
import * as bus from '../orchestrator/bus';
import { terminalFrame } from '../lifecycle/sse';
import { withTimedDb } from '../observability/db';
import { kickQueues } from '../orchestrator/dispatch';
import { fetchSequenceSummaries } from '../db/sequences';
import {
  applySequenceMutationEffect,
  autoUnlinkSequenceBatch,
  type SequenceMutationEffect,
} from '../orchestrator/sequenceLifecycle';
import { notifyStoryBatchTerminal } from '../orchestrator/storyDriver';
import { queueSlotsFor } from '../providers/registry';

const MAX_SQLITE_PARAMS_PER_QUERY = 500;

function kickQueuesAfterQueuedCancellation(c: Context<AppEnv>): void {
  kickQueues({
    db: c.var.db,
    config: c.var.config,
    logger: c.var.logger,
    keyStore: c.var.keyStore,
    healthSnapshot: c.var.healthSnapshot,
  });
}

interface HistoryCursor {
  createdAt: number;
  id: string;
}

interface HistoryFilters {
  userId: string;
  collectionId?: string;
  pinned?: true;
  q?: string;
  cursor?: HistoryCursor;
}

interface QueuedCancellation {
  batchId: string;
  pool: Pool;
  tiles: { tileId: string; tileIndex: number }[];
}

interface QueuedTileCancellation {
  batchId: string;
  pool: Pool;
  tileId: string;
  tileIndex: number;
}

export const historyRoutes = new Hono<AppEnv>()
  .get('/history', (c) => {
    const query = parseQuery(c, HistoryQuerySchema);
    if (!query.ok) return query.response;
    const cursor = decodeHistoryCursor(query.value.cursor);
    if (query.value.cursor && !cursor) return invalidFieldResponse(c, 'cursor', 'invalid cursor');
    const filters: HistoryFilters = {
      userId: c.var.userId,
      ...(query.value.collectionId !== undefined ? { collectionId: query.value.collectionId } : {}),
      ...(query.value.pinned !== undefined ? { pinned: query.value.pinned } : {}),
      ...(query.value.q !== undefined ? { q: query.value.q } : {}),
      ...(cursor ? { cursor } : {}),
    };
    return withTimedDb(
      c.var.logger,
      { sqlPrefix: 'history_page', route: 'GET /api/history' },
      () => {
        const rows = listBatches(c.var.db, filters, query.value.limit + 1);
        const pageRows = rows.slice(0, query.value.limit);
        // Bulk-fetch every tile for the page in a single query rather than
        // running one tiles SELECT per batch (prior shape was 1 + N queries
        // per page; default page size 20 → 21 roundtrips). SQLite's parameter
        // limit is 32766; HistoryQuerySchema caps `limit` at 50.
        const tilesByBatch = pageRows.length === 0
          ? new Map<string, TileRow[]>()
          : fetchTilesForBatches(c.var.db, c.var.userId, pageRows.map((r) => r.id));
        const allTiles = [...tilesByBatch.values()].flat();
        const refIdsByTile = allTiles.length === 0
          ? new Map<string, string[]>()
          : refImageIdsByTile(c.var.db, c.var.userId, allTiles.map((tile) => tile.id));
        // Resolve provenance template names in ONE bulk query for the whole
        // page (Finding D) rather than one SELECT per provenance-bearing row.
        const namesByTemplateId = fetchTemplateNamesForBatches(c.var.db, c.var.userId, pageRows);
        const summariesBySequenceId = fetchSequenceSummaries(
          c.var.db,
          c.var.userId,
          pageRows.flatMap((row) => row.sequence_id === null ? [] : [row.sequence_id]),
        );
        const storiesByBatchId = fetchStorySummaries(
          c.var.db,
          c.var.userId,
          pageRows.map((row) => row.id),
        );
        const items = pageRows.map((row) =>
          toPublicBatch(
            c.var.db,
            row,
            tilesByBatch.get(row.id) ?? [],
            refIdsByTile,
            namesByTemplateId,
            summariesBySequenceId,
            storiesByBatchId,
          ));
        const last = pageRows.at(-1);
        const hasNext = rows.length > query.value.limit && last !== undefined;
        const page: HistoryPage<Batch> = {
          items,
          nextCursor: hasNext ? encodeHistoryCursor(last.created_at, last.id) : null,
        };
        return c.json(page);
      },
    );
  })
  .patch('/history/:batchId', async (c) => {
    const params = parseParams(c, UuidParamSchema);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, PatchBatchBody);
    if (!parsed.ok) return parsed.response;

    const result = c.var.db.transaction(():
      | { status: 'missing' }
      | { status: 'archived' }
      | { status: 'collection-missing' }
      | { status: 'ok'; batch: BatchRow } => {
      const batch = c.var.db
        .query<BatchRow, [string, string]>(`SELECT ${BATCH_COLUMNS} FROM batches WHERE id = ? AND user_id = ?`)
        .get(params.value.batchId, c.var.userId);
      if (!batch) return { status: 'missing' };
      if (batch.archived_at !== null) return { status: 'archived' };
      if (parsed.value.collectionId !== undefined && parsed.value.collectionId !== null) {
        const collection = c.var.db
          .query<{ one: number }, [string, string]>('SELECT 1 AS one FROM collections WHERE id = ? AND user_id = ?')
          .get(parsed.value.collectionId, c.var.userId);
        if (!collection) return { status: 'collection-missing' };
      }

      const setClauses: string[] = [];
      const values: (string | number | null)[] = [];
      if (parsed.value.collectionId !== undefined) {
        setClauses.push('collection_id = ?');
        values.push(parsed.value.collectionId);
      }
      if (parsed.value.pinned !== undefined) {
        setClauses.push('pinned = ?');
        values.push(parsed.value.pinned ? 1 : 0);
      }
      const updated = c.var.db
        .query<BatchRow, (string | number | null)[]>(
          `UPDATE batches SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ? RETURNING ${BATCH_COLUMNS}`,
        )
        .get(...values, params.value.batchId, c.var.userId);
      if (!updated) return { status: 'missing' };
      return { status: 'ok', batch: updated };
    })();

    if (result.status === 'missing' || result.status === 'collection-missing') return c.body(null, 404);
    if (result.status === 'archived') return c.json({ error: 'batch is archived' }, 409);
    const tilesByBatch = fetchTilesForBatches(c.var.db, c.var.userId, [result.batch.id]);
    const tiles = tilesByBatch.get(result.batch.id) ?? [];
    const refIdsByTile = tiles.length === 0
      ? new Map<string, string[]>()
      : refImageIdsByTile(c.var.db, c.var.userId, tiles.map((tile) => tile.id));
    return c.json(toPublicBatch(c.var.db, result.batch, tiles, refIdsByTile));
  })
  .delete('/history', async (c) => {
    // Registry-stub contract: dequeue and immediate-start generation paths
    // pre-register a batch AbortController before their first cancellable
    // await or detached pipeline handoff. A running DB row can therefore
    // still be in setup (BYOK key load / ref-image resolution); if it has a
    // registry entry, DELETE must treat that as cancel intent and abort the
    // stub after the tombstone transaction commits.
    const query = parseQuery(c, HistoryDeleteQuerySchema);
    if (!query.ok) return query.response;
    const keepUploads = await parseDeleteKeepUploads(c, query.value.keepUploads);
    if (!keepUploads.ok) return keepUploads.response;
    const filters: HistoryFilters = {
      userId: c.var.userId,
      ...(query.value.collectionId !== undefined ? { collectionId: query.value.collectionId } : {}),
      ...(query.value.pinned !== undefined ? { pinned: query.value.pinned } : {}),
    };
    const predicate = historyPredicate(filters);
    const tileScopeSql = `batch_id IN (SELECT id FROM batches ${predicate.where})`;
    const now = Date.now();
    const controllersToAbort: AbortController[] = [];
    const queuedCancellations: QueuedCancellation[] = [];
    const sequenceEffects: SequenceMutationEffect[] = [];
    const deletedBatchIds: string[] = [];
    let releasedUploadIds: string[] = [];
    c.var.db.transaction(() => {
      releasedUploadIds = uploadIdsForBatchScope(c.var.db, `SELECT id FROM batches ${predicate.where}`, predicate.params);
      // Snapshot-consistency: the loading-batch read, the cancel-intent
      // classification, and the deletes all run inside one synchronous
      // transaction callback. JS is single-threaded with no `await` here, so
      // an orchestrator worker cannot flip a `loading` row to `done` between
      // the classification read and the DELETE — a tile that completes in the
      // cancel window is consistently hard-deleted (cancel intent), never
      // half-classified. The registry lookup is a pure Map read; the
      // side-effecting `AbortController.abort()` is deferred to AFTER commit
      // (it dispatches abort listeners SYNCHRONOUSLY — a throwing or
      // re-entrant listener fired inside this callback could roll back or
      // corrupt the delete txn). Post-commit the orchestrator worker's
      // guarded `WHERE status='loading'` UPDATE no-ops on the deleted row, so
      // ordering stays correct.
      const inFlightBatchIds = c.var.db
        .query<{ id: string }, typeof predicate.params>(
          `SELECT DISTINCT b.id FROM batches b
             JOIN tiles t ON t.batch_id = b.id
             WHERE t.status = 'loading' AND t.archived_at IS NULL AND b.id IN (SELECT id FROM batches ${predicate.where})`,
        )
        .all(...predicate.params)
        .map((row) => row.id);
      const cancelIntentBatchIds: string[] = [];
      for (const batchId of inFlightBatchIds) {
        const entry = registry.getBatchForUser(batchId, c.var.userId);
        if (!entry) continue;
        controllersToAbort.push(entry.batchController);
        cancelIntentBatchIds.push(batchId);
      }
      queuedCancellations.push(...queuedCancellationSnapshots(c.var.db, c.var.userId, predicate.where, predicate.params));
      const canceledBatchIds = new Set([
        ...cancelIntentBatchIds,
        ...queuedCancellations.map((cancellation) => cancellation.batchId),
      ]);
      for (const batchId of canceledBatchIds) {
        sequenceEffects.push(autoUnlinkSequenceBatch(c.var.db, c.var.userId, batchId));
      }
      // Bulk scope is predicate-based (divergent from the per-batch/per-tile
      // helpers by design) but the tombstone POLICY — which statuses
      // hard-delete vs archive — is owned by db/tombstone.ts.
      c.var.db.query(
        `DELETE FROM tiles WHERE user_id = ? AND archived_at IS NULL AND ${SQL_TOMBSTONE_DELETE_STATUSES} AND ${tileScopeSql}`,
      ).run(c.var.userId, ...predicate.params);
      if (cancelIntentBatchIds.length > 0) {
        for (let offset = 0; offset < cancelIntentBatchIds.length; offset += MAX_SQLITE_PARAMS_PER_QUERY) {
          const chunk = cancelIntentBatchIds.slice(offset, offset + MAX_SQLITE_PARAMS_PER_QUERY);
          const cancelIntentPlaceholders = chunk.map(() => '?').join(',');
          c.var.db.query(
            // batch_id IN (cancelIntentPlaceholders) narrows the hard-delete
            // to ONLY in-flight (cancel-intent) batches; `tileScopeSql`
            // matches every batch in the bulk predicate (a superset). Without
            // the narrow filter the DELETE would hard-delete `done` tiles for
            // non-cancel-intent batches too, violating per-batch tombstone
            // semantics (see softArchiveOrDeleteBatch).
            `DELETE FROM tiles WHERE user_id = ? AND archived_at IS NULL AND status = 'done' AND batch_id IN (${cancelIntentPlaceholders}) AND ${tileScopeSql}`,
          ).run(c.var.userId, ...chunk, ...predicate.params);
        }
      }
      c.var.db.query(
        `UPDATE tiles SET archived_at = ? WHERE user_id = ? AND archived_at IS NULL AND status = 'done' AND ${tileScopeSql}`,
      ).run(now, c.var.userId, ...predicate.params);
      deletedBatchIds.push(...c.var.db.query<{ id: string }, typeof predicate.params>(
        `DELETE FROM batches ${predicate.where}
           AND NOT EXISTS (SELECT 1 FROM tiles WHERE tiles.user_id = batches.user_id AND tiles.batch_id = batches.id)
         RETURNING id`,
      ).all(...predicate.params).map((row) => row.id));
      c.var.db.query(`UPDATE batches SET archived_at = ? ${predicate.where}`)
        .run(now, ...predicate.params);
    })();
    for (const effect of sequenceEffects) {
      applySequenceMutationEffect(c.var.config, c.var.logger, effect);
    }
    releaseRequestUploads(c, releasedUploadIds, keepUploads.value);
    for (const batchId of deletedBatchIds) notifyStoryBatchTerminal(batchId, false);
    for (const cancellation of queuedCancellations) cancelQueuedBatch(cancellation, now);
    if (queuedCancellations.length > 0) kickQueuesAfterQueuedCancellation(c);
    // Post-commit: abort the in-flight controllers now that the delete txn
    // has durably committed. Synchronous abort-listener dispatch can no
    // longer affect the transaction.
    for (const controller of controllersToAbort) controller.abort(new UserCanceledError());
    return c.body(null, 204);
  })
  .delete('/history/:batchId', async (c) => {
    // Registry-stub contract: dequeue and immediate-start generation paths
    // pre-register a batch AbortController before their first cancellable
    // await or detached pipeline handoff. A running DB row can therefore
    // still be in setup (BYOK key load / ref-image resolution); if it has a
    // registry entry, DELETE must treat that as cancel intent and abort the
    // stub after the tombstone transaction commits.
    const params = parseParams(c, UuidParamSchema);
    if (!params.ok) return params.response;
    const query = parseQuery(c, ThreadDeleteQuerySchema);
    if (!query.ok) return query.response;
    const keepUploads = await parseDeleteKeepUploads(c, query.value.keepUploads);
    if (!keepUploads.ok) return keepUploads.response;
    const now = Date.now();
    const entry = registry.getBatchForUser(params.value.batchId, c.var.userId);
    const queuedCancellation = queuedCancellationSnapshot(c.var.db, c.var.userId, params.value.batchId);
    const cancelIntent = entry !== undefined;
    let sequenceEffect: SequenceMutationEffect = { kind: 'none' };
    if (entry && entry.batchController.signal.aborted
        && entry.batchController.signal.reason instanceof ClientDisconnectedError) {
      // Tab disconnected first, then a sibling tab's DELETE arrived. Once a
      // signal is aborted its reason is immutable, so the second abort below
      // is a no-op. Log the race so an operator can grep for it; behavior is
      // already correct (cancelIntent=true → hard-delete done tiles).
      c.var.logger.info(
        { batchId: params.value.batchId, event: 'cancel_after_disconnect' },
        'DELETE batch followed an earlier client disconnect',
      );
    }
    const { uploadIds: releasedUploadIds, batchDeleted } = c.var.db.transaction(() => {
      const uploadIds = batchUploadIds(c, params.value.batchId);
      if (cancelIntent || queuedCancellation !== null) {
        sequenceEffect = autoUnlinkSequenceBatch(
          c.var.db,
          c.var.userId,
          params.value.batchId,
        );
      }
      const deleted = softArchiveOrDeleteBatch(c.var.db, c.var.userId, params.value.batchId, { cancelIntent: cancelIntent || queuedCancellation !== null, now });
      return { uploadIds, batchDeleted: deleted };
    })();
    applySequenceMutationEffect(c.var.config, c.var.logger, sequenceEffect);
    releaseRequestUploads(c, releasedUploadIds, keepUploads.value);
    if (batchDeleted) notifyStoryBatchTerminal(params.value.batchId, false);
    if (queuedCancellation) {
      cancelQueuedBatch(queuedCancellation, now);
      kickQueuesAfterQueuedCancellation(c);
    }
    // Post-commit abort: same invariant as bulk DELETE /history — abort()
    // dispatches its listeners synchronously, so it must run after the
    // delete txn has durably committed, never inside the txn callback.
    entry?.batchController.abort(new UserCanceledError());
    return c.body(null, 204);
  })
  .delete('/history/:batchId/:tileId', async (c) => {
    const params = parseParams(c, TileDeleteParamSchema);
    if (!params.ok) return params.response;
    const query = parseQuery(c, ThreadDeleteQuerySchema);
    if (!query.ok) return query.response;
    const keepUploads = await parseDeleteKeepUploads(c, query.value.keepUploads);
    if (!keepUploads.ok) return keepUploads.response;
    const now = Date.now();
    const entry = registry.getBatchForUser(params.value.batchId, c.var.userId);
    const tileController = entry?.tileControllers.get(params.value.tileId);
    const queuedCancellation = queuedTileCancellationSnapshot(c.var.db, c.var.userId, params.value.batchId, params.value.tileId);
    const cancelIntent = tileController !== undefined || queuedCancellation !== null;
    let sequenceEffect: SequenceMutationEffect = { kind: 'none' };
    const { uploadIds: releasedUploadIds, batchDeleted } = c.var.db.transaction(() => {
      const uploadIds = batchUploadIds(c, params.value.batchId);
      if (cancelIntent) {
        sequenceEffect = autoUnlinkSequenceBatch(
          c.var.db,
          c.var.userId,
          params.value.batchId,
        );
      }
      const deleted = softArchiveOrDeleteTile(c.var.db, c.var.userId, params.value.batchId, params.value.tileId, { cancelIntent, now });
      return { uploadIds, batchDeleted: deleted };
    })();
    applySequenceMutationEffect(c.var.config, c.var.logger, sequenceEffect);
    releaseRequestUploads(c, releasedUploadIds, keepUploads.value);
    if (batchDeleted) notifyStoryBatchTerminal(params.value.batchId, false);
    if (queuedCancellation) {
      const remainingTiles = queuedLoadingTileCount(c.var.db, c.var.userId, params.value.batchId);
      const modelId = c.var.db.query<{ model_id: string }, [string]>(
        'SELECT model_id FROM batches WHERE id = ?',
      ).get(params.value.batchId)?.model_id;
      const remainingSlots = modelId === undefined
        ? remainingTiles
        : queueSlotsFor(c.var.config, modelId, remainingTiles);
      cancelQueuedTile(queuedCancellation, remainingSlots, now);
      kickQueuesAfterQueuedCancellation(c);
    }
    // Post-commit abort: see bulk DELETE /history rationale (synchronous
    // abort-listener dispatch must not run inside the delete txn).
    tileController?.abort(new UserCanceledError());
    return c.body(null, 204);
  });

function batchUploadIds(c: Context<AppEnv>, batchId: string): string[] {
  return uploadIdsForBatchScope(c.var.db, 'SELECT id FROM batches WHERE id = ? AND user_id = ?', [batchId, c.var.userId]);
}

function listBatches(
  db: AppEnv['Variables']['db'],
  filters: HistoryFilters,
  limit: number,
): BatchRow[] {
  const predicate = historyPredicate(filters);
  return db
    .query<BatchRow, (string | number)[]>(
      `SELECT ${BATCH_COLUMNS} FROM batches ${predicate.where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...predicate.params, limit);
}

function historyPredicate(filters: HistoryFilters): { where: string; params: (string | number)[] } {
  const clauses = ['user_id = ?', 'archived_at IS NULL'];
  const params: (string | number)[] = [filters.userId];
  if (filters.cursor) {
    clauses.push('(created_at, id) < (?, ?)');
    params.push(filters.cursor.createdAt, filters.cursor.id);
  }
  if (filters.collectionId === 'null') {
    clauses.push('collection_id IS NULL');
  } else if (filters.collectionId !== undefined) {
    clauses.push('collection_id = ?');
    params.push(filters.collectionId);
  }
  if (filters.pinned === true) clauses.push('pinned = 1');
  if (filters.q !== undefined && filters.q.length > 0) {
    if (filters.q.trim().length >= 3) {
      clauses.push(
        `id IN (
          SELECT batch_id
            FROM batch_prompt_fts
           WHERE batch_prompt_fts MATCH ?
             AND user_id = ?
        )`,
      );
      params.push(ftsPhrase(filters.q), filters.userId);
    } else {
      const escaped = filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      clauses.push("prompt LIKE ? ESCAPE '\\' COLLATE NOCASE");
      params.push(`%${escaped}%`);
    }
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

function ftsPhrase(q: string): string {
  return `"${q.trim().replace(/"/g, '""')}"`;
}

function queuedCancellationSnapshot(
  db: AppEnv['Variables']['db'],
  userId: string,
  batchId: string,
): QueuedCancellation | null {
  const batch = db
    .query<{ id: string; pool: Pool }, [string, string]>(
      "SELECT id, pool FROM batches WHERE id = ? AND user_id = ? AND status = 'queued'",
    )
    .get(batchId, userId);
  if (!batch) return null;
  const tiles = db
    .query<{ id: string; tile_index: number }, [string, string]>(
      "SELECT id, tile_index FROM tiles WHERE batch_id = ? AND user_id = ? AND status = 'loading' ORDER BY tile_index ASC",
    )
    .all(batchId, userId)
    .map((tile) => ({ tileId: tile.id, tileIndex: tile.tile_index }));
  return { batchId: batch.id, pool: batch.pool, tiles };
}

function queuedTileCancellationSnapshot(
  db: AppEnv['Variables']['db'],
  userId: string,
  batchId: string,
  tileId: string,
): QueuedTileCancellation | null {
  const row = db
    .query<{ batch_id: string; pool: Pool; tile_id: string; tile_index: number }, [string, string, string]>(
      `SELECT b.id AS batch_id, b.pool, t.id AS tile_id, t.tile_index
         FROM batches b
         JOIN tiles t ON t.batch_id = b.id AND t.user_id = b.user_id
        WHERE b.id = ?
          AND b.user_id = ?
          AND b.status = 'queued'
          AND t.id = ?
          AND t.status = 'loading'
          AND t.archived_at IS NULL`,
    )
    .get(batchId, userId, tileId);
  if (!row) return null;
  return { batchId: row.batch_id, pool: row.pool, tileId: row.tile_id, tileIndex: row.tile_index };
}

function queuedLoadingTileCount(
  db: AppEnv['Variables']['db'],
  userId: string,
  batchId: string,
): number {
  return db
    .query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) AS count
         FROM tiles
        WHERE user_id = ?
          AND batch_id = ?
          AND status = 'loading'
          AND archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM batches
             WHERE batches.id = tiles.batch_id
               AND batches.user_id = tiles.user_id
               AND batches.status = 'queued'
          )`,
    )
    .get(userId, batchId)?.count ?? 0;
}

function queuedCancellationSnapshots(
  db: AppEnv['Variables']['db'],
  userId: string,
  predicateWhere: string,
  predicateParams: readonly (string | number)[],
): QueuedCancellation[] {
  const rows = db
    .query<{ batch_id: string; pool: Pool; tile_id: string; tile_index: number }, (string | number)[]>(
      `SELECT b.id AS batch_id, b.pool, t.id AS tile_id, t.tile_index
         FROM batches b
         JOIN tiles t ON t.batch_id = b.id AND t.user_id = b.user_id
        WHERE b.user_id = ?
          AND b.status = 'queued'
          AND t.status = 'loading'
          AND t.archived_at IS NULL
          AND b.id IN (SELECT id FROM batches ${predicateWhere})
        ORDER BY b.created_at ASC, b.id ASC, t.tile_index ASC`,
    )
    .all(userId, ...predicateParams);
  const snapshots: QueuedCancellation[] = [];
  const byBatch = new Map<string, QueuedCancellation>();
  for (const row of rows) {
    let snapshot = byBatch.get(row.batch_id);
    if (!snapshot) {
      snapshot = { batchId: row.batch_id, pool: row.pool, tiles: [] };
      byBatch.set(row.batch_id, snapshot);
      snapshots.push(snapshot);
    }
    snapshot.tiles.push({ tileId: row.tile_id, tileIndex: row.tile_index });
  }
  return snapshots;
}

function cancelQueuedTile(cancellation: QueuedTileCancellation, remainingCount: number, completedAt: number): void {
  if (remainingCount > 0) {
    queue.updateCount(cancellation.pool, cancellation.batchId, remainingCount);
  } else {
    queue.removeById(cancellation.pool, cancellation.batchId);
  }
  bus.broadcastTerminal(
    cancellation.batchId,
    terminalFrame('tile', {
      tileId: cancellation.tileId,
      tileIndex: cancellation.tileIndex,
      status: 'canceled',
      completedAt,
    }),
  );
  if (remainingCount === 0) {
    bus.broadcastTerminal(cancellation.batchId, terminalFrame('done', { batchId: cancellation.batchId }));
    bus.closeBatch(cancellation.batchId);
  }
}

function cancelQueuedBatch(cancellation: QueuedCancellation, completedAt: number): void {
  queue.removeById(cancellation.pool, cancellation.batchId);
  for (const tile of cancellation.tiles) {
    bus.broadcastTerminal(
      cancellation.batchId,
      terminalFrame('tile', {
        tileId: tile.tileId,
        tileIndex: tile.tileIndex,
        status: 'canceled',
        completedAt,
      }),
    );
  }
  bus.broadcastTerminal(cancellation.batchId, terminalFrame('done', { batchId: cancellation.batchId }));
  bus.closeBatch(cancellation.batchId);
}

// The bulk readers bind their id list as ONE JSON array through `json_each`,
// so each is a single fixed-shape statement (one query-cache entry, no SQLite
// parameter cap) whatever the page size. Where the planner would otherwise
// scan the user's rows, `json_each(?) CROSS JOIN …` pins the id list as the
// driving table so each id is still a point lookup.
function fetchTilesForBatches(
  db: AppEnv['Variables']['db'],
  userId: string,
  batchIds: readonly string[],
): Map<string, TileRow[]> {
  if (batchIds.length === 0) return new Map();
  // Defense-in-depth user_id scope is preserved on the bulk shape: a
  // future change that loosens listBatches' user filter still can't leak
  // across users because every tiles query carries `user_id = ?`.
  const rows = db
    .query<TileRow, [string, string]>(
      `SELECT ${TILE_COLUMNS} FROM tiles
        WHERE user_id = ? AND batch_id IN (SELECT value FROM json_each(?)) AND archived_at IS NULL
        ORDER BY batch_id ASC, tile_index ASC`,
    )
    .all(userId, JSON.stringify(batchIds));
  return Map.groupBy(rows, (row) => row.batch_id);
}

function parseRollPins(raw: string | null): Readonly<Record<string, string>> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Bulk-resolve provenance template names for a page of batches in a single
// query scoped by user_id, rather than one SELECT per provenance-bearing row
// (Finding D — N+1 on the hot history feed). Distinct template_ids only.
function fetchTemplateNamesForBatches(
  db: AppEnv['Variables']['db'],
  userId: string,
  batches: readonly BatchRow[],
): Map<string, string> {
  const ids = [...new Set(
    batches.flatMap((b) => (b.roll_seed !== null && b.template_id !== null ? [b.template_id] : [])),
  )];
  if (ids.length === 0) return new Map();
  const rows = db
    .query<{ id: string; name: string }, [string, string]>(
      `SELECT t.id, t.name
         FROM json_each(?) ids
         CROSS JOIN prompt_templates t ON t.id = ids.value
        WHERE t.user_id = ?`,
    )
    .all(JSON.stringify(ids), userId);
  return new Map(rows.map((row) => [row.id, row.name]));
}

function fetchStorySummaries(
  db: AppEnv['Variables']['db'],
  userId: string,
  batchIds: readonly string[],
): Map<string, StorySummary> {
  if (batchIds.length === 0) return new Map();
  const rows = db.query<{
    batch_id: string;
    id: string;
    status: StorySummary['status'];
    segment_index: number;
    segment_count: number;
    logline: string;
    eta_ms: number;
  }, [string, string]>(
    `SELECT ss.batch_id, s.id, s.status, ss.idx AS segment_index,
            (SELECT COUNT(*) FROM story_segments all_segments WHERE all_segments.story_id = s.id) AS segment_count,
            s.logline, s.eta_ms
       FROM json_each(?) ids
       CROSS JOIN story_segments ss ON ss.batch_id = ids.value
       JOIN stories s ON s.id = ss.story_id AND s.user_id = ss.user_id
      WHERE ss.user_id = ?`,
  ).all(JSON.stringify(batchIds), userId);
  return new Map(rows.map((row) => [row.batch_id, {
    id: row.id,
    status: row.status,
    segmentIndex: row.segment_index,
    segmentCount: row.segment_count,
    logline: row.logline,
    etaMs: row.eta_ms,
  }]));
}

function batchProvenance(
  db: AppEnv['Variables']['db'],
  batch: BatchRow,
  nameByTemplateId?: ReadonlyMap<string, string>,
): Batch['provenance'] | undefined {
  if (batch.roll_seed === null) return undefined;
  let templateName: string | null = null;
  if (batch.template_id !== null) {
    // List path passes a prebuilt name-map (one bulk query for the whole
    // page); single-batch callers omit it and fall back to a scoped lookup.
    templateName = nameByTemplateId
      ? nameByTemplateId.get(batch.template_id) ?? null
      : db
          .query<{ name: string }, [string, string]>('SELECT name FROM prompt_templates WHERE id = ? AND user_id = ?')
          .get(batch.template_id, batch.user_id)?.name ?? null;
  }
  return {
    templateId: batch.template_id,
    templateName,
    rollSeed: batch.roll_seed,
    pins: parseRollPins(batch.roll_pins),
  };
}

function toPublicBatch(
  db: AppEnv['Variables']['db'],
  batch: BatchRow,
  tiles: readonly TileRow[],
  refIdsByTile: ReadonlyMap<string, readonly string[]>,
  nameByTemplateId?: ReadonlyMap<string, string>,
  summaryBySequenceId?: ReadonlyMap<string, VideoSequenceSummary>,
  storyByBatchId?: ReadonlyMap<string, StorySummary>,
): Batch {
  const queuePosition = batch.status === 'queued' ? queue.positionOf(batch.pool, batch.id) : -1;
  const provenance = batchProvenance(db, batch, nameByTemplateId);
  if ((batch.sequence_id === null) !== (batch.sequence_index === null)) {
    throw new Error('batch has incomplete video sequence membership');
  }
  const sequence = batch.sequence_id === null
    ? undefined
    : summaryBySequenceId?.get(batch.sequence_id)
      ?? fetchSequenceSummaries(db, batch.user_id, [batch.sequence_id]).get(batch.sequence_id);
  if (batch.sequence_id !== null && sequence === undefined) {
    throw new Error('batch references a missing or unowned video sequence');
  }
  const story = storyByBatchId
    ? storyByBatchId.get(batch.id)
    : fetchStorySummaries(db, batch.user_id, [batch.id]).get(batch.id);
  return {
    id: batch.id,
    prompt: batch.prompt,
    ratio: batch.ratio,
    ...(isVideoDurationFrames(batch.duration_frames) ? { durationFrames: batch.duration_frames } : {}),
    modelId: batch.model_id,
    modelLabel: batch.model_label,
    createdAt: batch.created_at,
    ...(batch.started_at !== null ? { startedAt: batch.started_at } : {}),
    collectionId: batch.collection_id,
    pinned: batch.pinned === 1,
    status: batch.status,
    ...(queuePosition >= 0 ? { queueLengthAhead: queuePosition } : {}),
    ...(provenance ? { provenance } : {}),
    ...(batch.i2v_source_upload_id ? { i2vSourceUploadId: batch.i2v_source_upload_id } : {}),
    ...(story ? { story } : {}),
    ...(batch.sequence_id !== null && batch.sequence_index !== null && sequence !== undefined
      ? {
          sequenceId: batch.sequence_id,
          sequenceIndex: batch.sequence_index,
          sequence,
        }
      : {}),
    tiles: tiles.map((tile) => toPublicTile(tile, refIdsByTile.get(tile.id) ?? [])),
  };
}

export function toPublicBatchForTest(
  db: AppEnv['Variables']['db'],
  batch: BatchRow,
  tiles: readonly TileRow[],
  refIdsByTile: ReadonlyMap<string, readonly string[]>,
  nameByTemplateId?: ReadonlyMap<string, string>,
  summaryBySequenceId?: ReadonlyMap<string, VideoSequenceSummary>,
  storyByBatchId?: ReadonlyMap<string, StorySummary>,
): Batch {
  return toPublicBatch(
    db,
    batch,
    tiles,
    refIdsByTile,
    nameByTemplateId,
    summaryBySequenceId,
    storyByBatchId,
  );
}

function toPublicTile(row: TileRow, refImageIds: readonly string[]): Tile {
  const provenance = refImageIds.length > 0 ? { refImageIds } : {};
  if (row.status === 'done' && row.ext && row.mime && row.completed_at !== null) {
    return {
      id: row.id,
      seed: row.seed,
      status: 'done',
      ...provenance,
      ...tileArtifactUrls(row.id),
      ext: row.ext,
      mime: row.mime,
      completedAt: row.completed_at,
    };
  }
  if (row.status === 'failed' && row.error && row.completed_at !== null) {
    const moderation = tileModeration(row);
    return {
      id: row.id,
      seed: row.seed,
      status: 'failed',
      ...provenance,
      error: row.error,
      ...(moderation ? { moderation } : {}),
      completedAt: row.completed_at,
    };
  }
  if (row.status === 'loading') {
    return { id: row.id, seed: row.seed, status: 'loading', ...provenance };
  }
  // A terminal-status row that failed its NOT-NULL guards is corrupt: the
  // tiles schema has no CHECK coupling status to ext/mime/error/completed_at,
  // so a 'done'/'failed' row with a NULL artifact column can exist. Surface
  // it as a terminal failure rather than a silent, unrecoverable 'loading'
  // tile (no stream is attached to a historical row, so the client would
  // spin forever with no terminal event).
  return {
    id: row.id,
    seed: row.seed,
    status: 'failed',
    ...provenance,
    error: 'internal error',
    completedAt: row.completed_at ?? Date.now(),
  };
}

// Bounded so a crafted cursor can't probe negative-epoch or far-future
// timelines. The user is still scoped to their own batches by the WHERE
// clause, but tight cursors keep the keyset paging contract honest.
const HistoryCursorSchema = z.object({
  createdAt: z.number().int().nonnegative(),
  id: z.uuid(),
});

const decodeHistoryCursor = (raw: string | undefined): { createdAt: number; id: string } | null =>
  decodeCursor(raw, HistoryCursorSchema);

const encodeHistoryCursor = (createdAt: number, id: string): string =>
  encodeCursor({ createdAt, id });

export const __historyTest = {
  fetchTilesForBatches,
  fetchTemplateNamesForBatches,
  fetchStorySummaries,
};
