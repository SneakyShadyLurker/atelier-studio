import type { Database } from 'bun:sqlite';
import type { AppLogger } from '../observability/logger';

// Corruption detection + reporting.
//
// Background: a single 4 KB page belonging to
// `batch_prompt_fts_data` was lost — it read back as 4096 zero bytes — which
// made every archive DELETE whose trigram terms lived in that FTS segment roll
// back with SQLITE_CORRUPT. The failure stayed invisible because the
// only code that touched the damaged index at boot (`runDbMaintenance`)
// swallowed the throw into a generic warn. Everything here exists so the next
// occurrence names itself in the log on the first boot after it happens.

// SQLite signals a damaged file through two result codes: SQLITE_CORRUPT (11)
// for a malformed page/b-tree and SQLITE_NOTADB (26) for a header that isn't a
// database at all. bun:sqlite surfaces both as `code`/`errno` on the thrown
// SQLiteError; the message check is a last-resort fallback for a wrapper that
// drops those fields.
export function isDbCorruptionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, errno, message } = error as { code?: unknown; errno?: unknown; message?: unknown };
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return true;
  if (errno === 11 || errno === 26) return true;
  return typeof message === 'string' && /malformed|not a database/i.test(message);
}

export interface DbIntegrityResult {
  /** True only on a clean bill of health. A check that could not run is NOT ok. */
  ok: boolean;
  /** Rows returned by the pragma, or the thrown error's message. */
  problems: readonly string[];
  /**
   * True when the checker itself threw. Severe damage stops the page walk
   * before it can report rows, so a corruption throw is a *stronger* signal
   * than a problem row — never treat it as "check unavailable".
   */
  threw: boolean;
  /**
   * True when the pragma failed for an operational reason (SQLITE_BUSY on a
   * locked file, an IO error) rather than damage. Callers must not report this
   * as corruption — it would point an operator at a destructive repair for what
   * is usually a transient lock. Still leaves `ok` false: nothing was verified.
   */
  checkFailed: boolean;
}

// `integrity_check` over the cheaper `quick_check`: the difference is the
// index-vs-table content comparison, which is the class of damage that returns
// silently wrong rows instead of throwing — exactly what would feed
// startupReconcile a short keep-set and get live artifacts unlinked (see
// `ReconcileOptions.dbIntegrityOk`). Measured on this schema the two are
// near-identical (1.5 ms vs 1.9 ms on a 400-batch DB; 53.6 ms vs 53.8 ms on a
// 10.7 MB / 8000-row trigram DB — fts5's xIntegrity ignores the isQuick flag,
// so quick_check saves nothing on the FTS half). Re-measure before trading down
// if the DB grows an order of magnitude. NB the extra coverage is not pinned by
// a test: staging an index/content mismatch needs defensive mode off.
//
// `limit` caps reported errors, not pages walked. Both arms below are
// load-bearing: verified against a preserved damaged database, the pragma RETURNED an fts5 blob failure on the structurally-sound
// copy and THREW SQLITE_CORRUPT on the raw one.
export function checkDbIntegrity(db: Database, limit = 20): DbIntegrityResult {
  try {
    const rows = db
      .query<{ integrity_check: string }, []>(`PRAGMA integrity_check(${String(limit)})`)
      .all();
    const problems = rows.map((r) => r.integrity_check).filter((r) => r !== 'ok');
    return { ok: problems.length === 0, problems, threw: false, checkFailed: false };
  } catch (error) {
    const corrupt = isDbCorruptionError(error);
    return {
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
      threw: true,
      checkFailed: !corrupt,
    };
  }
}

// Grep-able marker shared by every corruption report so one query finds them
// all: `docker logs atelier-api | grep db_corruption_detected`.
export const DB_CORRUPTION_EVENT = 'db_corruption_detected';

const REMEDIATION = 'sqlite reports a damaged database — see docs/deployment.md § Database corruption';

// Boot-time gate. Deliberately NOT fatal: damage confined to a derived FTS
// index would otherwise turn a partly-degraded service into a full outage. Loud beats dead.
export function logDbIntegrity(db: Database, logger: Pick<AppLogger, 'info' | 'error'>): DbIntegrityResult {
  const startedAt = performance.now();
  const result = checkDbIntegrity(db);
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (result.ok) {
    logger.info({ elapsedMs }, 'db integrity check passed');
  } else if (result.checkFailed) {
    // Could not verify (locked file, IO error). Loud, but deliberately NOT the
    // corruption event — that marker must stay a reliable signal to repair.
    logger.error(
      { event: 'db_integrity_check_failed', problems: result.problems, elapsedMs },
      'db integrity check could not run; DB health is UNKNOWN this boot',
    );
  } else {
    logger.error(
      { event: DB_CORRUPTION_EVENT, problems: result.problems, threw: result.threw, elapsedMs },
      `db integrity check FAILED — ${REMEDIATION}`,
    );
  }
  return result;
}

// Shared reporter for corruption caught on a live code path rather than at
// boot. Returns whether it matched so callers can keep their own non-corruption
// handling intact.
export function reportIfCorruption(
  error: unknown,
  logger: Pick<AppLogger, 'error'>,
  context: Record<string, unknown> = {},
): boolean {
  if (!isDbCorruptionError(error)) return false;
  logger.error({ ...context, err: error, event: DB_CORRUPTION_EVENT }, REMEDIATION);
  return true;
}
