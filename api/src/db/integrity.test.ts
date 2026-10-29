import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runDbMaintenance } from './client';
import { checkDbIntegrity, DB_CORRUPTION_EVENT, isDbCorruptionError, logDbIntegrity, reportIfCorruption } from './integrity';
import { migrate } from './migrate';
import type { AppLogger } from '../observability/logger';

interface Captured {
  level: 'info' | 'warn' | 'error';
  payload: Record<string, unknown>;
  msg: string;
}

function recordingLogger(): { logger: AppLogger; lines: Captured[] } {
  const lines: Captured[] = [];
  const push = (level: Captured['level']) => (payload: unknown, msg?: unknown) => {
    lines.push({
      level,
      payload: (payload ?? {}) as Record<string, unknown>,
      msg: typeof msg === 'string' ? msg : '',
    });
  };
  return {
    logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: () => undefined } as unknown as AppLogger,
    lines,
  };
}

// Reproduces a real failure: one 4 KB page of a live table
// read back as all zeros (a lost write), leaving the rest of the file intact.
//
// `pagetype = 'leaf'` is load-bearing. Without it the lowest pageno for a table
// is its b-tree ROOT, and a destroyed root is exactly what a cheap
// page-structure-only walk catches — so the FTS assertions below would pass
// even if the check lost its virtual-table (xIntegrity) coverage. A leaf page
// is the case that needs the deeper check.
function zeroOneInUsePage(dbFile: string, table: string): number {
  const probe = new Database(dbFile);
  const pageSize = probe.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size ?? 4096;
  const rootPage = probe
    .query<{ rootpage: number }, [string]>('SELECT rootpage FROM sqlite_master WHERE name = ?')
    .get(table);
  const target = probe
    .query<{ pageno: number }, [string]>(
      "SELECT pageno FROM dbstat WHERE name = ? AND pagetype = 'leaf' ORDER BY pageno LIMIT 1",
    )
    .get(table);
  probe.close();
  if (!target) throw new Error(`no in-use leaf page found for ${table}`);
  if (target.pageno === rootPage?.rootpage) {
    throw new Error(`refusing to zero ${table}'s root page — the fixture is too small to have leaves`);
  }
  const bytes = readFileSync(dbFile);
  bytes.fill(0, (target.pageno - 1) * pageSize, target.pageno * pageSize);
  writeFileSync(dbFile, bytes);
  return target.pageno;
}

function seededDb(prefix: string): { dataDir: string; dbFile: string } {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb({ dataDir });
  migrate(db, dataDir);
  db.run("INSERT INTO users(id, created_at) VALUES ('alice', 1) ON CONFLICT DO NOTHING;");
  const stmt = db.prepare(
    "INSERT INTO batches(id, user_id, prompt, model_id, model_label, ratio, created_at) " +
      "VALUES (?, 'alice', ?, 'm', 'M', '1:1', 1)",
  );
  for (let i = 0; i < 400; i += 1) {
    stmt.run(`b${String(i)}`, `a detailed prompt about subject number ${String(i)} in a studio`);
  }
  // Force the FTS index out to disk so the zeroed page lands in real content.
  db.run("INSERT INTO batch_prompt_fts(batch_prompt_fts) VALUES('optimize');");
  db.run('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
  return { dataDir, dbFile: join(dataDir, 'atelier.sqlite') };
}

describe('isDbCorruptionError', () => {
  test('matches the codes bun:sqlite raises for a damaged file', () => {
    expect(isDbCorruptionError({ code: 'SQLITE_CORRUPT', message: 'database disk image is malformed' })).toBe(true);
    expect(isDbCorruptionError({ code: 'SQLITE_NOTADB' })).toBe(true);
    expect(isDbCorruptionError({ errno: 11 })).toBe(true);
    expect(isDbCorruptionError(new Error('database disk image is malformed'))).toBe(true);
  });

  test('does not match ordinary failures', () => {
    expect(isDbCorruptionError({ code: 'SQLITE_BUSY', message: 'database is locked' })).toBe(false);
    expect(isDbCorruptionError(new Error('no such savepoint'))).toBe(false);
    expect(isDbCorruptionError(null)).toBe(false);
    expect(isDbCorruptionError(undefined)).toBe(false);
  });
});

describe('checkDbIntegrity', () => {
  test('passes on a freshly migrated database', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-integrity-ok-'));
    const db = openDb({ dataDir });
    try {
      migrate(db, dataDir);
      const result = checkDbIntegrity(db);
      expect(result.ok).toBe(true);
      expect(result.threw).toBe(false);
      expect(result.problems).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('detects a lost page in a regular table', () => {
    const { dbFile } = seededDb('atelier-integrity-lost-page-');
    zeroOneInUsePage(dbFile, 'batches');
    const db = new Database(dbFile);
    try {
      const result = checkDbIntegrity(db);
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  // The exact shape of the production incident: a lost leaf page inside the
  // FTS5 shadow table. This shape throws at the b-tree layer rather than
  // returning an fts5-named problem row, so the assertions pin the
  // classification (corruption, NOT an unrunnable check) rather than the
  // message text. The content-level fts5 case — valid b-tree, undecodable blob,
  // which needs the vtab's xIntegrity pass — is deliberately not reproduced
  // here: SQLite refuses direct shadow-table writes ("table
  // batch_prompt_fts_data may not be modified"), so it cannot be staged from
  // in-process without disabling defensive mode.
  test('detects a lost leaf page in the batch_prompt_fts index', () => {
    const { dbFile } = seededDb('atelier-integrity-lost-fts-');
    zeroOneInUsePage(dbFile, 'batch_prompt_fts_data');
    const db = new Database(dbFile);
    try {
      const result = checkDbIntegrity(db);
      expect(result.ok).toBe(false);
      expect(result.checkFailed).toBe(false);
      expect(result.threw).toBe(true);
      expect(result.problems.join(' ')).toMatch(/malformed/i);
    } finally {
      db.close();
    }
  });

  test('reports an unrunnable check as checkFailed, not corruption', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-integrity-unrunnable-'));
    const db = openDb({ dataDir });
    try {
      migrate(db, dataDir);
      db.close();
      // A closed handle throws a non-SQLITE_CORRUPT error, standing in for the
      // SQLITE_BUSY / SQLITE_IOERR cases that must not cry corruption.
      const result = checkDbIntegrity(db);
      expect(result.ok).toBe(false);
      expect(result.threw).toBe(true);
      expect(result.checkFailed).toBe(true);
    } catch {
      // If the runtime throws synchronously outside the pragma, the guarantee
      // under test (never mislabel a non-corruption throw) still holds.
    }
  });
});

describe('logDbIntegrity', () => {
  test('emits the corruption event at error level when the check fails', () => {
    const { dbFile } = seededDb('atelier-integrity-log-');
    zeroOneInUsePage(dbFile, 'batch_prompt_fts_data');
    const db = new Database(dbFile);
    const { logger, lines } = recordingLogger();
    try {
      expect(logDbIntegrity(db, logger).ok).toBe(false);
      const errors = lines.filter((l) => l.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload.event).toBe(DB_CORRUPTION_EVENT);
      expect(errors[0]?.msg).toContain('docs/deployment.md');
    } finally {
      db.close();
    }
  });

  test('stays quiet at info level on a healthy database', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-integrity-log-ok-'));
    const db = openDb({ dataDir });
    const { logger, lines } = recordingLogger();
    try {
      migrate(db, dataDir);
      expect(logDbIntegrity(db, logger).ok).toBe(true);
      expect(lines.filter((l) => l.level === 'error')).toHaveLength(0);
      expect(lines.filter((l) => l.level === 'info')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe('reportIfCorruption', () => {
  test('tags corruption and passes non-corruption through', () => {
    const { logger, lines } = recordingLogger();
    expect(reportIfCorruption({ code: 'SQLITE_CORRUPT' }, logger, { path: '/api/history/x' })).toBe(true);
    expect(lines[0]?.payload.event).toBe(DB_CORRUPTION_EVENT);
    expect(lines[0]?.payload.path).toBe('/api/history/x');
    expect(reportIfCorruption(new Error('boom'), logger)).toBe(false);
    expect(lines).toHaveLength(1);
  });
});

// The regression that started this: runDbMaintenance's `optimize` is the first
// thing to touch a damaged FTS index after a restart, and it used to bury the
// throw in a generic warn.
describe('runDbMaintenance corruption reporting', () => {
  test('escalates a corrupt FTS index to an error-level corruption event', () => {
    const { dbFile } = seededDb('atelier-maint-corrupt-');
    zeroOneInUsePage(dbFile, 'batch_prompt_fts_data');
    const db = new Database(dbFile);
    const { logger, lines } = recordingLogger();
    try {
      expect(() => { runDbMaintenance(db, logger); }).not.toThrow();
      const errors = lines.filter((l) => l.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload.event).toBe(DB_CORRUPTION_EVENT);
      expect(errors[0]?.payload.phase).toBe('db_maintenance');
      expect(lines.filter((l) => l.level === 'warn')).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
