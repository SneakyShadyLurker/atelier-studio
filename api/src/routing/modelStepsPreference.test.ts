import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate';
import {
  readModelStepsOverride,
  readModelStepsOverrides,
  writeModelStepsOverride,
} from './modelStepsPreference';

function withDb(run: (db: Database) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-model-steps-'));
  const db = new Database(':memory:');
  try {
    migrate(db, dataDir);
    run(db);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('model steps preference', () => {
  test('writes, reads and resets an override per user and model', () => {
    withDb((db) => {
      expect(readModelStepsOverride(db, 'alice', 'krea-2-gonzalomo')).toBeUndefined();
      writeModelStepsOverride(db, 'alice', 'krea-2-gonzalomo', 12, 8, 1);
      writeModelStepsOverride(db, 'alice', 'moss-image-sft', 30, 50, 2);
      writeModelStepsOverride(db, 'bob', 'krea-2-gonzalomo', 4, 8, 3);
      expect(readModelStepsOverride(db, 'alice', 'krea-2-gonzalomo')).toBe(12);
      expect([...readModelStepsOverrides(db, 'alice')].sort()).toEqual([['krea-2-gonzalomo', 12], ['moss-image-sft', 30]]);

      writeModelStepsOverride(db, 'alice', 'krea-2-gonzalomo', 16, 8, 4);
      expect(readModelStepsOverride(db, 'alice', 'krea-2-gonzalomo')).toBe(16);

      writeModelStepsOverride(db, 'alice', 'krea-2-gonzalomo', null, 8);
      expect(readModelStepsOverride(db, 'alice', 'krea-2-gonzalomo')).toBeUndefined();
      expect(readModelStepsOverride(db, 'bob', 'krea-2-gonzalomo')).toBe(4);
    });
  });

  test('a value equal to the default deletes the row instead of storing it', () => {
    withDb((db) => {
      writeModelStepsOverride(db, 'alice', 'moss-image-sft', 30, 50);
      writeModelStepsOverride(db, 'alice', 'moss-image-sft', 50, 50);
      expect(db.query('SELECT COUNT(*) AS count FROM user_model_steps').get()).toEqual({ count: 0 });
    });
  });

  test('the CHECK rejects values outside 1-100', () => {
    withDb((db) => {
      expect(() => { writeModelStepsOverride(db, 'alice', 'krea-2-test-alpha', 0, 8); }).toThrow(/CHECK constraint failed/i);
      expect(() => { writeModelStepsOverride(db, 'alice', 'krea-2-test-alpha', 101, 8); }).toThrow(/CHECK constraint failed/i);
      writeModelStepsOverride(db, 'alice', 'krea-2-test-alpha', 1, 8);
      writeModelStepsOverride(db, 'alice', 'krea-2-test-beta', 100, 11);
      expect(readModelStepsOverrides(db, 'alice').size).toBe(2);
    });
  });
});
