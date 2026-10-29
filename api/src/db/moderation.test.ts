import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BINARY_SCHEMA_VERSION, migrate } from './migrate';
import { tileModeration } from './moderation';

test('v48 preserves historical reasons and dependent rows without inventing categories', () => {
  const db = new Database(':memory:');
  try {
    db.run(`CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_versions VALUES (47, 'fixture');
      CREATE TABLE tiles (id TEXT PRIMARY KEY, moderation_reason TEXT);
      INSERT INTO tiles VALUES ('old', 'sexual-age');
      CREATE TABLE tile_ref_images (tile_id TEXT REFERENCES tiles(id) ON DELETE CASCADE);
      INSERT INTO tile_ref_images VALUES ('old');`);
    migrate(db, '/tmp');
    migrate(db, '/tmp');
    expect(db.query('SELECT * FROM tiles').get()).toEqual({ id: 'old', moderation_reason: 'sexual-age', moderation_categories: null });
    expect(db.query('SELECT * FROM tile_ref_images').all()).toEqual([{ tile_id: 'old' }]);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.query('SELECT MAX(version) AS version FROM schema_versions').get()).toEqual({ version: BINARY_SCHEMA_VERSION });
    db.query('UPDATE tiles SET moderation_categories=?').run('["nudity","graphic-violence"]');
    expect(() => db.query('UPDATE tiles SET moderation_categories=?').run('invalid')).toThrow();
  } finally { db.close(); }
});

test('stored categories are validated, with a broad fallback for old or malformed metadata', () => {
  expect(tileModeration({ moderation_reason: 'sexual-age', moderation_categories: '["nudity"]' }))
    .toEqual({ reason: 'sexual-age', categories: ['nudity'], target: 'image' });
  for (const value of [null, 'invalid', '["provider prose"]', '[]', '["nudity","nudity"]']) {
    expect(tileModeration({ moderation_reason: 'sexual-age', moderation_categories: value }))
      .toEqual({ reason: 'sexual-age', target: 'image' });
  }
  expect(tileModeration({ moderation_reason: 'unavailable', moderation_categories: '["nudity"]' }))
    .toEqual({ reason: 'unavailable', target: 'image' });
});
