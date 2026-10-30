import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINARY_SCHEMA_VERSION, migrate } from './migrate';

// Migration 58 moves the text-backend pins into user_text_models and drops
// user_text_backends; the historical text-backend tests stop at 57 so they
// can still read and constrain that table.
const LEGACY_TEXT_TABLE = { targetVersion: 57 } as const;

function dropVariableOptionWeightForMigrationReplay(db: Database): void {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info('variable_options')")
    .all();
  if (cols.some((col) => col.name === 'weight')) {
    db.run('ALTER TABLE variable_options DROP COLUMN weight');
  }
}

function promptLibraryRevision(db: Database, userId: string): number {
  return db
    .query<{ revision: number }, [string]>(
      'SELECT revision FROM prompt_library_revisions WHERE user_id = ?',
    )
    .get(userId)?.revision ?? 0;
}

describe('migration 7 - user_provider_keys', () => {
  test('creates user_provider_keys with composite PK and FK on users', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig7-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);

    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(10);

    const tableInfo = db.query<
      { name: string; type: string; notnull: number; pk: number },
      []
    >('PRAGMA table_info(user_provider_keys)').all();
    const cols = Object.fromEntries(tableInfo.map((row) => [row.name, row]));

    expect(cols.user_id).toMatchObject({ type: 'TEXT', notnull: 1, pk: 1 });
    expect(cols.provider).toMatchObject({ type: 'TEXT', notnull: 1, pk: 2 });
    expect(cols.ciphertext).toMatchObject({ type: 'BLOB', notnull: 1 });
    expect(cols.nonce).toMatchObject({ type: 'BLOB', notnull: 1 });
    expect(cols.key_version).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(cols.fingerprint).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(cols.last_used_at).toMatchObject({ type: 'INTEGER', notnull: 0 });
    expect(cols.created_at).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(cols.updated_at).toMatchObject({ type: 'INTEGER', notnull: 1 });

    const checkRow = db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='user_provider_keys'",
      )
      .get();
    expect(checkRow?.sql).toContain("provider IN ('google')");
    expect(checkRow?.sql).toContain('REFERENCES users(id) ON DELETE CASCADE');
  });
});

describe('migration 15 - generation queue batch columns', () => {
  test('adds batches.status and batches.pool with queue indexes', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig15-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);

    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info('batches')")
      .all();
    expect(cols.some((col) => col.name === 'status')).toBe(true);
    expect(cols.some((col) => col.name === 'pool')).toBe(true);

    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='batches'",
      )
      .all();
    expect(indexes.some((index) => index.name === 'idx_batches_queue')).toBe(true);
    expect(indexes.some((index) => index.name === 'idx_batches_user_queued')).toBe(true);
  });
});

describe('migration 16 - local pool repair', () => {
  test('repairs zib-distilled rows that migration 15 backfilled as shared', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig16-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(16);

    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES ('b-local', 'u1', 'p', '1:1', 'zib-distilled', 'ZIB Distilled', 1, 'done', 'shared')`,
    ).run();
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES ('b-cloud', 'u1', 'p', '1:1', 'gpt-image-2', 'GPT Image 2', 2, 'done', 'shared')`,
    ).run();
    db.query('DELETE FROM schema_versions WHERE version >= 16').run();
    dropVariableOptionWeightForMigrationReplay(db);

    migrate(db, dataDir);

    expect(db.query<{ pool: string }, []>("SELECT pool FROM batches WHERE id='b-local'").get()?.pool).toBe('local');
    expect(db.query<{ pool: string }, []>("SELECT pool FROM batches WHERE id='b-cloud'").get()?.pool).toBe('shared');
  });
});

describe('migration 19 - tiles.error CHECK rebuild', () => {
  // The table-rebuild idiom (RENAME TO tiles_old +
  // CREATE TABLE tiles + INSERT...SELECT + DROP TABLE tiles_old) with
  // foreign_keys=ON used to cascade-wipe every `tile_ref_images` row before
  // the conditional rebuild could re-point the FK. Migration 19 now toggles
  // PRAGMA foreign_keys OFF around the rebuild per SQLite docs §4.6.
  test('preserves tile_ref_images rows across the tiles rebuild', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig19-'));
    const db = new Database(':memory:');
    // Run all prior migrations to land on a v18 schema with tile_ref_images
    // present, then back schema_versions off so migration 19 fires below.
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(19);

    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES ('b1', 'u1', 'p', '1:1', 'gpt-image-2', 'GPT Image 2', 1, 'done', 'shared')`,
    ).run();
    db.query(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime)
       VALUES ('t1', 'b1', 'u1', 0, 0, 'done', 'webp', 'image/webp')`,
    ).run();
    db.query(
      `INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at)
       VALUES ('up1', 'u1', 'png', 'image/png', 1, 1, 1, 'a', 1)`,
    ).run();
    db.query(
      `INSERT INTO tile_ref_images (tile_id, upload_id, position)
       VALUES ('t1', 'up1', 0)`,
    ).run();

    // Roll the schema back to 18 so migration 19 re-fires under realistic
    // FK pressure (real rows in tile_ref_images pointing at tiles).
    db.query('DELETE FROM schema_versions WHERE version >= 19').run();
    dropVariableOptionWeightForMigrationReplay(db);
    migrate(db, dataDir);

    // tile_ref_images row must survive the tiles rebuild.
    const ref = db
      .query<{ tile_id: string; upload_id: string; position: number }, []>(
        "SELECT tile_id, upload_id, position FROM tile_ref_images WHERE tile_id='t1'",
      )
      .get();
    expect(ref).toMatchObject({ tile_id: 't1', upload_id: 'up1', position: 0 });

    // tiles row must survive with original error column data preserved.
    const tile = db
      .query<{ id: string; status: string; error: string | null }, []>(
        "SELECT id, status, error FROM tiles WHERE id='t1'",
      )
      .get();
    expect(tile).toMatchObject({ id: 't1', status: 'done', error: null });

    // CHECK constraint refuses an out-of-enum error value.
    expect(() =>
      db
        .query(
          "UPDATE tiles SET status='failed', error='not-in-enum' WHERE id='t1'",
        )
        .run(),
    ).toThrow();

    // CHECK constraint accepts the legacy 'client disconnected' bucket.
    db.query("UPDATE tiles SET status='failed', error='client disconnected' WHERE id='t1'").run();
    expect(
      db.query<{ error: string | null }, []>("SELECT error FROM tiles WHERE id='t1'").get()?.error,
    ).toBe('client disconnected');

    // foreign_keys must be back ON after the migration completes.
    expect(
      db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys,
    ).toBe(1);
  });
});

describe('migration 20 - variable_options.weight', () => {
  test('variable_options gains weight column with CHECK and DEFAULT 1', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig20-'));
    const db = new Database(':memory:');
    try {
      db.run(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE schema_versions (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        INSERT INTO schema_versions (version, applied_at)
        VALUES
          (1, 'now'), (2, 'now'), (3, 'now'), (4, 'now'), (5, 'now'),
          (6, 'now'), (7, 'now'), (8, 'now'), (9, 'now'), (10, 'now'),
          (11, 'now'), (12, 'now'), (13, 'now'), (14, 'now'), (15, 'now'),
          (16, 'now'), (17, 'now'), (18, 'now'), (19, 'now');

        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE variable_lists (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          UNIQUE (user_id, name)
        );
        CREATE TABLE variable_options (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          list_id     TEXT NOT NULL REFERENCES variable_lists(id) ON DELETE CASCADE,
          value       TEXT NOT NULL,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL
        );
        CREATE TABLE prompt_library_revisions (
          user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          revision    INTEGER NOT NULL DEFAULT 0,
          updated_at  INTEGER NOT NULL
        );

        INSERT INTO users (id, created_at) VALUES ('u', 1);
        INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at)
          VALUES ('l1', 'u', 'list', 0, 1, 1);
        INSERT INTO variable_options (id, user_id, list_id, value, sort_order, created_at)
          VALUES ('o1', 'u', 'l1', 'opt', 0, 1);
      `);

      migrate(db, dataDir);

      const after = db
        .query<{ weight: number }, []>("SELECT weight FROM variable_options WHERE id = 'o1'")
        .get();
      expect(after).not.toBeNull();
      expect(after?.weight).toBe(1);

      expect(() =>
        db.run(
          `INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at)
           VALUES ('o2', 'u', 'l1', 'x', 0, -1, 1)`,
        ),
      ).toThrow(/CHECK constraint failed/i);
      expect(() =>
        db.run(
          `INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at)
           VALUES ('o3', 'u', 'l1', 'x', 0, 101, 1)`,
        ),
      ).toThrow(/CHECK constraint failed/i);

      db.run(
        `INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at)
         VALUES ('o4', 'u', 'l1', 'x', 0, 0, 1)`,
      );
      db.run(
        `INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at)
         VALUES ('o5', 'u', 'l1', 'x', 0, 100, 1)`,
      );
    } finally {
      db.close();
    }
  });
});

describe('migration 22 - tiles.error CHECK rebuild for service unavailable', () => {
  // Mirrors migration-19 test: seeds tile_ref_images rows, rolls schema back
  // below 22 to force re-fire, re-runs migrate, then asserts:
  //   (a) 'service unavailable' is now accepted by the CHECK constraint
  //   (b) tile_ref_images rows survive the FK-toggle rebuild
  //   (c) foreign_keys is re-enabled after migration
  test("accepts 'service unavailable' and preserves tile_ref_images across rebuild", () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig22-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(22);

    // Seed a batch, tile, upload, and a tile_ref_images child row — the child
    // row is the FK-cascade probe: if foreign_keys is ON during DROP TABLE tiles_old,
    // the cascade wipes it and this assertion fails.
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES ('b1', 'u1', 'p', '1:1', 'gpt-image-2', 'GPT Image 2', 1, 'done', 'shared')`,
    ).run();
    db.query(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime)
       VALUES ('t1', 'b1', 'u1', 0, 0, 'done', 'webp', 'image/webp')`,
    ).run();
    db.query(
      `INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at)
       VALUES ('up1', 'u1', 'png', 'image/png', 1, 1, 1, 'a', 1)`,
    ).run();
    db.query(
      `INSERT INTO tile_ref_images (tile_id, upload_id, position)
       VALUES ('t1', 'up1', 0)`,
    ).run();

    // Roll schema back below 22 to force migration 22 to re-fire.
    db.query('DELETE FROM schema_versions WHERE version >= 22').run();
    migrate(db, dataDir);

    // tile_ref_images row must survive the tiles rebuild (FK-toggle proof).
    const ref = db
      .query<{ tile_id: string; upload_id: string; position: number }, []>(
        "SELECT tile_id, upload_id, position FROM tile_ref_images WHERE tile_id='t1'",
      )
      .get();
    expect(ref).toMatchObject({ tile_id: 't1', upload_id: 'up1', position: 0 });

    // tiles row must survive with data intact.
    const tile = db
      .query<{ id: string; status: string; error: string | null }, []>(
        "SELECT id, status, error FROM tiles WHERE id='t1'",
      )
      .get();
    expect(tile).toMatchObject({ id: 't1', status: 'done', error: null });

    // New CHECK value must now be accepted.
    db.query("INSERT INTO users (id, created_at) VALUES ('u2', 2)").run();
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES ('b2', 'u2', 'p', '1:1', 'gpt-image-2', 'GPT Image 2', 2, 'done', 'shared')`,
    ).run();
    expect(() =>
      db
        .query(
          `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, error)
           VALUES ('t2', 'b2', 'u2', 0, 0, 'failed', 'service unavailable')`,
        )
        .run(),
    ).not.toThrow();
    const inserted = db
      .query<{ error: string | null }, []>("SELECT error FROM tiles WHERE id='t2'")
      .get();
    expect(inserted?.error).toBe('service unavailable');

    // Out-of-enum values must still be rejected.
    expect(() =>
      db
        .query(
          `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, error)
           VALUES ('t3', 'b2', 'u2', 1, 0, 'failed', 'not-in-enum')`,
        )
        .run(),
    ).toThrow();

    // foreign_keys must be back ON after the migration completes.
    expect(
      db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys,
    ).toBe(1);

    // Lock-in: tile_ref_images FK must reference the live 'tiles' table, NOT
    // the dropped 'tiles_old'. The parent rename does NOT rewrite child FKs in
    // Bun's SQLite, so this assertion is an empirical regression guard.
    const childSql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='tile_ref_images'").get()?.sql ?? '';
    expect(childSql).toContain('REFERENCES tiles(id)');
    expect(childSql).not.toContain('tiles_old');
    // With foreign_keys ON, no dangling references after the rebuild:
    db.run('PRAGMA foreign_keys = ON');
    expect(db.query('PRAGMA foreign_key_check').all().length).toBe(0);
  });
});

describe('migration 24 - batch provenance', () => {
  // Mirrors the migration 16/19/22 replay pattern: run all migrations to the
  // head schema, seed provenance-carrying rows, roll schema_versions back below
  // 24 to force a re-fire, re-run migrate, then assert columns + ON DELETE SET
  // NULL. Plain ADD COLUMN — no FK-rebuild, no foreign_keys toggle.
  test('adds template_id/roll_seed/roll_pins and nulls template_id on template delete', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig24-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(24);

    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info('batches')")
      .all()
      .map((col) => col.name);
    expect(cols).toContain('template_id');
    expect(cols).toContain('roll_seed');
    expect(cols).toContain('roll_pins');

    // Seed a user, a template, and a batch carrying provenance.
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO prompt_templates (id, user_id, name, body, notes, sort_order, created_at, updated_at)
       VALUES ('tpl1', 'u1', 'Test Template', 'body', NULL, 0, 1, 1)`,
    ).run();
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, template_id, roll_seed, roll_pins)
       VALUES ('b1', 'u1', 'p', '1:1', 'gpt-image-2', 'GPT Image 2', 1, 'done', 'shared', 'tpl1', 4242, '{"face#0":"opt-a"}')`,
    ).run();

    // Round-trip read back the provenance columns.
    const before = db
      .query<{ template_id: string | null; roll_seed: number | null; roll_pins: string | null }, []>(
        "SELECT template_id, roll_seed, roll_pins FROM batches WHERE id='b1'",
      )
      .get();
    expect(before).toMatchObject({ template_id: 'tpl1', roll_seed: 4242, roll_pins: '{"face#0":"opt-a"}' });

    // ON DELETE SET NULL: deleting the template nulls template_id but keeps the row.
    db.run('PRAGMA foreign_keys = ON');
    db.query("DELETE FROM prompt_templates WHERE id='tpl1'").run();
    const after = db
      .query<{ template_id: string | null; roll_seed: number | null }, []>(
        "SELECT template_id, roll_seed FROM batches WHERE id='b1'",
      )
      .get();
    expect(after).toMatchObject({ template_id: null, roll_seed: 4242 });

    // Replay guard: roll schema_versions back below 24 and re-run migrate to
    // prove the migration is idempotent on a populated DB.
    db.query('DELETE FROM schema_versions WHERE version >= 24').run();
    // Drop the new columns so the ADD COLUMN re-fires cleanly on replay.
    db.run('ALTER TABLE batches DROP COLUMN template_id');
    db.run('ALTER TABLE batches DROP COLUMN roll_seed');
    db.run('ALTER TABLE batches DROP COLUMN roll_pins');
    migrate(db, dataDir);
    const replayed = db
      .query<{ name: string }, []>("PRAGMA table_info('batches')")
      .all()
      .map((col) => col.name);
    expect(replayed).toContain('template_id');
    expect(replayed).toContain('roll_seed');
    expect(replayed).toContain('roll_pins');
  });
});

describe('migration 25 - prompt library revision', () => {
  test('tracks prompt-library mutations with durable per-user revision triggers', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig25-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(25);

    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dimension_tags'",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toContain('idx_dimension_tags_user_id');
    expect(indexes).toContain('idx_dimension_tags_user_dim_sort_label');

    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    expect(promptLibraryRevision(db, 'u1')).toBe(0);

    db.query(
      `INSERT INTO prompt_templates (id, user_id, name, body, notes, sort_order, created_at, updated_at)
       VALUES ('tpl1', 'u1', 'Template', 'body', NULL, 0, 1, 1)`,
    ).run();
    expect(promptLibraryRevision(db, 'u1')).toBeGreaterThanOrEqual(1);
    const afterTemplate = promptLibraryRevision(db, 'u1');

    db.query(
      `INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at)
       VALUES ('list1', 'u1', 'subject', 0, 1, 1)`,
    ).run();
    db.query(
      `INSERT INTO variable_options (id, user_id, list_id, value, sort_order, created_at, weight)
       VALUES ('opt1', 'u1', 'list1', 'detective', 0, 1, 1)`,
    ).run();
    expect(promptLibraryRevision(db, 'u1')).toBeGreaterThan(afterTemplate);
    const afterOption = promptLibraryRevision(db, 'u1');

    db.query(
      `INSERT INTO tag_dimensions (id, user_id, name, created_at)
       VALUES ('dim1', 'u1', 'era', 1)`,
    ).run();
    db.query(
      `INSERT INTO dimension_tags (id, user_id, dimension_id, label, sort_order)
       VALUES ('tag1', 'u1', 'dim1', 'noir', 0)`,
    ).run();
    db.query("INSERT INTO option_tags (option_id, tag_id) VALUES ('opt1', 'tag1')").run();
    expect(promptLibraryRevision(db, 'u1')).toBeGreaterThan(afterOption);
    const afterOptionTag = promptLibraryRevision(db, 'u1');

    db.query("DELETE FROM option_tags WHERE option_id = 'opt1' AND tag_id = 'tag1'").run();
    expect(promptLibraryRevision(db, 'u1')).toBeGreaterThan(afterOptionTag);
  });
});

describe('Unsorted feed planner stability', () => {
  // Pins the SQLite planner's choice of idx_batches_user_collection for the
  // default Unsorted feed query (treats `collection_id IS NULL` as an
  // indexable equality). A future schema change should not silently regress
  // this path to a SCAN/SORT.
  test('default Unsorted feed query uses idx_batches_user_collection', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-unsorted-eqp-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);

    db.run(`INSERT INTO users (id, created_at) VALUES ('alice', 1000)`);
    db.run(
      `INSERT INTO collections (id, user_id, name, sort_order, created_at)
       SELECT 'c'||v, 'alice', 'C'||v, v, 1000
       FROM (SELECT 1 v UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5
             UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10)`,
    );
    const insertBatch = db.prepare(
      `INSERT INTO batches (id, user_id, prompt, model_id, model_label, pool, ratio, created_at, status, collection_id, archived_at, pinned)
       VALUES (?, 'alice', 'p', 'm', 'M', 'shared', '1:1', ?, 'done', ?, NULL, 0)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        insertBatch.run(`b${i}`, 1_700_000_000_000 + i, i % 4 === 0 ? null : `c${(i % 10) + 1}`);
      }
    })();
    db.run('ANALYZE');

    const planFirstPage = db
      .query<{ detail: string }, [string]>(
        `EXPLAIN QUERY PLAN SELECT id FROM batches
         WHERE user_id = ? AND archived_at IS NULL AND collection_id IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 50`,
      )
      .all('alice')
      .map((row) => row.detail)
      .join(' / ');
    expect(planFirstPage).toContain('idx_batches_user_collection');

    const planCursorPage = db
      .query<{ detail: string }, [string, number, string]>(
        `EXPLAIN QUERY PLAN SELECT id FROM batches
         WHERE user_id = ? AND archived_at IS NULL AND collection_id IS NULL
           AND (created_at, id) < (?, ?)
         ORDER BY created_at DESC, id DESC LIMIT 50`,
      )
      .all('alice', 1_700_000_500_000, 'b500')
      .map((row) => row.detail)
      .join(' / ');
    expect(planCursorPage).toContain('idx_batches_user_collection');
  });
});

describe('migration 26 - archive-aware FTS cleanup', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig26-'));

  function insertBatch(db: Database, id: string, prompt: string, archivedAt: number | null): void {
    db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run('alice', 1);
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, 'alice', prompt, '1:1', 'm', 'M', 1, archivedAt);
  }

  function ftsBatchIds(db: Database): string[] {
    return db
      .query<{ batch_id: string }, []>('SELECT batch_id FROM batch_prompt_fts ORDER BY batch_id')
      .all()
      .map((row) => row.batch_id);
  }

  test('backfill purges already-archived rows; trigger keeps FTS in sync on archive/restore', () => {
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(26);

    // Re-create the pre-26 world: restore the old `batches_au_prompt_fts`
    // (no archived_at in its OF list) so archiving a batch leaves a stale row
    // in the FTS index — the bloat this migration is meant to bound.
    db.run(`
      DROP TRIGGER batches_au_prompt_fts;
      CREATE TRIGGER batches_au_prompt_fts
      AFTER UPDATE OF user_id, id, prompt ON batches
      BEGIN
        DELETE FROM batch_prompt_fts WHERE rowid = old.rowid;
        INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
        VALUES (new.rowid, new.user_id, new.id, new.prompt);
      END;
    `);

    insertBatch(db, 'active1', 'mountain sunrise', null);
    insertBatch(db, 'archived1', 'desert sunset', null);
    // Archive under the OLD trigger → the row stays in FTS (the leak).
    db.query('UPDATE batches SET archived_at = ? WHERE id = ?').run(1700, 'archived1');
    expect(ftsBatchIds(db)).toEqual(['active1', 'archived1']);

    // Replay migration 26.
    db.query('DELETE FROM schema_versions WHERE version >= 26').run();
    migrate(db, dataDir);

    // Backfill purged the stale archived row; the active row stays searchable.
    expect(ftsBatchIds(db)).toEqual(['active1']);
    const archivedHits = db
      .query<{ batch_id: string }, [string]>(
        'SELECT batch_id FROM batch_prompt_fts WHERE batch_prompt_fts MATCH ?',
      )
      .all('"desert"');
    expect(archivedHits).toHaveLength(0);

    // New trigger: archiving the active batch removes it from FTS...
    db.query('UPDATE batches SET archived_at = ? WHERE id = ?').run(1800, 'active1');
    expect(ftsBatchIds(db)).toEqual([]);
    // ...and restoring re-adds it.
    db.query('UPDATE batches SET archived_at = NULL WHERE id = ?').run('active1');
    expect(ftsBatchIds(db)).toEqual(['active1']);

    // INSERT trigger is active-only too: a batch created already-archived
    // never enters the FTS index (no later cleanup would otherwise reach it).
    insertBatch(db, 'born-archived', 'arctic aurora', 2000);
    expect(ftsBatchIds(db)).toEqual(['active1']);

    db.close();
  });
});

describe('migration 27 - retire xai pool', () => {
  test("remaps historical pool='xai' batches to 'shared'; leaves other pools intact", () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig27-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(27);

    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    // The CHECK list still permits 'xai' (intentionally not rebuilt), so a
    // legacy Grok batch can be seeded to exercise the remap.
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES ('b-grok', 'u1', 'p', '1:1', 'grok-imagine-image-quality', 'Grok Imagine', 1, 'done', 'xai')`,
    ).run();
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES ('b-byok', 'u1', 'p', '1:1', 'gemini-3-pro-image-preview', 'Nano Banana Pro', 2, 'done', 'byok')`,
    ).run();
    db.query('DELETE FROM schema_versions WHERE version >= 27').run();

    migrate(db, dataDir);

    expect(db.query<{ pool: string }, []>("SELECT pool FROM batches WHERE id='b-grok'").get()?.pool).toBe('shared');
    expect(db.query<{ pool: string }, []>("SELECT pool FROM batches WHERE id='b-byok'").get()?.pool).toBe('byok');

    db.close();
  });
});

describe('migration 28 - batch i2v source upload id', () => {
  test('adds nullable i2v_source_upload_id to batches', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig28-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(28);

    const cols = db
      .query<{ name: string; type: string; notnull: number }, []>("PRAGMA table_info('batches')")
      .all();
    expect(cols.find((col) => col.name === 'i2v_source_upload_id')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
    });

    db.close();
  });

  test('upgrades a pre-v28 database without rebuilding batches', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig28-replay-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(28);

    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES ('b1', 'u1', 'p', '1:1', 'mock-slow', 'Mock Slow', 1, 'queued', 'shared')`,
    ).run();
    const beforeRowid = db.query<{ rowid: number }, []>("SELECT rowid FROM batches WHERE id='b1'").get()?.rowid;

    db.query('DELETE FROM schema_versions WHERE version >= 28').run();
    // Pre-v28 had no index on the column either (v52 adds it).
    db.run('DROP INDEX idx_batches_i2v_source_upload');
    db.run('ALTER TABLE batches DROP COLUMN i2v_source_upload_id');

    migrate(db, dataDir);

    const after = db
      .query<{ rowid: number; i2v_source_upload_id: string | null }, []>(
        "SELECT rowid, i2v_source_upload_id FROM batches WHERE id='b1'",
      )
      .get();
    expect(after).toMatchObject({ rowid: beforeRowid, i2v_source_upload_id: null });

    db.close();
  });
});

describe('migration 29 - batch motion prompt', () => {
  test('adds nullable motion_prompt to batches', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig29-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(29);

    const cols = db
      .query<{ name: string; type: string; notnull: number }, []>("PRAGMA table_info('batches')")
      .all();
    expect(cols.find((col) => col.name === 'motion_prompt')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
    });

    db.close();
  });

  test('upgrades a pre-v29 database without rebuilding batches', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig29-replay-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(29);

    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES ('b1', 'u1', 'p', '1:1', 'mock-slow', 'Mock Slow', 1, 'queued', 'shared')`,
    ).run();
    const beforeRowid = db.query<{ rowid: number }, []>("SELECT rowid FROM batches WHERE id='b1'").get()?.rowid;

    db.query('DELETE FROM schema_versions WHERE version >= 29').run();
    db.run('ALTER TABLE batches DROP COLUMN motion_prompt');

    migrate(db, dataDir);

    const after = db
      .query<{ rowid: number; motion_prompt: string | null }, []>(
        "SELECT rowid, motion_prompt FROM batches WHERE id='b1'",
      )
      .get();
    expect(after).toMatchObject({ rowid: beforeRowid, motion_prompt: null });

    db.close();
  });
});

describe('migration 30 - user cache scope', () => {
  test('repairs a partial migration whose column exists but index does not', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig30-replay-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(30);

    db.run('DROP INDEX idx_users_cache_scope');
    db.query('DELETE FROM schema_versions WHERE version >= 30').run();

    migrate(db, dataDir);

    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_cache_scope'").get(),
    ).toBeTruthy();
    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(BINARY_SCHEMA_VERSION);

    db.close();
  });
});

describe('migration 31 - batch card notes', () => {
  test('upgrades a populated schema-version-30 database without row or rowid drift', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig31-'));
    const db = new Database(':memory:');

    // Build the exact v30 shape by reversing migration 31's sole ADD COLUMN,
    // then prove the fixture version before inserting any representative rows.
    migrate(db, dataDir);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(31);
    db.run('ALTER TABLE batches DROP COLUMN card_notes');
    db.query('DELETE FROM schema_versions WHERE version >= 31').run();
    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(30);
    expect(
      db.query<{ name: string }, []>("PRAGMA table_info('batches')").all().some((col) => col.name === 'card_notes'),
    ).toBe(false);

    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO batches
         (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool,
          i2v_source_upload_id, motion_prompt)
       VALUES
         ('b1', 'u1', 'portrait prompt', '1:1', 'mock-slow', 'Mock Slow', 1, 'queued', 'shared',
          NULL, NULL),
         ('b2', 'u1', 'motion prompt', '16:9', 'legacy-i2v', 'Legacy I2V', 2, 'done', 'local',
          'upload-1', 'walks into frame')`,
    ).run();
    const before = db.query<{
      rowid: number;
      id: string;
      prompt: string;
      status: string;
      pool: string;
      i2v_source_upload_id: string | null;
      motion_prompt: string | null;
    }, []>(
      `SELECT rowid, id, prompt, status, pool, i2v_source_upload_id, motion_prompt
         FROM batches ORDER BY id`,
    ).all();

    migrate(db, dataDir);

    const after = db.query<{
      rowid: number;
      id: string;
      prompt: string;
      status: string;
      pool: string;
      i2v_source_upload_id: string | null;
      motion_prompt: string | null;
      card_notes: string | null;
    }, []>(
      `SELECT rowid, id, prompt, status, pool, i2v_source_upload_id, motion_prompt, card_notes
         FROM batches ORDER BY id`,
    ).all();
    expect(after.map(({ card_notes: _cardNotes, ...row }) => row)).toEqual(before);
    expect(after.map((row) => row.card_notes)).toEqual([null, null]);

    const versions = db
      .query<{ version: number }, []>('SELECT version FROM schema_versions WHERE version >= 30 ORDER BY version')
      .all()
      .map((row) => row.version);
    expect(versions).toEqual(Array.from({ length: BINARY_SCHEMA_VERSION - 29 }, (_, index) => 30 + index));
    const column = db
      .query<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(
        "PRAGMA table_info('batches')",
      )
      .all()
      .find((col) => col.name === 'card_notes');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });

    db.close();
  });
});

describe('migration 33 - tag system v2', () => {
  test('fresh database lands on the current schema with additive tag-system structures', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig33-fresh-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);

    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(BINARY_SCHEMA_VERSION);
    const columns = (table: string) => db
      .query<{ name: string; dflt_value: string | null }, []>(`PRAGMA table_info('${table}')`)
      .all();
    expect(columns('tag_dimensions').some((column) => column.name === 'description')).toBe(true);
    expect(columns('dimension_tags').some((column) => column.name === 'parent_id')).toBe(true);
    expect(columns('option_tags').find((column) => column.name === 'polarity')?.dflt_value).toBe("'require'");
    db.close();
  });

  test('existing populated v32 database upgrades additively and defaults old memberships to require', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig33-upgrade-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);

    db.run('DROP TRIGGER option_tags_au_revision');
    db.run('ALTER TABLE option_tags DROP COLUMN polarity');
    db.run('ALTER TABLE dimension_tags DROP COLUMN parent_id');
    db.run('ALTER TABLE tag_dimensions DROP COLUMN description');
    // Roll the fixture back to v32: every version above it, not just 33, or
    // MAX(version) still reports a newer schema than this scenario simulates.
    db.run('DELETE FROM schema_versions WHERE version >= 33');
    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(32);

    db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
    db.run("INSERT INTO tag_dimensions (id, user_id, name, created_at) VALUES ('d1', 'u1', 'Franchise', 1)");
    db.run("INSERT INTO dimension_tags (id, user_id, dimension_id, label, sort_order) VALUES ('t1', 'u1', 'd1', 'Warhammer', 0)");
    db.run("INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at) VALUES ('l1', 'u1', 'franchise', 0, 1, 1)");
    db.run("INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at) VALUES ('o1', 'u1', 'l1', 'Warhammer', 0, 1, 1)");
    db.run("INSERT INTO option_tags (option_id, tag_id) VALUES ('o1', 't1')");
    const before = db.query<{ rowid: number; option_id: string; tag_id: string }, []>(
      'SELECT rowid, option_id, tag_id FROM option_tags',
    ).get();
    if (!before) throw new Error('expected pre-v33 option tag row');

    migrate(db, dataDir);

    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(BINARY_SCHEMA_VERSION);
    expect(db.query<{ rowid: number; option_id: string; tag_id: string; polarity: string }, []>(
      'SELECT rowid, option_id, tag_id, polarity FROM option_tags',
    ).get()).toEqual({ ...before, polarity: 'require' });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('polarity and hierarchy updates bump prompt-library revisions', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig33-revisions-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
    db.run("INSERT INTO tag_dimensions (id, user_id, name, created_at) VALUES ('d1', 'u1', 'D', 1)");
    db.run("INSERT INTO dimension_tags (id, user_id, dimension_id, label, sort_order) VALUES ('parent', 'u1', 'd1', 'Parent', 0)");
    db.run("INSERT INTO dimension_tags (id, user_id, dimension_id, label, sort_order) VALUES ('child', 'u1', 'd1', 'Child', 1)");
    db.run("INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at) VALUES ('l1', 'u1', 'L', 0, 1, 1)");
    db.run("INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at) VALUES ('o1', 'u1', 'l1', 'O', 0, 1, 1)");
    db.run("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES ('o1', 'child', 'require')");

    const beforePolarity = promptLibraryRevision(db, 'u1');
    db.run("UPDATE option_tags SET polarity = 'exclude' WHERE option_id = 'o1' AND tag_id = 'child'");
    expect(promptLibraryRevision(db, 'u1')).toBe(beforePolarity + 1);

    const beforeParent = promptLibraryRevision(db, 'u1');
    db.run("UPDATE dimension_tags SET parent_id = 'parent' WHERE id = 'child'");
    expect(promptLibraryRevision(db, 'u1')).toBe(beforeParent + 1);
    db.close();
  });
});

describe('migration 35 - manual-only variable options', () => {
  test('relaxes the weight floor while preserving option tags, foreign keys, and revision triggers', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig35-'));
    const db = new Database(':memory:');
    db.run(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_versions (version, applied_at) VALUES (34, 'now');

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE prompt_library_revisions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE variable_lists (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE (user_id, name)
      );
      CREATE TABLE variable_options (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        list_id     TEXT NOT NULL REFERENCES variable_lists(id) ON DELETE CASCADE,
        value       TEXT NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        weight      INTEGER NOT NULL DEFAULT 1 CHECK(weight BETWEEN 1 AND 100)
      );
      CREATE TABLE tag_dimensions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE dimension_tags (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        dimension_id TEXT NOT NULL REFERENCES tag_dimensions(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE option_tags (
        option_id  TEXT NOT NULL REFERENCES variable_options(id) ON DELETE CASCADE,
        tag_id     TEXT NOT NULL REFERENCES dimension_tags(id) ON DELETE CASCADE,
        polarity   TEXT NOT NULL DEFAULT 'require' CHECK (polarity IN ('require', 'exclude')),
        PRIMARY KEY (option_id, tag_id)
      );

      CREATE TRIGGER variable_options_ad_revision AFTER DELETE ON variable_options BEGIN SELECT 1; END;
      CREATE TRIGGER variable_options_ai_revision AFTER INSERT ON variable_options BEGIN SELECT 1; END;
      CREATE TRIGGER variable_options_au_revision AFTER UPDATE ON variable_options BEGIN SELECT 1; END;
      CREATE TRIGGER option_tags_ad_revision AFTER DELETE ON option_tags BEGIN SELECT 1; END;
      CREATE TRIGGER option_tags_ai_revision AFTER INSERT ON option_tags BEGIN SELECT 1; END;
      CREATE TRIGGER option_tags_au_revision AFTER UPDATE OF polarity ON option_tags BEGIN SELECT 1; END;

      INSERT INTO users (id, created_at) VALUES ('u1', 1);
      INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at)
        VALUES ('l1', 'u1', 'list', 0, 1, 1);
      INSERT INTO tag_dimensions (id, user_id, name, created_at)
        VALUES ('d1', 'u1', 'Genre', 1);
      INSERT INTO dimension_tags (id, user_id, dimension_id, label, sort_order)
        VALUES ('t1', 'u1', 'd1', 'Fantasy', 0);
      INSERT INTO variable_options (id, user_id, list_id, value, sort_order, created_at, weight)
        VALUES ('o1', 'u1', 'l1', 'manual candidate', 0, 1, 1);
      INSERT INTO option_tags (option_id, tag_id, polarity)
        VALUES ('o1', 't1', 'exclude');
    `);

    migrate(db, dataDir);

    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(BINARY_SCHEMA_VERSION);
    expect(() => db.run("UPDATE variable_options SET weight = 0 WHERE id = 'o1'")).not.toThrow();
    expect(db.query<{ weight: number }, []>("SELECT weight FROM variable_options WHERE id = 'o1'").get()?.weight).toBe(0);
    expect(() => db.run("UPDATE variable_options SET weight = 101 WHERE id = 'o1'")).toThrow(/CHECK constraint failed/i);
    expect(() => db.run("UPDATE variable_options SET weight = -1 WHERE id = 'o1'")).toThrow(/CHECK constraint failed/i);

    expect(
      db.query<{ option_id: string; tag_id: string; polarity: string }, []>(
        "SELECT option_id, tag_id, polarity FROM option_tags WHERE option_id = 'o1'",
      ).get(),
    ).toEqual({ option_id: 'o1', tag_id: 't1', polarity: 'exclude' });
    const optionTagParents = db
      .query<{ table: string }, []>("PRAGMA foreign_key_list('option_tags')")
      .all()
      .map((row) => row.table);
    expect(optionTagParents).toContain('variable_options');
    expect(optionTagParents).not.toContain('variable_options_old');
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);

    const triggers = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('variable_options', 'option_tags') ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(triggers).toEqual([
      'option_tags_ad_revision',
      'option_tags_ai_revision',
      'option_tags_au_revision',
      'variable_options_ad_revision',
      'variable_options_ai_revision',
      'variable_options_au_revision',
    ]);
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_variable_options_list', 'idx_variable_options_user', 'idx_option_tags_tag') ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual([
      'idx_option_tags_tag',
      'idx_variable_options_list',
      'idx_variable_options_user',
    ]);
    expect(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    db.close();
  });
});

describe('migration 36 - video sequences', () => {
  test('fresh database creates sequence tables, columns, constraints, and partial uniqueness', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig36-fresh-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);

    const sequenceColumns = new Map(
      db.query<{ name: string; dflt_value: string | null }, []>("PRAGMA table_info('video_sequences')")
        .all()
        .map((row) => [row.name, row]),
    );
    expect(sequenceColumns.get('master_status')?.dflt_value).toBe("'idle'");
    expect(sequenceColumns.get('stitch_revision')?.dflt_value).toBe('0');
    expect(sequenceColumns.has('master_error')).toBe(true);
    expect(sequenceColumns.has('master_updated_at')).toBe(true);

    const batchColumns = db.query<{ name: string }, []>("PRAGMA table_info('batches')").all();
    const uploadColumns = db.query<{ name: string }, []>("PRAGMA table_info('uploads')").all();
    expect(batchColumns.map((row) => row.name)).toContain('sequence_id');
    expect(batchColumns.map((row) => row.name)).toContain('sequence_index');
    expect(uploadColumns.map((row) => row.name)).toContain('source_tile_id');

    const index = db.query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_batches_sequence_index'",
    ).get();
    expect(index?.sql).toContain('UNIQUE INDEX');
    expect(index?.sql).toContain('WHERE sequence_id IS NOT NULL');
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('upgrades a v35 database additively without changing existing rows', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig36-v35-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    db.run(`
      DROP INDEX idx_batches_sequence_index;
      ALTER TABLE batches DROP COLUMN sequence_index;
      ALTER TABLE batches DROP COLUMN sequence_id;
      ALTER TABLE uploads DROP COLUMN source_tile_id;
      DROP TABLE video_sequences;
      DELETE FROM schema_versions WHERE version >= 36;

      INSERT INTO users (id, created_at) VALUES ('u1', 1);
      INSERT INTO batches
        (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
      VALUES
        ('b1', 'u1', 'first', '1:1', 'minimax-h3-t2v', 'MiniMax H3', 1, 'done', 'local', 124),
        ('b2', 'u1', 'second', '1:1', 'minimax-h3-i2v', 'MiniMax H3', 2, 'done', 'local', 243);
      INSERT INTO uploads
        (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at)
      VALUES ('up1', 'u1', 'png', 'image/png', 3, 1, 1, 'sha', 1);
    `);

    expect(db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version)
      .toBe(35);
    migrate(db, dataDir);

    expect(db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version)
      .toBe(BINARY_SCHEMA_VERSION);
    expect(db.query<{ sequence_id: string | null; sequence_index: number | null }, []>(
      "SELECT sequence_id, sequence_index FROM batches WHERE id = 'b1'",
    ).get()).toEqual({ sequence_id: null, sequence_index: null });
    expect(db.query<{ source_tile_id: string | null }, []>(
      "SELECT source_tile_id FROM uploads WHERE id = 'up1'",
    ).get()).toEqual({ source_tile_id: null });

    db.run("INSERT INTO video_sequences (id, user_id, created_at, updated_at) VALUES ('s1', 'u1', 1, 1)");
    db.run("UPDATE batches SET sequence_id = 's1', sequence_index = 0 WHERE id = 'b1'");
    expect(() => {
      db.run("UPDATE batches SET sequence_id = 's1', sequence_index = 0 WHERE id = 'b2'");
    }).toThrow(/UNIQUE constraint failed: batches\.sequence_id, batches\.sequence_index/i);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

describe('migration 38 - text backend key rename', () => {
  function openV37Db(): { dataDir: string; db: InstanceType<typeof Database> } {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig38-'));
    const db = new Database(':memory:');
    migrate(db, dataDir, LEGACY_TEXT_TABLE);
    expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(38);
    // Recreate the exact v37 shape: the legacy CHECK and a pre-rename row.
    db.run('DROP TABLE user_text_backends');
    db.run(`
      CREATE TABLE user_text_backends (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workload   TEXT NOT NULL,
        backend    TEXT NOT NULL CHECK(backend IN ('kimi','flash')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, workload)
      );
    `);
    db.run("DELETE FROM schema_versions WHERE version >= 38");
    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(37);
    return { dataDir, db };
  }

  test('carries a legacy flash row through the DeepSeek renames until migration 55 retires it', () => {
    const { dataDir, db } = openV37Db();
    db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
    db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'condense', 'flash', 1)");
    db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'ai-fill', 'kimi', 2)");

    migrate(db, dataDir, LEGACY_TEXT_TABLE);

    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(LEGACY_TEXT_TABLE.targetVersion);
    expect(db.query<{ workload: string; backend: string }, []>(
      'SELECT workload, backend FROM user_text_backends ORDER BY workload',
    ).all()).toEqual([
      { workload: 'ai-fill', backend: 'kimi' },
    ]);
    // The FK to users survived every rebuild.
    db.run("DELETE FROM users WHERE id = 'u1'");
    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user_text_backends').get()?.count).toBe(0);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('the widened CHECK accepts the current values and rejects flash and garbage', () => {
    const { dataDir, db } = openV37Db();
    db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
    migrate(db, dataDir, LEGACY_TEXT_TABLE);

    for (const backend of ['kimi', 'mimo']) {
      db.query(
        "INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', ?, ?, 1)",
      ).run(backend, backend);
    }
    for (const retired of ['flash', 'deepseek-flash']) {
      expect(() => {
        db.query("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'brainstorm', ?, 1)").run(retired);
      }).toThrow(/CHECK constraint failed/i);
    }
    expect(() => {
      db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'brainstorm', 'unknown', 1)");
    }).toThrow(/CHECK constraint failed/i);
    db.close();
  });

  test('is idempotent when the runner is called twice', () => {
    const { dataDir, db } = openV37Db();
    db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
    db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'condense', 'flash', 1)");

    migrate(db, dataDir, LEGACY_TEXT_TABLE);
    migrate(db, dataDir, LEGACY_TEXT_TABLE);

    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schema_versions WHERE version = 38').get()?.count).toBe(1);
    // Migration 55 retired the DeepSeek pin the rename produced.
    expect(db.query<{ workload: string; backend: string }, []>(
      'SELECT workload, backend FROM user_text_backends',
    ).all()).toEqual([]);
    db.close();
  });
});

describe('migration 39 - Qwen text backend', () => {
  function openV38Db(): { dataDir: string; db: InstanceType<typeof Database> } {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig39-'));
    const db = new Database(':memory:');
    migrate(db, dataDir, LEGACY_TEXT_TABLE);
    db.run('DROP TABLE user_text_backends');
    db.run(`
      CREATE TABLE user_text_backends (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workload   TEXT NOT NULL,
        backend    TEXT NOT NULL CHECK(backend IN ('kimi','deepseek-pro','deepseek-flash')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, workload)
      );
    `);
    db.run('DELETE FROM schema_versions WHERE version >= 39');
    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(38);
    return { dataDir, db };
  }

  test('upgrades v38 through rebuildTable, keeps surviving pins, and ends on the current union', () => {
    const { dataDir, db } = openV38Db();
    db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
    db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'ai-fill', 'kimi', 1)");
    db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'condense', 'deepseek-flash', 2)");

    migrate(db, dataDir, LEGACY_TEXT_TABLE);

    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(LEGACY_TEXT_TABLE.targetVersion);
    expect(db.query<{ workload: string; backend: string }, []>(
      'SELECT workload, backend FROM user_text_backends ORDER BY workload',
    ).all()).toEqual([
      { workload: 'ai-fill', backend: 'kimi' },
    ]);
    expect(() => {
      db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'brainstorm', 'qwen', 3)");
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'brainstorm', 'grok', 3)");
    }).not.toThrow();
    expect(() => {
      db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'enhance', 'unknown', 4)");
    }).toThrow(/CHECK constraint failed/i);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.run("DELETE FROM users WHERE id = 'u1'");
    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user_text_backends').get()?.count).toBe(0);
    db.close();
  });

  test('is idempotent when the runner is called twice', () => {
    const { dataDir, db } = openV38Db();
    migrate(db, dataDir, LEGACY_TEXT_TABLE);
    migrate(db, dataDir, LEGACY_TEXT_TABLE);
    expect(db.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM schema_versions WHERE version = 39',
    ).get()?.count).toBe(1);
    db.close();
  });
});


describe('migration 40 - GLM 5.3 Flash text backend', () => {
  function openV39Db(): { dataDir: string; db: InstanceType<typeof Database> } {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig40-'));
    const db = new Database(':memory:');
    migrate(db, dataDir, LEGACY_TEXT_TABLE);
    db.run('DROP TABLE user_text_backends');
    db.run(`
      CREATE TABLE user_text_backends (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workload   TEXT NOT NULL,
        backend    TEXT NOT NULL CHECK(backend IN ('kimi','deepseek-pro','deepseek-flash','qwen')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, workload)
      );
    `);
    db.run('DELETE FROM schema_versions WHERE version >= 40');
    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(39);
    return { dataDir, db };
  }

  test('upgrades v39 through rebuildTable, keeps surviving pins, and ends on the current union', () => {
    const { dataDir, db } = openV39Db();
    db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
    db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'ai-fill', 'kimi', 1)");
    db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'condense', 'qwen', 2)");

    migrate(db, dataDir, LEGACY_TEXT_TABLE);

    expect(
      db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
    ).toBe(LEGACY_TEXT_TABLE.targetVersion);
    expect(db.query<{ workload: string; backend: string }, []>(
      'SELECT workload, backend FROM user_text_backends ORDER BY workload',
    ).all()).toEqual([
      { workload: 'ai-fill', backend: 'kimi' },
    ]);
    expect(() => {
      db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'brainstorm', 'glm-flash', 3)");
    }).toThrow(/CHECK constraint failed/i);
    expect(() => {
      db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'brainstorm', 'gemini-argon', 3)");
    }).not.toThrow();
    expect(() => {
      db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'enhance', 'glm', 4)");
    }).toThrow(/CHECK constraint failed/i);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.run("DELETE FROM users WHERE id = 'u1'");
    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user_text_backends').get()?.count).toBe(0);
    db.close();
  });

  test('is idempotent when the runner is called twice', () => {
    const { dataDir, db } = openV39Db();
    migrate(db, dataDir, LEGACY_TEXT_TABLE);
    migrate(db, dataDir, LEGACY_TEXT_TABLE);
    expect(db.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM schema_versions WHERE version = 40',
    ).get()?.count).toBe(1);
    db.close();
  });
});


describe('migration 49 - text backend effort', () => {
  test('adds a nullable effort column to v48 pins without touching them, and checks its values', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration49-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      db.run('ALTER TABLE user_text_backends DROP COLUMN effort');
      db.run('DELETE FROM schema_versions WHERE version >= 49');
      db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'enhance', 'kimi', 456)");
      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      expect(db.query('SELECT workload, backend, updated_at, effort FROM user_text_backends').all()).toEqual([
        { workload: 'enhance', backend: 'kimi', updated_at: 456, effort: null },
      ]);
      db.run("UPDATE user_text_backends SET effort = 'high'");
      expect(() => db.run("UPDATE user_text_backends SET effort = 'extreme'")).toThrow(/CHECK constraint failed/i);
      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      expect(db.query('SELECT effort FROM user_text_backends').get()).toEqual({ effort: 'high' });
    } finally {
      db.close();
    }
  });
});

describe('migration 50 - split GLM by host', () => {
  test('moves v49 glm-flash pins to glm-abliterated, keeping only efforts that key offers', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration50-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      db.run('DROP TABLE user_text_backends');
      db.run(readFileSync(new URL('./migrations/0044_drop_deepseek_pro_text_backend.sql', import.meta.url), 'utf8'));
      db.run(readFileSync(new URL('./migrations/0049_text_backend_effort.sql', import.meta.url), 'utf8'));
      db.run('DELETE FROM schema_versions WHERE version >= 50');
      db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'ai-fill', 'glm-flash', 1, 'low')");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'storytelling', 'glm-flash', 2, 'high')");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'enhance', 'glm-flash', 3, 'xhigh')");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'brainstorm', 'kimi', 4, 'high')");
      expect(() => db.run("INSERT INTO user_text_backends VALUES ('u1', 'condense', 'glm-abliterated', 5, NULL)"))
        .toThrow(/CHECK constraint failed/i);

      migrate(db, dataDir, LEGACY_TEXT_TABLE);

      expect(db.query('SELECT workload, backend, updated_at, effort FROM user_text_backends ORDER BY workload').all()).toEqual([
        { workload: 'ai-fill', backend: 'glm-abliterated', updated_at: 1, effort: 'low' },
        { workload: 'brainstorm', backend: 'kimi', updated_at: 4, effort: 'high' },
        { workload: 'enhance', backend: 'glm-abliterated', updated_at: 3, effort: null },
        { workload: 'storytelling', backend: 'glm-abliterated', updated_at: 2, effort: 'high' },
      ]);
      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      expect(db.query('SELECT COUNT(*) AS count FROM schema_versions WHERE version = 50').get()).toEqual({ count: 1 });
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('migration 55 - proxy text backends', () => {
  test('deletes retired pins, nulls Kimi efforts the Kimi upstream does not list, keeps the rest, and narrows the CHECK', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration55-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      db.run('DROP TABLE user_text_backends');
      db.run(readFileSync(new URL('./migrations/0050_glm_abliterated_text_backend.sql', import.meta.url), 'utf8'));
      db.run('DELETE FROM schema_versions WHERE version >= 55');
      db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
      db.run("INSERT INTO users (id, created_at) VALUES ('u2', 1)");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'ai-fill', 'qwen', 1, 'high')");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'brainstorm', 'glm-flash', 2, 'low')");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'condense', 'deepseek-flash', 3, 'none')");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'enhance', 'kimi', 4, 'medium')");
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'storytelling', 'kimi', 5, 'max')");
      db.run("INSERT INTO user_text_backends VALUES ('u2', 'ai-fill', 'kimi', 6, NULL)");
      db.run("INSERT INTO user_text_backends VALUES ('u2', 'enhance', 'glm-abliterated', 7, 'high')");
      db.run("INSERT INTO user_text_backends VALUES ('u2', 'condense', 'gpt', 8, NULL)");

      migrate(db, dataDir, LEGACY_TEXT_TABLE);

      expect(db.query('SELECT user_id, workload, backend, updated_at, effort FROM user_text_backends ORDER BY user_id, workload').all()).toEqual([
        { user_id: 'u1', workload: 'enhance', backend: 'kimi', updated_at: 4, effort: null },
        { user_id: 'u1', workload: 'storytelling', backend: 'kimi', updated_at: 5, effort: 'max' },
        { user_id: 'u2', workload: 'ai-fill', backend: 'kimi', updated_at: 6, effort: null },
        { user_id: 'u2', workload: 'condense', backend: 'gpt', updated_at: 8, effort: null },
        { user_id: 'u2', workload: 'enhance', backend: 'glm-abliterated', updated_at: 7, effort: 'high' },
      ]);
      for (const retired of ['qwen', 'glm-flash', 'deepseek-flash']) {
        expect(() => db.query("INSERT INTO user_text_backends VALUES ('u1', 'ai-fill', ?, 9, NULL)").run(retired))
          .toThrow(/CHECK constraint failed/i);
      }
      for (const [workload, backend] of [['ai-fill', 'mimo'], ['brainstorm', 'grok'], ['condense', 'gemini-argon']] as const) {
        db.query("INSERT INTO user_text_backends VALUES ('u1', ?, ?, 9, NULL)").run(workload, backend);
      }
      db.run("INSERT INTO user_text_backends VALUES ('u2', 'brainstorm', 'deepseek-abliterated', 9, 'xhigh')");

      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      expect(db.query('SELECT COUNT(*) AS count FROM schema_versions WHERE version = 55').get()).toEqual({ count: 1 });
      expect(db.query('SELECT COUNT(*) AS count FROM user_text_backends').get()).toEqual({ count: 9 });
      // The FK to users survived the rebuild.
      db.run("DELETE FROM users WHERE id = 'u2'");
      expect(db.query("SELECT COUNT(*) AS count FROM user_text_backends WHERE user_id = 'u2'").get()).toEqual({ count: 0 });
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('migration 56 - user_model_steps', () => {
  test('applies on top of v55, enforces bounds and cascades with the user', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration56-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir);
      db.run('DROP TABLE user_model_steps');
      db.run('DELETE FROM schema_versions WHERE version >= 56');
      expect(db.query('SELECT MAX(version) AS version FROM schema_versions').get()).toEqual({ version: 55 });

      migrate(db, dataDir);
      expect(db.query('SELECT COUNT(*) AS count FROM schema_versions WHERE version = 56').get()).toEqual({ count: 1 });
      db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
      db.run("INSERT INTO user_model_steps VALUES ('u1', 'krea-2-gonzalomo', 12, 1)");
      for (const bad of [0, 101]) {
        expect(() => db.query("INSERT INTO user_model_steps VALUES ('u1', 'moss-test-row', ?, 1)").run(bad))
          .toThrow(/CHECK constraint failed/i);
      }
      expect(() => db.run("INSERT INTO user_model_steps VALUES ('u1', 'krea-2-gonzalomo', 9, 2)"))
        .toThrow(/UNIQUE constraint failed/i);
      db.run("DELETE FROM users WHERE id = 'u1'");
      expect(db.query('SELECT COUNT(*) AS count FROM user_model_steps').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

describe('migration 44 - retire Pro text backend', () => {
  test('maps v43 Pro overrides to Flash, which migration 55 then retires, and rejects the retired key', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration44-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      db.run('DROP TABLE user_text_backends');
      db.run(readFileSync(new URL('./migrations/0043_gpt_text_backend.sql', import.meta.url), 'utf8'));
      db.run('DELETE FROM schema_versions WHERE version >= 44');
      db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
      db.run(`INSERT INTO user_text_backends VALUES ('u1', 'condense', 'deepseek-pro', 123)`);
      db.run("INSERT INTO user_text_backends VALUES ('u1', 'enhance', 'gpt', 456)");
      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      expect(db.query('SELECT workload, backend, updated_at FROM user_text_backends ORDER BY workload').all()).toEqual([
        { workload: 'enhance', backend: 'gpt', updated_at: 456 },
      ]);
      expect(() => db.run(`INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('u1', 'brainstorm', 'deepseek-pro', 789)`)).toThrow(/CHECK constraint failed/i);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      migrate(db, dataDir, LEGACY_TEXT_TABLE);
      expect(db.query('SELECT COUNT(*) AS count FROM user_text_backends').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});

describe('migration 45 - storage encryption keys', () => {
  test('adds storage_root and user_storage_keys, cascades user deletion, and is idempotent', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration45-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir);
      db.run('DROP TABLE user_storage_keys');
      db.run('DROP TABLE storage_root');
      db.run('DELETE FROM schema_versions WHERE version >= 45');
      migrate(db, dataDir);
      db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
      db.run("INSERT INTO storage_root (id, recipient, created_at) VALUES (1, 'age1root', 1)");
      expect(() => { db.run("INSERT INTO storage_root (id, recipient, created_at) VALUES (2, 'age1other', 1)"); }).toThrow(/CHECK constraint failed/i);
      db.run("INSERT INTO user_storage_keys (user_id, recipient, wrapped_identity, created_at) VALUES ('u1', 'age1pq1x', x'00', 1)");
      expect(() => { db.run("INSERT INTO user_storage_keys (user_id, recipient, wrapped_identity, created_at) VALUES ('ghost', 'age1pq1y', x'00', 1)"); }).toThrow(/FOREIGN KEY constraint failed/i);
      db.run("DELETE FROM users WHERE id = 'u1'");
      expect(db.query('SELECT COUNT(*) AS count FROM user_storage_keys').get()).toEqual({ count: 0 });
      db.run('DELETE FROM schema_versions WHERE version >= 45');
      expect(() => { migrate(db, dataDir); }).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('migration 46 - drop batch preferred host', () => {
  test('drops preferred_host from a populated v45 database without row or rowid drift', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration46-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir);
      db.run("ALTER TABLE batches ADD COLUMN preferred_host TEXT CHECK (preferred_host IN ('direct', 'pod'))");
      db.run('DELETE FROM schema_versions WHERE version >= 46');
      db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
      db.run(
        `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, preferred_host)
         VALUES ('b1', 'u1', 'p1', '1:1', 'krea-2-gonzalomo', 'Krea 2 GonzaLomo', 1, 'queued', 'local', 'pod'),
                ('b2', 'u1', 'p2', '1:1', 'krea-2-gonzalomo', 'Krea 2 GonzaLomo', 2, 'done', 'local', 'direct'),
                ('b3', 'u1', 'p3', '1:1', 'gpt-image-2.5-sunburst', 'GPT', 3, 'done', 'shared', NULL)`,
      );
      const before = db.query('SELECT rowid, id, prompt, status, pool FROM batches ORDER BY id').all();

      migrate(db, dataDir);

      const columns = db.query<{ name: string }, []>("PRAGMA table_info('batches')").all().map((col) => col.name);
      expect(columns).not.toContain('preferred_host');
      expect(db.query('SELECT rowid, id, prompt, status, pool FROM batches ORDER BY id').all()).toEqual(before);
      expect(
        db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
      ).toBe(BINARY_SCHEMA_VERSION);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);

      db.run('DELETE FROM schema_versions WHERE version >= 46');
      expect(() => { migrate(db, dataDir); }).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('migration 53 - batch dispatch time', () => {
  test('adds started_at, backfills rows that already left the queue, and is idempotent', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration53-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir);
      db.run('ALTER TABLE batches DROP COLUMN started_at');
      db.run('DELETE FROM schema_versions WHERE version >= 53');
      db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
      db.run(
        `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
         VALUES ('queued', 'u1', 'p', '1:1', 'mock-slow', 'Mock Slow', 10, 'queued', 'shared'),
                ('running', 'u1', 'p', '1:1', 'mock-slow', 'Mock Slow', 20, 'running', 'shared'),
                ('done', 'u1', 'p', '1:1', 'mock-slow', 'Mock Slow', 30, 'done', 'shared')`,
      );

      migrate(db, dataDir);

      expect(db.query('SELECT id, started_at FROM batches ORDER BY created_at').all()).toEqual([
        { id: 'queued', started_at: null },
        { id: 'running', started_at: 20 },
        { id: 'done', started_at: 30 },
      ]);
      db.run('DELETE FROM schema_versions WHERE version >= 53');
      expect(() => { migrate(db, dataDir); }).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('migration 54 - batch idempotency key', () => {
  test('migration 54 adds batches.idempotency_key under a per-user partial unique index', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration54-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir);
      expect(BINARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(54);

      const index = db
        .query<{ name: string; unique: number; partial: number }, []>("PRAGMA index_list('batches')")
        .all()
        .find((row) => row.name === 'idx_batches_idempotency_key');
      expect(index).toMatchObject({ unique: 1, partial: 1 });

      db.query('INSERT INTO users (id, created_at) VALUES (?, ?), (?, ?)').run('u1', 1, 'u2', 1);
      const insert = db.query<unknown, [string, string, string | null]>(
        `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, idempotency_key)
         VALUES (?, ?, 'p', '1:1', 'mock-slow', 'Mock Slow', 1, 'queued', 'shared', ?)`,
      );
      insert.run('b1', 'u1', 'k1');
      expect(() => insert.run('b2', 'u1', 'k1')).toThrow(
        expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' }),
      );
      // Same key under another user, and any number of NULL keys, insert.
      insert.run('b3', 'u2', 'k1');
      insert.run('b4', 'u1', null);
      insert.run('b5', 'u1', null);
      expect(db.query('SELECT COUNT(*) AS n FROM batches').get()).toEqual({ n: 4 });
    } finally {
      db.close();
    }
  });

  test('repairs a partial migration whose column exists but index does not', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-migration54-replay-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir);
      for (let run = 0; run < 2; run += 1) {
        db.run('DROP INDEX idx_batches_idempotency_key');
        db.run('DELETE FROM schema_versions WHERE version >= 54');

        migrate(db, dataDir);

        expect(
          db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_batches_idempotency_key'").get(),
        ).toBeTruthy();
        expect(
          db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version,
        ).toBe(BINARY_SCHEMA_VERSION);
      }
    } finally {
      db.close();
    }
  });
});
