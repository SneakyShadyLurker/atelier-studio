import type { Database } from 'bun:sqlite';
import { ensureUser } from '../db/users';

/**
 * Whether queued preparation may condense this user's over-budget Krea
 * prompts. On unless the user turned "Condense long prompts" off.
 */
export function readCondensePrompts(db: Database, userId: string): boolean {
  const row = db
    .query<{ condense_prompts: number | null }, [string]>(
      'SELECT condense_prompts FROM user_preferences WHERE user_id = ?',
    )
    .get(userId);
  // The DB CHECK admits 0 and 1; only 0 is written, and 1 reads as the default.
  return row?.condense_prompts !== 0;
}

/**
 * Stores the switch. On is the default and is stored as no row, so turning it
 * back on deletes the row while `user_preferences` holds no other setting.
 */
export function writeCondensePrompts(db: Database, userId: string, enabled: boolean, now: number = Date.now()): void {
  if (enabled) {
    db.query('DELETE FROM user_preferences WHERE user_id = ?').run(userId);
    return;
  }
  // The FK to users(id) requires the row.
  ensureUser(db, userId);
  db.query(`
    INSERT INTO user_preferences (user_id, condense_prompts, updated_at)
    VALUES (?, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      condense_prompts = excluded.condense_prompts,
      updated_at = excluded.updated_at
  `).run(userId, now);
}
