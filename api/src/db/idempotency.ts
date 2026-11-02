import type { Database } from 'bun:sqlite';
import { BATCH_COLUMNS } from './columns';
import type { BatchRow } from './types';

// The caller's batch already carrying this POST /api/generate idempotency key,
// archived batches included (they still dedupe). Scoped by user: a key is one
// logical roll per user, so another user's identical key never matches, and
// keyless (NULL) batches never match anything.
export function findBatchByIdempotencyKey(db: Database, userId: string, key: string): BatchRow | null {
  return db
    .query<BatchRow, [string, string]>(
      `SELECT ${BATCH_COLUMNS} FROM batches WHERE user_id = ? AND idempotency_key = ?`,
    )
    .get(userId, key);
}
