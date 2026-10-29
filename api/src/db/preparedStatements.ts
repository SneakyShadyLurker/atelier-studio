import type { Database, Statement } from 'bun:sqlite';

// Lazy, per-`Database`-instance cache of fixed-shape prepared statements.
//
// `bun:sqlite`'s `db.query(sql)` caches by SQL string in a bounded LRU
// (`Database.MAX_QUERY_CACHE_SIZE`, raised in db/client.ts) and pays a
// per-call lookup; `db.prepare(sql)` returns an uncached `Statement` bound to
// the concrete `Database` instance. Hoisting the highest-frequency
// fixed-shape SQL into pre-compiled statements removes the lookup, can never
// be evicted, and gives the planner one stable plan to reuse.
//
// Keyed off the `Database` instance via `WeakMap` so each test's
// `new Database(':memory:')` gets its own cache without bleeding state
// across runs (the test DB is GC'd once the test scope releases it).
// Statements never outlive their owning database — `bun:sqlite` invalidates
// them automatically on `db.close()`.
//
// Only fixed-shape statements live here. Dynamic-WHERE queries stay inline at
// their call sites; bulk id lists prefer one fixed-shape `json_each(?)`
// statement over a variable-length `IN (?, ?, …)`, which would put one cache
// entry per list length into the LRU and evict the fixed-shape strings.

interface HotStatements {
  // queueOps.ts
  transitionQueuedToRunning: Statement<unknown, [number, string]>;
  countQueuedForUser: Statement<{ n: number }, [string]>;

  // users.ts
  ensureUser: Statement<unknown, [string, number]>;

  // tombstone.ts — dropOrArchiveBatchIfEmpty inputs
  countTilesForBatch: Statement<{ count: number }, [string, string]>;
  deleteBatchByUserId: Statement<unknown, [string, string]>;
  archiveBatchByUserId: Statement<unknown, [number, string, string]>;
}

const cache = new WeakMap<Database, HotStatements>();

export function hotStatements(db: Database): HotStatements {
  const existing = cache.get(db);
  if (existing) return existing;
  const created: HotStatements = {
    transitionQueuedToRunning: db.prepare<unknown, [number, string]>(
      "UPDATE batches SET status='running', started_at = ? WHERE id = ? AND status='queued'",
    ),
    countQueuedForUser: db.prepare<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM batches WHERE user_id = ? AND status='queued'",
    ),
    ensureUser: db.prepare<unknown, [string, number]>(
      'INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)',
    ),
    countTilesForBatch: db.prepare<{ count: number }, [string, string]>(
      'SELECT COUNT(*) AS count FROM tiles WHERE user_id = ? AND batch_id = ?',
    ),
    deleteBatchByUserId: db.prepare<unknown, [string, string]>(
      'DELETE FROM batches WHERE user_id = ? AND id = ? AND archived_at IS NULL',
    ),
    archiveBatchByUserId: db.prepare<unknown, [number, string, string]>(
      'UPDATE batches SET archived_at = ? WHERE user_id = ? AND id = ? AND archived_at IS NULL',
    ),
  };
  cache.set(db, created);
  return created;
}
