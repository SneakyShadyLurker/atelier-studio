import type { Database } from 'bun:sqlite';
import type { MediaExt } from '@atelier/shared';
import { hotStatements } from './preparedStatements';

// Single source of truth for the soft-archive / hard-delete tombstone policy
// and the loading→terminal guard. Before this module the policy was
// hand-written four times (the three DELETE /history handlers + the
// orchestrator's emitFailed archived path) with subtly different scoping —
// the canonical silent-drift hazard on the data-loss-critical path
// (architecture_invariants §6). The DELETE handlers keep their own scope SQL
// (bulk predicate vs batch_id vs tile id) but the *policy* — which statuses
// hard-delete vs archive, the empty-batch drop, the loading guard — lives
// only here.
//
// Policy:
//   - `loading` / `failed` tiles → hard DELETE (a partial/failed result is
//     not worth keeping; the user asked the batch to go away).
//   - `done` tiles → soft-archive (set archived_at) UNLESS cancel intent, in
//     which case an in-window `done` tile is hard-deleted too.
//   - after the tile changes: a batch with zero remaining tiles is dropped;
//     otherwise it is soft-archived.
//
// Every loading→terminal writer MUST carry SQL_LOADING_GUARD so a concurrent
// DELETE (which hard-deletes the row) and the orchestrator's guarded UPDATE
// stay race-safe — an unguarded `UPDATE … WHERE batch_id=?` would resurrect a
// row a concurrent DELETE just removed.

// Parameter-free SQL fragments. Safe to interpolate (no user input).
export const SQL_TOMBSTONE_DELETE_STATUSES = "status IN ('loading', 'failed')";
const SQL_TOMBSTONE_CANCEL_DELETE_STATUSES = "status IN ('loading', 'failed', 'done')";
export const SQL_LOADING_GUARD = "status = 'loading'";

/** A hard-deleted `done` tile whose artifact files the caller unlinks after commit. */
export interface RemovedTileArtifact {
  readonly id: string;
  readonly ext: MediaExt;
}

export interface TombstoneResult {
  /** True when the batch row itself was hard-deleted. */
  readonly batchDeleted: boolean;
  /** Finished tiles a cancel hard-deleted; their files are now unreferenced. */
  readonly removedArtifacts: readonly RemovedTileArtifact[];
}

interface DeletedTileRow {
  id: string;
  status: string;
  ext: MediaExt | null;
}

function removedArtifactsOf(rows: readonly DeletedTileRow[]): RemovedTileArtifact[] {
  return rows.flatMap((row) => row.status === 'done' && row.ext !== null ? [{ id: row.id, ext: row.ext }] : []);
}

// Returns true when this call hard-deleted the batch row.
function dropOrArchiveBatchIfEmpty(
  db: Database,
  userId: string,
  batchId: string,
  now: number,
): boolean {
  const stmts = hotStatements(db);
  const total = stmts.countTilesForBatch.get(userId, batchId);
  if ((total?.count ?? 0) === 0) {
    return stmts.deleteBatchByUserId.run(userId, batchId).changes > 0;
  }
  stmts.archiveBatchByUserId.run(now, userId, batchId);
  return false;
}

// Per-batch tombstone. The CALLER owns the surrounding `db.transaction(...)()`
// and the post-commit AbortController dispatch (abort listeners fire
// synchronously and must never run inside the txn callback). Behaviour is
// identical to the former inline body in DELETE /history/:batchId. The
// caller also unlinks `removedArtifacts` after commit: a hard-deleted `done`
// tile leaves files no row points at.
export function softArchiveOrDeleteBatch(
  db: Database,
  userId: string,
  batchId: string,
  opts: { cancelIntent: boolean; now: number },
): TombstoneResult {
  let removedArtifacts: RemovedTileArtifact[] = [];
  if (opts.cancelIntent) {
    removedArtifacts = removedArtifactsOf(db.query<DeletedTileRow, [string, string]>(
      `DELETE FROM tiles WHERE user_id = ? AND batch_id = ? AND ${SQL_TOMBSTONE_CANCEL_DELETE_STATUSES} AND archived_at IS NULL
       RETURNING id, status, ext`,
    ).all(userId, batchId));
  } else {
    db.query(
      `DELETE FROM tiles WHERE user_id = ? AND batch_id = ? AND ${SQL_TOMBSTONE_DELETE_STATUSES} AND archived_at IS NULL`,
    ).run(userId, batchId);
    db.query(
      "UPDATE tiles SET archived_at = ? WHERE user_id = ? AND batch_id = ? AND status = 'done' AND archived_at IS NULL",
    ).run(opts.now, userId, batchId);
  }
  return { batchDeleted: dropOrArchiveBatchIfEmpty(db, userId, batchId, opts.now), removedArtifacts };
}

// Per-tile tombstone with cascade to the parent batch. CALLER owns the
// transaction + post-commit abort. Behaviour is identical to the former
// inline body in DELETE /history/:batchId/:tileId. `batchDeleted` is true
// when the cascade hard-deleted the parent batch row.
export function softArchiveOrDeleteTile(
  db: Database,
  userId: string,
  batchId: string,
  tileId: string,
  opts: { cancelIntent: boolean; now: number },
): TombstoneResult {
  const row = db
    .query<{ status: string }, [string, string, string]>(
      'SELECT status FROM tiles WHERE user_id = ? AND batch_id = ? AND id = ? AND archived_at IS NULL',
    )
    .get(userId, batchId, tileId);
  if (!row) return { batchDeleted: false, removedArtifacts: [] };
  let removedArtifacts: RemovedTileArtifact[] = [];
  if (row.status === 'loading' || row.status === 'failed' || (row.status === 'done' && opts.cancelIntent)) {
    removedArtifacts = removedArtifactsOf(db.query<DeletedTileRow, [string, string, string]>(
      `DELETE FROM tiles WHERE user_id = ? AND batch_id = ? AND id = ? AND archived_at IS NULL
       RETURNING id, status, ext`,
    ).all(userId, batchId, tileId));
  } else {
    db.query(
      'UPDATE tiles SET archived_at = ? WHERE user_id = ? AND batch_id = ? AND id = ? AND archived_at IS NULL',
    ).run(opts.now, userId, batchId, tileId);
  }
  const liveCount = db
    .query<{ count: number }, [string, string]>(
      'SELECT COUNT(*) AS count FROM tiles WHERE user_id = ? AND batch_id = ? AND archived_at IS NULL',
    )
    .get(userId, batchId);
  const batchDeleted = (liveCount?.count ?? 0) === 0 && dropOrArchiveBatchIfEmpty(db, userId, batchId, opts.now);
  return { batchDeleted, removedArtifacts };
}
