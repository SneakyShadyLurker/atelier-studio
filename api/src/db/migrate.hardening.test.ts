import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MigrationError, rebuildTable, runEach } from './migrate';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const MIGRATION_STATEMENT_COUNTS: Readonly<Record<string, number>> = {
  '0005_uploads.sql': 5,
  '0006_collections.sql': 6,
  '0007_byok.sql': 1,
  '0008_tile_indexes.sql': 2,
  '0009_archive_index.sql': 1,
  '0010_query_perf_indexes.sql': 6,
  '0011_prompt_library.sql': 11,
  '0012_drop_dead_tile_index.sql': 1,
  '0013_collection_history_index.sql': 2,
  '0014_drop_redundant_archive_index.sql': 1,
  '0017_keystore_proof.sql': 1,
  '0018_collections_join_index.sql': 1,
  '0019_tiles_error_check.sql': 8,
  '0020_variable_option_weight.sql': 1,
  '0021_variable_options_user_index.sql': 1,
  '0025_prompt_library_revision.sql': 20,
  '0028_batches_i2v_source.sql': 1,
  '0029_batches_motion_prompt.sql': 1,
  '0030_users_cache_scope.sql': 2,
  '0031_batches_card_notes.sql': 1,
  '0032_batches_preferred_host.sql': 1,
  '0033_tag_system_v2.sql': 4,
  '0034_batches_duration_frames.sql': 1,
  '0035_variable_option_weight_zero.sql': 9,
  '0036_video_sequences.sql': 5,
  '0037_user_text_backends.sql': 1,
  '0038_text_backend_keys.sql': 1,
  '0039_qwen_text_backend.sql': 1,
  '0040_glm_flash_text_backend.sql': 1,
  '0041_batches_context_frames.sql': 1,
  '0042_stories.sql': 4,
  '0043_gpt_text_backend.sql': 1,
  '0044_drop_deepseek_pro_text_backend.sql': 1,
  '0045_storage_encryption_keys.sql': 2,
  '0046_drop_batches_preferred_host.sql': 1,
  '0047_tile_moderation_reason.sql': 1,
  '0048_tile_moderation_categories.sql': 1,
  '0049_text_backend_effort.sql': 1,
  '0050_glm_abliterated_text_backend.sql': 1,
  '0051_sequence_master_revision.sql': 2,
  '0052_batches_i2v_source_index.sql': 1,
  '0053_batches_started_at.sql': 2,
  '0054_batches_idempotency_key.sql': 2,
  '0055_proxy_text_backends.sql': 1,
  '0056_user_model_steps.sql': 1,
};

const CORPUS_BOOTSTRAP_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE batches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    ratio TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('queued','running','done')),
    pool TEXT NOT NULL DEFAULT 'shared' CHECK (pool IN ('shared','xai','byok','local'))
  );
  CREATE INDEX idx_batches_user_created ON batches(user_id, created_at DESC, id DESC);
  CREATE INDEX idx_batches_user_archived ON batches(user_id, archived_at);
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
  CREATE INDEX idx_tiles_batch_index ON tiles(batch_id, tile_index ASC);
  CREATE INDEX idx_tiles_user_status ON tiles(user_id, status);
  CREATE INDEX idx_tiles_user_archived ON tiles(user_id, archived_at);
`;

interface MasterRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

function sqliteMasterDump(db: Database): string {
  const rows = db.query<MasterRow, []>(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name
  `).all();
  return JSON.stringify(rows);
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function recordingRunner(db: Database, statements: string[]): { run(sql: string): void } {
  return {
    run(sql): void {
      statements.push(sql);
      db.run(sql);
    },
  };
}

describe('runEach', () => {
  test('keeps trigger bodies, quoted semicolons, bare END identifiers, CASE expressions, and line comments intact', () => {
    const db = new Database(':memory:');
    try {
      runEach(db, `
        -- A comment semicolon must not terminate anything ;
        CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT NOT NULL, END TEXT NOT NULL);
        CREATE TABLE audit (message TEXT NOT NULL);
        CREATE TRIGGER source_ai AFTER INSERT ON source
        BEGIN
          INSERT INTO audit (message) VALUES ('literal;semicolon');
          INSERT INTO audit (message)
          SELECT CASE WHEN new.value = 'x;y' THEN 'case;yes' ELSE 'case;no' END;
          INSERT INTO audit (message) VALUES (new.END);
        END;
        INSERT INTO source (id, value, END) VALUES (1, 'x;y', 'bare;end');
      `);

      expect(db.query<{ message: string }, []>('SELECT message FROM audit ORDER BY rowid').all())
        .toEqual([
          { message: 'literal;semicolon' },
          { message: 'case;yes' },
          { message: 'bare;end' },
        ]);
    } finally {
      db.close();
    }
  });

  test('propagates the first runtime failure and does not execute later statements', () => {
    const db = new Database(':memory:');
    try {
      expect(() => { runEach(db, `
        CREATE TABLE sentinel (id INTEGER PRIMARY KEY);
        INSERT INTO sentinel (id) VALUES (1);
        INSERT INTO sentinel (id) VALUES (1);
        CREATE TABLE sentinel (id INTEGER);
      `); }).toThrow(/UNIQUE constraint failed: sentinel\.id/);
      expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM sentinel').get()?.count)
        .toBe(1);
    } finally {
      db.close();
    }
  });

  test('matches single-run sqlite_master bytes after every real SQL migration file', () => {
    const filenames = readdirSync(MIGRATIONS_DIR)
      .filter((filename) => filename.endsWith('.sql'))
      .sort();
    expect(filenames.length).toBeGreaterThan(0);
    expect(Object.keys(MIGRATION_STATEMENT_COUNTS).sort()).toEqual(filenames);

    const direct = new Database(':memory:');
    const split = new Database(':memory:');
    try {
      direct.run('PRAGMA foreign_keys = OFF');
      split.run('PRAGMA foreign_keys = OFF');
      direct.run(CORPUS_BOOTSTRAP_SQL);
      split.run(CORPUS_BOOTSTRAP_SQL);

      for (const filename of filenames) {
        // Migration 33's real runner conditionally replaces this existing
        // trigger. Remove it in both corpus databases so the complete file can
        // be applied byte-for-byte by both execution strategies.
        if (filename === '0033_tag_system_v2.sql') {
          direct.run('DROP TRIGGER IF EXISTS option_tags_au_revision');
          split.run('DROP TRIGGER IF EXISTS option_tags_au_revision');
        }
        // Migrations 38, 39, 40, 43, 44, 50 and 55 recreate the table 0037 created (the real
        // runners rebuild it through rebuildTable). Drop it in both corpus
        // databases so each file applies byte-for-byte here too.
        if (
          filename === '0038_text_backend_keys.sql'
          || filename === '0039_qwen_text_backend.sql'
          || filename === '0040_glm_flash_text_backend.sql'
          || filename === '0043_gpt_text_backend.sql'
          || filename === '0044_drop_deepseek_pro_text_backend.sql'
          || filename === '0050_glm_abliterated_text_backend.sql'
          || filename === '0055_proxy_text_backends.sql'
        ) {
          direct.run('DROP TABLE IF EXISTS user_text_backends');
          split.run('DROP TABLE IF EXISTS user_text_backends');
        }
        const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
        const expectedStatementCount = MIGRATION_STATEMENT_COUNTS[filename];
        if (expectedStatementCount === undefined) {
          throw new Error(`missing expected statement count for ${filename}`);
        }
        const recordedStatements: string[] = [];
        direct.run(sql);
        runEach(recordingRunner(split, recordedStatements), sql);
        expect(recordedStatements).toHaveLength(expectedStatementCount);
        expect(sqliteMasterDump(split)).toBe(sqliteMasterDump(direct));
      }
    } finally {
      direct.close();
      split.close();
    }
  });
});

describe('rebuildTable', () => {
  test('reconstructs rows, indexes, owned triggers, child FK targets, and child triggers', () => {
    // This proves the locally observable helper contract. No registered
    // migration calls rebuildTable yet; the Linux rehearsal will exercise it
    // only after a future migration adopts the helper.
    const db = new Database(':memory:');
    try {
      db.run('PRAGMA foreign_keys = OFF');
      db.run(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id)
        );
        CREATE TABLE audit (message TEXT NOT NULL);
        CREATE TRIGGER child_ai AFTER INSERT ON child
        BEGIN
          INSERT INTO audit (message) SELECT label FROM parent WHERE id = new.parent_id;
        END;
        INSERT INTO parent (id, label) VALUES (1, 'preserved');
        INSERT INTO child (id, parent_id) VALUES (1, 1);
      `);
      db.run('PRAGMA legacy_alter_table = OFF');

      db.transaction(() => {
        rebuildTable(db, {
          table: 'parent',
          createSql: (name) => `
            CREATE TABLE ${quoted(name)} (
              id INTEGER PRIMARY KEY,
              label TEXT NOT NULL,
              rebuilt INTEGER NOT NULL DEFAULT 1
            )
          `,
          columns: ['id', 'label'],
          indexes: ['CREATE INDEX idx_parent_label ON parent(label)'],
          triggers: [`
            CREATE TRIGGER parent_au AFTER UPDATE OF label ON parent
            BEGIN
              INSERT INTO audit (message) VALUES ('parent;updated');
            END
          `],
        });
      })();

      expect(db.query<{ legacy_alter_table: number }, []>('PRAGMA legacy_alter_table').get())
        .toEqual({ legacy_alter_table: 0 });
      expect(db.query<{ id: number; label: string; rebuilt: number }, []>('SELECT * FROM parent').all())
        .toEqual([{ id: 1, label: 'preserved', rebuilt: 1 }]);
      expect(db.query<{ table: string }, []>('PRAGMA foreign_key_list(child)').get()?.table)
        .toBe('parent');
      expect(db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_parent_label'",
      ).get()?.name).toBe('idx_parent_label');
      expect(db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='parent_au'",
      ).get()?.name).toBe('parent_au');
      expect(db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE sql LIKE '%__atelier_rebuild_%'",
      ).get()?.count).toBe(0);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);

      db.run('PRAGMA foreign_keys = ON');
      db.run("INSERT INTO child (id, parent_id) VALUES (2, 1)");
      db.run("UPDATE parent SET label = 'updated' WHERE id = 1");
      expect(db.query<{ message: string }, []>('SELECT message FROM audit ORDER BY rowid').all())
        .toEqual([
          { message: 'preserved' },
          { message: 'preserved' },
          { message: 'parent;updated' },
        ]);
    } finally {
      db.close();
    }
  });

  test('requires copied columns in both schemas and explicit acknowledgement of dropped columns', () => {
    const db = new Database(':memory:');
    try {
      db.run('PRAGMA foreign_keys = OFF');
      db.run("CREATE TABLE sample (id INTEGER PRIMARY KEY, legacy TEXT NOT NULL); INSERT INTO sample VALUES (1, 'preserved')");

      expect(() => {
        db.transaction(() => {
          rebuildTable(db, {
            table: 'sample',
            createSql: (name) => `CREATE TABLE ${quoted(name)} (id INTEGER PRIMARY KEY, missing TEXT)`,
            columns: ['id', 'missing'],
            dropColumns: ['legacy'],
          });
        })();
      }).toThrow(/copied columns missing from old table: missing/);

      expect(() => {
        db.transaction(() => {
          rebuildTable(db, {
            table: 'sample',
            createSql: (name) => `CREATE TABLE ${quoted(name)} (id INTEGER PRIMARY KEY)`,
            columns: ['id', 'legacy'],
          });
        })();
      }).toThrow(/copied columns missing from scratch table: legacy/);

      expect(() => {
        db.transaction(() => {
          rebuildTable(db, {
            table: 'sample',
            createSql: (name) => `CREATE TABLE ${quoted(name)} (id INTEGER PRIMARY KEY)`,
            columns: ['id'],
          });
        })();
      }).toThrow(/old columns must be copied or explicitly dropped: legacy/);

      db.transaction(() => {
        rebuildTable(db, {
          table: 'sample',
          createSql: (name) => `CREATE TABLE ${quoted(name)} (id INTEGER PRIMARY KEY)`,
          columns: ['id'],
          dropColumns: ['legacy'],
        });
      })();
      expect(db.query<{ id: number }, []>('SELECT id FROM sample').all()).toEqual([{ id: 1 }]);
    } finally {
      db.close();
    }
  });

  test('requires owned schema objects to be recreated or explicitly dropped and rejects misdirection', () => {
    const db = new Database(':memory:');
    try {
      db.run('PRAGMA foreign_keys = OFF');
      db.run(`
        CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE other (id INTEGER);
        CREATE INDEX idx_sample_value ON sample(value);
        CREATE TRIGGER sample_au AFTER UPDATE ON sample
        BEGIN
          INSERT INTO other (id) VALUES (new.id);
        END;
      `);

      const baseSpec = {
        table: 'sample',
        createSql: (name: string) => `
          CREATE TABLE ${quoted(name)} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)
        `,
        columns: ['id', 'value'],
      } as const;
      expect(() => {
        db.transaction(() => {
          rebuildTable(db, baseSpec);
        })();
      }).toThrow(/missing recreated schema objects: index:idx_sample_value, trigger:sample_au/);

      expect(() => {
        db.transaction(() => {
          rebuildTable(db, {
            ...baseSpec,
            indexes: ['CREATE INDEX idx_sample_value ON sample(value)'],
            triggers: [
              `CREATE TRIGGER sample_au AFTER UPDATE ON sample
               BEGIN INSERT INTO other (id) VALUES (new.id); END`,
              `CREATE TRIGGER other_ai AFTER INSERT ON other
               BEGIN SELECT 1; END`,
            ],
          });
        })();
      }).toThrow(/recreated schema objects target another table: trigger:other_ai->other/);

      db.transaction(() => {
        rebuildTable(db, {
          ...baseSpec,
          dropObjects: ['idx_sample_value', 'sample_au'],
        });
      })();
      expect(db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
          FROM sqlite_master
         WHERE name IN ('idx_sample_value', 'sample_au')
      `).get()?.count).toBe(0);
    } finally {
      db.close();
    }
  });

  test('rejects calls outside a transaction or with foreign keys enabled', () => {
    const db = new Database(':memory:');
    const spec = {
      table: 'sample',
      createSql: (name: string) => `CREATE TABLE ${quoted(name)} (id INTEGER PRIMARY KEY)`,
      columns: ['id'],
    } as const;
    try {
      db.run('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
      db.run('PRAGMA foreign_keys = OFF');
      expect(() => { rebuildTable(db, spec); }).toThrow(
        new MigrationError('rebuildTable(sample) precondition violated: transaction is not active'),
      );

      db.run('PRAGMA foreign_keys = ON');
      db.transaction(() => {
        expect(() => { rebuildTable(db, spec); }).toThrow(
          new MigrationError('rebuildTable(sample) precondition violated: PRAGMA foreign_keys must be 0'),
        );
      })();
    } finally {
      db.close();
    }
  });
});
