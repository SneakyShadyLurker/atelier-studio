import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate';
import {
  readModelResolutionOverride,
  readModelResolutionOverrides,
  writeModelResolutionOverride,
  type ModelResolutionDefaults,
} from './modelResolutionPreference';

const H3: ModelResolutionDefaults = { textToImage: '16mp', reference: '4mp' };
const NO_REFERENCE: ModelResolutionDefaults = { textToImage: '8mp', reference: null };

function withDb(run: (db: Database) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-model-resolution-'));
  const db = new Database(':memory:');
  try {
    migrate(db, dataDir);
    run(db);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function rowCount(db: Database): number {
  return db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user_model_resolution').get()?.count ?? -1;
}

describe('model resolution preference', () => {
  test('writes, reads and resets each mode per user and model', () => {
    withDb((db) => {
      expect(readModelResolutionOverride(db, 'alice', 'minimax-h3-image')).toBeUndefined();
      writeModelResolutionOverride(db, 'alice', 'minimax-h3-image', { textToImage: '8mp' }, H3, 1);
      writeModelResolutionOverride(db, 'bob', 'minimax-h3-image', { reference: '16mp' }, H3, 2);
      expect(readModelResolutionOverride(db, 'alice', 'minimax-h3-image')).toEqual({ textToImage: '8mp', reference: null });

      // An absent key leaves that mode unchanged.
      writeModelResolutionOverride(db, 'alice', 'minimax-h3-image', { reference: '8mp' }, H3, 3);
      expect(readModelResolutionOverride(db, 'alice', 'minimax-h3-image')).toEqual({ textToImage: '8mp', reference: '8mp' });
      expect(db.query('SELECT updated_at FROM user_model_resolution WHERE user_id = ?').get('alice')).toEqual({ updated_at: 3 });

      writeModelResolutionOverride(db, 'alice', 'minimax-h3-image', { textToImage: null }, H3);
      expect(readModelResolutionOverride(db, 'alice', 'minimax-h3-image')).toEqual({ textToImage: null, reference: '8mp' });
      writeModelResolutionOverride(db, 'alice', 'minimax-h3-image', { reference: null }, H3);
      expect(readModelResolutionOverride(db, 'alice', 'minimax-h3-image')).toBeUndefined();

      expect([...readModelResolutionOverrides(db, 'bob')]).toEqual([
        ['minimax-h3-image', { textToImage: null, reference: '16mp' }],
      ]);
      expect(readModelResolutionOverrides(db, 'alice').size).toBe(0);
    });
  });

  test('a value equal to the mode default is stored as NULL, and an all-NULL row is deleted', () => {
    withDb((db) => {
      writeModelResolutionOverride(db, 'alice', 'minimax-h3-image', { textToImage: '8mp', reference: '4mp' }, H3);
      expect(db.query('SELECT text_to_image, reference FROM user_model_resolution').get())
        .toEqual({ text_to_image: '8mp', reference: null });
      writeModelResolutionOverride(db, 'alice', 'minimax-h3-image', { textToImage: '16mp' }, H3);
      expect(rowCount(db)).toBe(0);
    });
  });

  test('a row without a reference default keeps the reference column NULL', () => {
    withDb((db) => {
      writeModelResolutionOverride(db, 'alice', 'text-only', { textToImage: '4mp' }, NO_REFERENCE);
      expect(readModelResolutionOverride(db, 'alice', 'text-only')).toEqual({ textToImage: '4mp', reference: null });
      writeModelResolutionOverride(db, 'alice', 'text-only', { textToImage: '8mp' }, NO_REFERENCE);
      expect(rowCount(db)).toBe(0);
    });
  });
});
