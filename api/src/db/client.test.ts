import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, readAppliedPragmas, runDbMaintenance } from './client';
import { migrate } from './migrate';
import type { AppLogger } from '../observability/logger';

describe('database pragmas', () => {
  test('keeps mmap disabled for bind-mounted WAL databases', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-db-pragmas-'));
    const db = openDb({ dataDir });
    try {
      expect(readAppliedPragmas(db).mmap_size).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('runDbMaintenance', () => {
  test('optimizes FTS and truncates the WAL without throwing or warning', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-db-maint-'));
    const db = openDb({ dataDir });
    try {
      migrate(db, dataDir);
      let warnCount = 0;
      let errorCount = 0;
      const logger = {
        info: () => undefined,
        warn: () => { warnCount += 1; },
        error: () => { errorCount += 1; },
      } as unknown as Pick<AppLogger, 'info' | 'warn' | 'error'>;
      expect(readAppliedPragmas(db).journal_mode).toBe('wal');
      expect(() => { runDbMaintenance(db, logger); }).not.toThrow();
      runDbMaintenance(db, logger); // idempotent on an already-clean DB
      expect(warnCount).toBe(0);
      expect(errorCount).toBe(0);
    } finally {
      db.close();
    }
  });
});
