import type { Database } from 'bun:sqlite';
import { ensureUser } from '../db/users';

/** Per-user base-sampler step overrides. Absent rows mean the model default. */
export function readModelStepsOverrides(db: Database, userId: string): ReadonlyMap<string, number> {
  const rows = db
    .query<{ model_id: string; steps: number }, [string]>(
      'SELECT model_id, steps FROM user_model_steps WHERE user_id = ?',
    )
    .all(userId);
  return new Map(rows.map((row) => [row.model_id, row.steps]));
}

/** The user's override for one model, or undefined when the default applies. */
export function readModelStepsOverride(db: Database, userId: string, modelId: string): number | undefined {
  return db
    .query<{ steps: number }, [string, string]>(
      'SELECT steps FROM user_model_steps WHERE user_id = ? AND model_id = ?',
    )
    .get(userId, modelId)?.steps;
}

/**
 * Stores `steps` for `modelId`, or resets to the default: null, or a value
 * equal to `defaultSteps`, deletes the row so only real overrides persist.
 * Callers validate the model and the MODEL_STEPS_MIN/MAX bounds first; the
 * DB CHECK backs them.
 */
export function writeModelStepsOverride(
  db: Database,
  userId: string,
  modelId: string,
  steps: number | null,
  defaultSteps: number,
  now: number = Date.now(),
): void {
  if (steps === null || steps === defaultSteps) {
    db.query('DELETE FROM user_model_steps WHERE user_id = ? AND model_id = ?').run(userId, modelId);
    return;
  }
  // The FK to users(id) requires the row.
  ensureUser(db, userId);
  db.query(`
    INSERT INTO user_model_steps (user_id, model_id, steps, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, model_id) DO UPDATE SET
      steps = excluded.steps,
      updated_at = excluded.updated_at
  `).run(userId, modelId, steps, now);
}
