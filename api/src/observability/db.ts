import type { AppLogger } from './logger';

// Slow-query observability helper.
//
// Wraps a synchronous DB call with `performance.now()` deltas and logs a
// `slow_db_query` warning when the call exceeds `SLOW_DB_QUERY_THRESHOLD_MS`.
// Intentionally minimum-viable: there is no instrumented `db` proxy and no
// OTLP export, just structured Pino lines callers can grep for in
// `docker logs atelier-api`. Wire selectively into hot blocks (orchestrator
// success path, /history bulk read, /collections rail, /api/prompts) rather
// than around every query.
//
// Threshold sits at 100 ms — anything above that is well past the p99
// budget for a single SQLite call on this DB and worth a log line.
const SLOW_DB_QUERY_THRESHOLD_MS = 100;

interface TimedDbContext {
  /** Short identifier for the query block (e.g. `tile_done_update`). */
  sqlPrefix: string;
  /** Optional route or call-site name to attach to the log entry. */
  route?: string;
  /** Override the threshold for high-frequency call sites with tighter SLAs. */
  thresholdMs?: number;
}

// Synchronous form for bun:sqlite calls which never yield.
export function withTimedDb<T>(
  logger: Pick<AppLogger, 'warn'>,
  ctx: TimedDbContext,
  fn: () => T,
): T {
  const started = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = performance.now() - started;
    if (durationMs > (ctx.thresholdMs ?? SLOW_DB_QUERY_THRESHOLD_MS)) {
      logger.warn(
        {
          event: 'slow_db_query',
          sql_prefix: ctx.sqlPrefix,
          ...(ctx.route ? { route: ctx.route } : {}),
          durationMs: Math.round(durationMs),
        },
        'slow db query',
      );
    }
  }
}
