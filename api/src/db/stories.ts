import type { Database } from 'bun:sqlite';

/**
 * Deletes finished stories none of whose segment batches still exist, so the
 * plan text (outline, continuity bible, source prompt, beats) goes when the
 * clips do. A story that is still rendering is kept: its driver owns it and
 * settles it first. Call it inside the transaction that hard-deletes batches;
 * a user id scopes the sweep to that user. Returns the number of stories removed.
 */
export function pruneStoriesWithoutBatches(db: Database, userId?: string): number {
  return db.transaction(() => {
    const ids = db.query<{ id: string }, [string | null]>(
      `SELECT s.id FROM stories s
        WHERE s.status <> 'rendering'
          AND (?1 IS NULL OR s.user_id = ?1)
          AND NOT EXISTS (
            SELECT 1 FROM story_segments ss
              JOIN batches b ON b.id = ss.batch_id AND b.user_id = s.user_id
             WHERE ss.story_id = s.id
          )`,
    ).all(userId ?? null).map((row) => row.id);
    if (ids.length === 0) return 0;
    const idList = JSON.stringify(ids);
    db.query('DELETE FROM story_segments WHERE story_id IN (SELECT value FROM json_each(?))').run(idList);
    db.query('DELETE FROM stories WHERE id IN (SELECT value FROM json_each(?))').run(idList);
    return ids.length;
  })();
}
