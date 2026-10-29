import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db/client';
import { BINARY_SCHEMA_VERSION, migrate, MigrationError, type FileMigrationEvent } from '../db/migrate';
import { tempDir } from './helpers';

function seedVersion5Db(dataDir: string): ReturnType<typeof openDb> {
  const db = openDb({ dataDir });
  db.run('CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
    .run(5, new Date().toISOString());
  db.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE batches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      ratio TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
  `);
  db.run(`
    CREATE TABLE tiles (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tile_index INTEGER NOT NULL,
      seed INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('loading', 'done', 'failed')),
      ext TEXT,
      mime TEXT,
      error TEXT,
      completed_at INTEGER,
      archived_at INTEGER
    );
  `);
  return db;
}

function seedVersion2Db(dataDir: string): ReturnType<typeof openDb> {
  const db = openDb({ dataDir });
  db.run('CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
    .run(2, new Date().toISOString());
  db.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE batches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      ratio TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
  `);
  db.run(`
    CREATE TABLE tiles (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tile_index INTEGER NOT NULL,
      seed INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('loading', 'done', 'failed')),
      ext TEXT,
      mime TEXT,
      error TEXT,
      completed_at INTEGER,
      archived_at INTEGER
    );
  `);
  return db;
}

function seedVersion3Db(dataDir: string): ReturnType<typeof openDb> {
  const db = seedVersion2Db(dataDir);
  db.query('UPDATE schema_versions SET version = 3').run();
  return db;
}

describe('migration runner', () => {
  test('v51 preserves ready master metadata and leaves its publication revision unknown for recovery', () => {
    const dataDir = tempDir();
    const db = openDb({ dataDir });
    migrate(db, dataDir);
    // Recreate the immediately preceding schema without changing existing data.
    db.run('ALTER TABLE video_sequences DROP COLUMN master_revision');
    db.run('ALTER TABLE video_sequences DROP COLUMN stitch_pending');
    db.run('DELETE FROM schema_versions WHERE version >= 51');
    db.run("INSERT INTO users (id, created_at) VALUES ('u', 1)");
    db.run(`INSERT INTO video_sequences
      (id, user_id, created_at, updated_at, master_status, master_updated_at, stitch_revision)
      VALUES ('s', 'u', 1, 2, 'ready', 2, 7)`);
    migrate(db, dataDir);
    expect(db.query('SELECT master_status, master_updated_at, stitch_revision, master_revision, stitch_pending FROM video_sequences').get())
      .toEqual({ master_status: 'ready', master_updated_at: 2, stitch_revision: 7, master_revision: null, stitch_pending: 0 });
    migrate(db, dataDir);
    expect(db.query('SELECT COUNT(*) AS count FROM schema_versions WHERE version = 51').get()).toEqual({ count: 1 });
    db.close();
  });

  test('applies pending migrations in version order', () => {
    const dataDir = tempDir();
    const db = openDb({ dataDir });
    migrate(db, dataDir);
    const row = db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get();
    expect(row?.version).toBe(BINARY_SCHEMA_VERSION);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tiles'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='uploads'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tile_ref_images'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='prompt_templates'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='variable_lists'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='variable_options'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tag_dimensions'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='dimension_tags'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='option_tags'").get()).toBeTruthy();
    const userColumns = db.query<{ name: string }, []>("PRAGMA table_info('users')").all();
    expect(userColumns.some((column) => column.name === 'cache_scope')).toBe(true);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_cache_scope'").get()).toBeTruthy();
  });

  test('migration5 artifacts remain stable across repeated runner calls', () => {
    const dataDir = tempDir();
    const db = openDb({ dataDir });
    migrate(db, dataDir);

    migrate(db, dataDir);

    expect(db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version).toBe(BINARY_SCHEMA_VERSION);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_uploads_user_created'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_uploads_user_sha256'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tile_ref_images_upload'").get()).toBeTruthy();
  });

  test('migration6 applies cleanly on a v5 database', () => {
    const dataDir = tempDir();
    const db = seedVersion5Db(dataDir);

    migrate(db, dataDir);

    expect(db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version).toBe(BINARY_SCHEMA_VERSION);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='collections'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_collections_user_sort'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_batches_user_collection'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_batches_user_pinned'").get()).toBeTruthy();
  });

  test('migration6 is idempotent when the runner is called twice', () => {
    const dataDir = tempDir();
    const db = seedVersion5Db(dataDir);

    migrate(db, dataDir);
    migrate(db, dataDir);

    expect(db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version).toBe(BINARY_SCHEMA_VERSION);
    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schema_versions WHERE version = 6').get()?.count).toBe(1);
  });

  test('migration6 defaults existing batches to unsorted and unpinned', () => {
    const dataDir = tempDir();
    const db = seedVersion5Db(dataDir);
    const now = Date.now();
    const userId = 'u';
    const batchId = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    ).run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);

    migrate(db, dataDir);

    const row = db
      .query<{ collection_id: string | null; pinned: 0 | 1 }, [string]>(
        'SELECT collection_id, pinned FROM batches WHERE id = ?',
      )
      .get(batchId);
    expect(row).toEqual({ collection_id: null, pinned: 0 });
  });

  test('tile_ref_images cascade on tile delete but preserve upload rows', () => {
    const dataDir = tempDir();
    const db = openDb({ dataDir });
    migrate(db, dataDir);

    const now = Date.now();
    const userId = 'u';
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    const uploadA = crypto.randomUUID();
    const uploadB = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, 0, 0, 'loading')",
    ).run(tileId, batchId, userId);
    const insertUpload = db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, ?, ?)",
    );
    insertUpload.run(uploadA, userId, 'sha-a', now);
    insertUpload.run(uploadB, userId, 'sha-b', now);
    const insertRef = db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, ?)');
    insertRef.run(tileId, uploadA, 0);
    insertRef.run(tileId, uploadB, 1);

    db.query('DELETE FROM tiles WHERE id = ?').run(tileId);

    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM tile_ref_images').get()?.count).toBe(0);
    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM uploads').get()?.count).toBe(2);
  });

  test('upload rows cannot be deleted while referenced by tile_ref_images', () => {
    const dataDir = tempDir();
    const db = openDb({ dataDir });
    migrate(db, dataDir);

    const now = Date.now();
    const userId = 'u';
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, 0, 0, 'loading')",
    ).run(tileId, batchId, userId);
    db.query(
      "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', 3, 1, 1, 'sha', ?)",
    ).run(uploadId, userId, now);
    db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, 0)').run(tileId, uploadId);

    expect(() => {
      db.query('DELETE FROM uploads WHERE id = ?').run(uploadId);
    }).toThrow();
    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(uploadId)).toBeTruthy();
    expect(db.query('SELECT upload_id FROM tile_ref_images WHERE upload_id = ?').get(uploadId)).toBeTruthy();
  });

  test('refuses newer database schema', () => {
    const dataDir = tempDir();
    const db = openDb({ dataDir });
    db.run('CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(999, new Date().toISOString());
    expect(() => { migrate(db, dataDir); }).toThrow(MigrationError);
  });

  test('migration3 purges phantom archived failed/loading tiles + their orphan batches, leaving done rows intact', () => {
    const dataDir = tempDir();
    const db = seedVersion2Db(dataDir);

    const now = Date.now();
    const userId = 'u';
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);

    // Phantom batch A: only an archived failed tile. Should be purged entirely.
    const phantomBatch = crypto.randomUUID();
    const phantomTile = crypto.randomUUID();
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(phantomBatch, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now, now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, error, completed_at, archived_at) VALUES (?, ?, ?, 0, 0, 'failed', 'internal error', ?, ?)",
    ).run(phantomTile, phantomBatch, userId, now, now);

    // Phantom batch B: archived loading tile (interrupted but never reconciled before archive).
    const loadingBatch = crypto.randomUUID();
    const loadingTile = crypto.randomUUID();
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(loadingBatch, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now, now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, completed_at, archived_at) VALUES (?, ?, ?, 0, 0, 'loading', NULL, ?)",
    ).run(loadingTile, loadingBatch, userId, now);

    // Control batch C: archived done tile. MUST survive.
    const doneBatch = crypto.randomUUID();
    const doneTile = crypto.randomUUID();
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(doneBatch, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now, now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at, archived_at) VALUES (?, ?, ?, 0, 0, 'done', 'png', 'image/png', ?, ?)",
    ).run(doneTile, doneBatch, userId, now, now);

    migrate(db, dataDir);

    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(phantomTile)).toBeNull();
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(phantomBatch)).toBeNull();
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(loadingTile)).toBeNull();
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(loadingBatch)).toBeNull();
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(doneTile)).toBeTruthy();
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(doneBatch)).toBeTruthy();
    expect(db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version).toBe(BINARY_SCHEMA_VERSION);
  });

  test('migration4 moves flat artifacts into user directories, skips missing/existing files, leaves orphans for startupReconcile', () => {
    const dataDir = tempDir();
    const db = seedVersion3Db(dataDir);

    const now = Date.now();
    const images = join(dataDir, 'images');
    const userId = 'alice';
    const batchId = crypto.randomUUID();
    const movedTile = crypto.randomUUID();
    const missingTile = crypto.randomUUID();
    const existingTile = crypto.randomUUID();
    const orphanTile = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    for (const tileId of [movedTile, missingTile, existingTile]) {
      db.query(
        "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, 0, 0, 'done', 'png', 'image/png', ?)",
      ).run(tileId, batchId, userId, now);
    }

    mkdirSync(images, { recursive: true });
    writeFileSync(join(images, `${movedTile}.png`), 'move me');
    mkdirSync(join(images, userId), { recursive: true });
    writeFileSync(join(images, userId, `${existingTile}.png`), 'already moved');
    writeFileSync(join(images, `${orphanTile}.png`), 'orphan');

    const events: FileMigrationEvent[] = [];
    migrate(db, dataDir, { onFileMigrationEvent: (event) => events.push(event) });

    const counts = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.action] = (acc[event.action] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toMatchObject({
      moved: 1,
      skipped_missing: 1,
      skipped_existing: 1,
    });
    expect(existsSync(join(images, userId, `${movedTile}.png`))).toBe(true);
    expect(existsSync(join(images, `${movedTile}.png`))).toBe(false);
    expect(existsSync(join(images, userId, `${existingTile}.png`))).toBe(true);
    expect(existsSync(join(images, `${missingTile}.png`))).toBe(false);
    expect(existsSync(join(images, userId, `${missingTile}.png`))).toBe(false);
    // Root-level orphans are NOT touched by v4 — startupReconcile reaps
    // them with its threshold-guarded unlink loop.
    expect(existsSync(join(images, `${orphanTile}.png`))).toBe(true);
    expect(db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version).toBe(BINARY_SCHEMA_VERSION);
  });

  test('migration4 refuses to run when a pre-existing user_id violates USER_ID_PATTERN', () => {
    const dataDir = tempDir();
    const db = seedVersion3Db(dataDir);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('.legacy', Date.now());
    expect(() => { migrate(db, dataDir); }).toThrow(MigrationError);
    // Schema must NOT have been bumped to 4.
    expect(db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version).toBe(3);
  });

  test('migration4 is idempotent across a partial-FS-then-rerun sequence', () => {
    const dataDir = tempDir();
    const db = seedVersion3Db(dataDir);

    const now = Date.now();
    const images = join(dataDir, 'images');
    const userId = 'alice';
    const batchId = crypto.randomUUID();
    const tileA = crypto.randomUUID();
    const tileB = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    for (const tileId of [tileA, tileB]) {
      db.query(
        "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, 0, 0, 'done', 'png', 'image/png', ?)",
      ).run(tileId, batchId, userId, now);
    }
    // Simulate a previous run that succeeded for tileA but never made it
    // to the schema_versions INSERT — tileA already at the per-user path,
    // tileB still at the flat path.
    mkdirSync(join(images, userId), { recursive: true });
    writeFileSync(join(images, userId, `${tileA}.png`), 'already-moved');
    writeFileSync(join(images, `${tileB}.png`), 'still-flat');

    const events: FileMigrationEvent[] = [];
    migrate(db, dataDir, { onFileMigrationEvent: (event) => events.push(event) });
    const counts = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.action] = (acc[event.action] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toMatchObject({ moved: 1, skipped_existing: 1 });
    expect(existsSync(join(images, userId, `${tileA}.png`))).toBe(true);
    expect(existsSync(join(images, userId, `${tileB}.png`))).toBe(true);
    expect(existsSync(join(images, `${tileB}.png`))).toBe(false);
  });

  test('migration37 creates user_text_backends on a fresh database', () => {
    const dataDir = tempDir();
    const db = openDb({ dataDir });

    migrate(db, dataDir);

    expect(db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version).toBe(BINARY_SCHEMA_VERSION);
    const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_text_backends'").get();
    expect(table).toBeTruthy();
    const columns = db.query<{ name: string }, []>("PRAGMA table_info('user_text_backends')").all().map((c) => c.name);
    expect(columns).toEqual(['user_id', 'workload', 'backend', 'updated_at', 'effort']);
    // CHECK constraint rejects anything outside the selectable backends.
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u', Date.now());
    for (const backend of ['kimi', 'mimo', 'grok', 'gemini-argon', 'deepseek-abliterated', 'glm-abliterated', 'gpt']) {
      db.query(
        "INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u', ?, ?, 1)",
      ).run(backend, backend);
    }
    expect(() => {
      db.query("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u', 'ai-fill', 'unknown', 1)").run();
    }).toThrow();
    // Retired keys are rejected by the CHECK — hard cut, no alias.
    for (const retired of ['flash', 'qwen', 'glm-flash', 'deepseek-flash']) {
      expect(() => {
        db.query("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u', 'brainstorm', ?, 1)").run(retired);
      }).toThrow();
    }
  });

  test('migration37 is idempotent when the runner is called twice and cascades on user delete', () => {
    const dataDir = tempDir();
    const db = openDb({ dataDir });
    migrate(db, dataDir);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u', Date.now());
    db.query("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u', 'condense', 'kimi', 1)").run();

    migrate(db, dataDir);

    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schema_versions WHERE version = 37').get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user_text_backends').get()?.count).toBe(1);

    db.query('DELETE FROM users WHERE id = ?').run('u');
    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user_text_backends').get()?.count).toBe(0);
  });
});
