import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINARY_SCHEMA_VERSION, migrate } from './migrate';
import { SQL_UPLOAD_UNREFERENCED } from '../storage/uploadStore';

for (const upgrade of [false, true]) {
  test(`rendering-story reference lookup is indexed after ${upgrade ? 'v56 upgrade' : 'fresh migration'}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-migration57-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dir);
      if (upgrade) {
        db.run('DROP INDEX idx_stories_rendering_source_upload');
        db.run('DELETE FROM schema_versions WHERE version >= 57');
        migrate(db, dir);
      }
      expect(db.query('SELECT MAX(version) AS version FROM schema_versions').get())
        .toEqual({ version: BINARY_SCHEMA_VERSION });
      const plan = db.query<{ detail: string }, []>(
        `EXPLAIN QUERY PLAN SELECT id FROM uploads WHERE ${SQL_UPLOAD_UNREFERENCED}`,
      ).all().map((row) => row.detail);
      expect(plan.some((line) => line.includes('idx_stories_rendering_source_upload'))).toBe(true);
      expect(plan.some((line) => line === 'SCAN stories')).toBe(false);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
