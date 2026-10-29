import type { Database } from 'bun:sqlite';
import { hotStatements } from './preparedStatements';

interface TransitionLogger {
  warn(messageOrObject: unknown, message?: string): void;
}

// The single queued→running transition. Returns the dispatch time when this
// call claimed the batch, null otherwise; with a logger, a skipped transition
// (batch no longer queued) warns.
export function transitionQueuedToRunning(db: Database, batchId: string, logger?: TransitionLogger): number | null {
  const startedAt = Date.now();
  const result = hotStatements(db).transitionQueuedToRunning.run(startedAt, batchId);
  if (result.changes === 1) return startedAt;
  logger?.warn(
    { event: 'mark_running_skipped', batchId },
    'batch was not queued; skipped running transition',
  );
  return null;
}

export function countQueuedForUser(db: Database, userId: string): number {
  const row = hotStatements(db).countQueuedForUser.get(userId);
  return row?.n ?? 0;
}

/** A rendering story reserves one video admission across all of its segments. */
export function countInflightVideoForUser(db: Database, userId: string, videoModelIds: readonly string[]): number {
  const videoPredicate = videoModelIds.length > 0
    ? `b.model_id IN (${videoModelIds.map(() => '?').join(',')})`
    : '0';
  const row = db.query<{ n: number }, string[]>(
    `SELECT
       (SELECT COUNT(*) FROM stories WHERE user_id = ? AND status = 'rendering')
       + (SELECT COUNT(*) FROM batches b
           WHERE b.user_id = ? AND b.status IN ('queued', 'running') AND ${videoPredicate}
             AND NOT EXISTS (
               SELECT 1 FROM story_segments ss
               JOIN stories s ON s.id = ss.story_id AND s.user_id = ss.user_id
               WHERE ss.batch_id = b.id AND ss.user_id = b.user_id
                 AND s.status = 'rendering'
             )) AS n`,
  ).get(userId, userId, ...videoModelIds);
  return row?.n ?? 0;
}
