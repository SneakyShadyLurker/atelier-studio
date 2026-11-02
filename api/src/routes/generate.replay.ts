import type { Database } from 'bun:sqlite';
import type { GenerateResponse } from '@atelier/shared';
import { TILE_COLUMNS } from '../db/columns';
import type { BatchRow, TileRow } from '../db/types';
import * as queue from '../orchestrator/queue';
import { refImageIdsForBatch } from '../orchestrator/refImages';

// Rebuilds the POST /api/generate acceptance for a batch that already exists
// under the request's idempotency key. Read-only: a replay never acquires,
// enqueues, dispatches or prepares anything. Tiles are listed whatever their
// archive state, since the original 201 listed every tile; the client takes
// only the batch id and follows the events stream from there.
export function buildReplayResponse(db: Database, batch: BatchRow): GenerateResponse {
  const tiles = db
    .query<TileRow, [string, string]>(
      `SELECT ${TILE_COLUMNS} FROM tiles WHERE batch_id = ? AND user_id = ? ORDER BY tile_index`,
    )
    .all(batch.id, batch.user_id);
  const position = batch.status === 'queued' ? queue.positionOf(batch.pool, batch.id) : -1;
  const refImageIds = refImageIdsForBatch(db, batch.id);
  return {
    batchId: batch.id,
    tiles: tiles.map((tile) => ({ tileId: tile.id, tileIndex: tile.tile_index, seed: tile.seed })),
    status: batch.status,
    pool: batch.pool,
    ...(position >= 0 ? { queueLengthAhead: position } : {}),
    ...(refImageIds.length > 0 ? { refImageIds } : {}),
    replayed: true,
  };
}
