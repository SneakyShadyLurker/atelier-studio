import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { AppLogger } from '../observability/logger';
import { reportIfCorruption } from './integrity';

export interface DbOptions {
  dataDir: string;
  filename?: string;
}

export function dbPath(dataDir: string, filename = 'atelier.sqlite'): string {
  return join(dataDir, filename);
}

// Performance pragmas applied alongside the correctness baseline. The values
// are documented in docs/superpowers/audit/04-data.md (PRAGMA tuning finding):
//   - mmap_size = 0: keep SQLite mmap disabled. The production DB lives on a
//     Docker Desktop bind mount and uses WAL; mapped reads there produced
//     transient SQLITE_CORRUPT ("database disk image is malformed") under
//     concurrent generation/archive load while integrity_check stayed clean.
//   - cache_size = -64000: ~64 MB page cache per connection (negative ⇒ KiB).
//     Default of 2 MB is far too small for the multi-MB working set on this
//     DB once `tiles`, `batches`, and `tile_ref_images` are joined.
//   - temp_store = MEMORY: route ORDER BY / GROUP BY / DISTINCT temp B-trees
//     into RAM instead of a temp file. Removes a bind-mount round-trip on
//     every paginated history read.
const PERF_PRAGMA_MMAP_SIZE = 0;
const PERF_PRAGMA_CACHE_SIZE = -64_000;

// `db.query(sql)` keeps only the `Database.MAX_QUERY_CACHE_SIZE` most recently
// used SQL strings (LRU, default 20) per connection. The api has hundreds of
// fixed-shape call sites, so at the default the hot statements are evicted and
// recompiled between requests. Process-wide static, read at query time; set
// once at module load so every connection (and test database) gets it.
Database.MAX_QUERY_CACHE_SIZE = 512;

// Per-connection PRAGMAs that the api depends on. `journal_mode=WAL` and
// `foreign_keys=ON` are NOT persisted across connections in SQLite — they
// must be re-applied on every `new Database()`. `synchronous=NORMAL` and
// `busy_timeout=5000` are not persisted either. Centralizing here lets the
// migration runner re-apply the same baseline before it runs (tests can
// open `:memory:` directly and skip openDb), and any future code path that
// opens a DB connection picks up the same defaults by importing this.
export function applyPragmas(db: Database): void {
  // Concurrent writers (orchestrator + history DELETE + reconcile) can race
  // for the WAL writer lock. Without a busy_timeout the loser throws
  // SQLITE_BUSY immediately. 5s gives long enough for any short transaction
  // to settle without the API feeling hung. Must be set BEFORE journal_mode:
  // the WAL conversion itself takes an exclusive lock, and a concurrent open
  // hitting it with busy_timeout=0 fails with "database is locked".
  db.run('PRAGMA busy_timeout = 5000;');
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA foreign_keys = ON;');
  // NORMAL with WAL is safe for crash recovery and may lose the last in-flight
  // transaction on power failure. Acceptable here because: (a) artifacts on
  // disk get explicit fsync via writeAtomic so file durability is independent
  // of this setting, and (b) a lost batch is recoverable by re-generating.
  // Bump to FULL only if running on storage without UPS-backed power loss
  // protection.
  db.run('PRAGMA synchronous = NORMAL;');
  // Cap the WAL sidecar so a heavy generation/archive burst can't leave it
  // permanently grown — on checkpoint the WAL is truncated back to ≤64 MB.
  // Persistent per-connection (not stored in the file), so re-applied here.
  db.run('PRAGMA journal_size_limit = 67108864;');
  // Performance pragmas — see PERF_PRAGMA_* constants above for rationale.
  // mmap_size/cache_size/temp_store are NOT persisted across connections, so
  // they must be re-applied here for every `new Database()` and for the
  // migration runner's in-memory test handles (which call applyPragmas
  // directly without going through openDb).
  db.run(`PRAGMA mmap_size = ${PERF_PRAGMA_MMAP_SIZE};`);
  db.run(`PRAGMA cache_size = ${PERF_PRAGMA_CACHE_SIZE};`);
  db.run('PRAGMA temp_store = MEMORY;');
  // Load-bearing: `tile_ref_images.tile_id … ON DELETE CASCADE` is the ONLY
  // mechanism that clears ref-image rows when a tile is hard-deleted
  // (history DELETE, orchestrator archived-tombstone). The user-delete and
  // tombstone paths do NOT drive the cascade by hand (only
  // cleanupPreparedBatch does, as defense-in-depth). If `foreign_keys`
  // silently failed to enable — a future bun:sqlite regression, or a build
  // without FK support — those deletes would leak `tile_ref_images` rows that
  // pin `uploads` alive via `ON DELETE RESTRICT`, so the upload reaper never
  // fires and quota math drifts. Read it back and fail fast at boot.
  const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
  if (fk?.foreign_keys !== 1) {
    throw new Error(
      `PRAGMA foreign_keys did not enable (got ${String(fk?.foreign_keys)}); ` +
        'tile_ref_images cascade cleanup would silently leak — refusing to continue',
    );
  }
}

// Read back every PRAGMA applyPragmas() set so a boot-time log captures the
// values actually in effect on this connection. Used at server startup at
// debug level so the first-deploy verification can confirm tuning landed
// without paying the cost on every request.
export function readAppliedPragmas(db: Database): {
  journal_mode: string;
  foreign_keys: number;
  synchronous: number;
  busy_timeout: number;
  mmap_size: number;
  cache_size: number;
  temp_store: number;
} {
  const journal = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
  const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
  const sync = db.query<{ synchronous: number }, []>('PRAGMA synchronous').get();
  const busy = db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get();
  const mmap = db.query<{ mmap_size: number }, []>('PRAGMA mmap_size').get();
  const cache = db.query<{ cache_size: number }, []>('PRAGMA cache_size').get();
  const temp = db.query<{ temp_store: number }, []>('PRAGMA temp_store').get();
  return {
    journal_mode: journal?.journal_mode ?? 'unknown',
    foreign_keys: fk?.foreign_keys ?? -1,
    synchronous: sync?.synchronous ?? -1,
    busy_timeout: busy?.timeout ?? -1,
    mmap_size: mmap?.mmap_size ?? -1,
    cache_size: cache?.cache_size ?? 0,
    temp_store: temp?.temp_store ?? -1,
  };
}

export function logAppliedPragmas(db: Database, logger: Pick<AppLogger, 'debug'>): void {
  logger.debug({ pragmas: readAppliedPragmas(db) }, 'db pragmas applied');
}

// Periodic-ish housekeeping run after the boot-time archive purge (its bulk
// DELETEs are what leave WAL growth + FTS5 tombstones behind). Both ops are
// no-ops when there's nothing to reclaim, and both are best-effort: a failure
// here must never block startup, so it is logged and swallowed. VACUUM is
// intentionally NOT run here — it takes an exclusive lock and rewrites the whole
// file; it stays a manual step (docs/deployment.md).
export function runDbMaintenance(
  db: Database,
  logger: Pick<AppLogger, 'info' | 'warn' | 'error'>,
): void {
  try {
    db.run("INSERT INTO batch_prompt_fts(batch_prompt_fts) VALUES('optimize');");
    const walResult = db.query<{ busy: number; log: number; checkpointed: number }, []>(
      'PRAGMA wal_checkpoint(TRUNCATE);',
    ).get();
    logger.info({ wal: walResult ?? null }, 'db maintenance complete');
  } catch (error) {
    // `optimize` walks every FTS5 segment, so this is usually the FIRST thing
    // to touch a damaged index after a restart; a generic warn would hide
    // SQLITE_CORRUPT at every boot. Corruption gets its own error-level event; everything else
    // stays a non-fatal warn.
    if (!reportIfCorruption(error, logger, { phase: 'db_maintenance' })) {
      logger.warn({ err: error }, 'db maintenance failed (non-fatal)');
    }
  }
}

export function openDb(options: DbOptions): Database {
  const path = dbPath(options.dataDir, options.filename);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  applyPragmas(db);
  return db;
}
