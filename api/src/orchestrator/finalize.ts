import type { Database } from 'bun:sqlite';

export function finalizeBatch(db: Database, batchId: string): void {
  db.run(
    `UPDATE batches
        SET status='done'
      WHERE id = ?
        AND status IN ('running','queued')
        AND NOT EXISTS (
          SELECT 1 FROM tiles WHERE batch_id = batches.id AND status='loading'
        )`,
    [batchId],
  );
}
