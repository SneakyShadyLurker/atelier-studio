import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { hotStatements } from './preparedStatements';

// Idempotent first-touch insert for a user row. Every code path that mints
// new user-scoped state goes through this helper so schema additions to the
// `users` table only need to land in one place. Race-safe: `INSERT OR IGNORE`
// means the second concurrent caller silently no-ops, and the `created_at` of
// the row is whichever winner committed first (semantically fine; semantics
// are "first seen at").
export function ensureUser(db: Database, userId: string, now: number = Date.now()): void {
  hotStatements(db).ensureUser.run(userId, now);
}

export function getOrCreateUserCacheScope(db: Database, userId: string): string {
  const select = db.query<{ cache_scope: string | null }, [string]>(
    'SELECT cache_scope FROM users WHERE id = ?',
  );
  const existing = select.get(userId)?.cache_scope;
  if (existing) return existing;

  ensureUser(db, userId);
  const candidate = randomUUID();
  db.query('UPDATE users SET cache_scope = ? WHERE id = ? AND cache_scope IS NULL')
    .run(candidate, userId);
  const scope = select.get(userId)?.cache_scope;
  if (!scope) throw new Error('failed to initialize user cache scope');
  return scope;
}
