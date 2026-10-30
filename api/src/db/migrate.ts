import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { TEXT_TASKS } from '@atelier/shared';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_ID_PATTERN } from '../user-id';
import { applyPragmas } from './client';
import { namedArtifactDir, namedArtifactRoot } from '../storage/files';
import type { AppLogger } from '../observability/logger';
import { LEGACY_SEED, type TextSeed } from './textSeed';

export const BINARY_SCHEMA_VERSION = 58;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface RebuildTableSpec {
  readonly table: string;
  readonly createSql: (name: string) => string;
  readonly columns: readonly string[];
  readonly dropColumns?: readonly string[];
  readonly indexes?: readonly string[];
  readonly triggers?: readonly string[];
  readonly dropObjects?: readonly string[];
}

interface SqlStatementRunner {
  run(sql: string): unknown;
}

interface TableInfoRow {
  readonly name: string;
}

interface SchemaObjectSnapshot {
  readonly type: 'index' | 'trigger';
  readonly name: string;
  readonly sql: string;
}

interface SchemaObjectIdentity {
  readonly type: 'index' | 'trigger';
  readonly name: string;
  readonly tbl_name: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function semicolonCompletesStatement(
  trigger: boolean,
  triggerBody: boolean,
  triggerEndReady: boolean,
  caseDepth: number,
): boolean {
  return !trigger || (triggerBody && triggerEndReady && caseDepth === 0);
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let token = '';
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;
  let hasCode = false;
  let headerTokens: string[] = [];
  let headerResolved = false;
  let trigger = false;
  let triggerBody = false;
  let caseDepth = 0;
  let triggerEndReady = false;
  let previousSignificantChar: string | null = null;
  let tokenPrecededByDot = false;

  const resetStatement = (nextStart: number): void => {
    start = nextStart;
    token = '';
    hasCode = false;
    headerTokens = [];
    headerResolved = false;
    trigger = false;
    triggerBody = false;
    caseDepth = 0;
    triggerEndReady = false;
    previousSignificantChar = null;
    tokenPrecededByDot = false;
  };

  const consumeToken = (): void => {
    if (token.length === 0) return;
    const keyword = token.toUpperCase();
    const qualifiedIdentifier = tokenPrecededByDot;
    token = '';
    tokenPrecededByDot = false;

    if (!headerResolved) {
      headerTokens.push(keyword);
      const first = headerTokens[0];
      const second = headerTokens[1];
      const third = headerTokens[2];
      if (first !== 'CREATE') {
        headerResolved = true;
      } else if (second === 'TRIGGER') {
        trigger = true;
        headerResolved = true;
      } else if (second !== undefined && second !== 'TEMP' && second !== 'TEMPORARY') {
        headerResolved = true;
      } else if (third !== undefined) {
        trigger = third === 'TRIGGER';
        headerResolved = true;
      }
    }

    if (!trigger) return;
    if (!triggerBody) {
      if (keyword === 'BEGIN') triggerBody = true;
      return;
    }
    if (keyword === 'CASE' && !qualifiedIdentifier) {
      caseDepth += 1;
      triggerEndReady = false;
    } else if (keyword === 'END' && !qualifiedIdentifier) {
      if (caseDepth > 0) {
        caseDepth -= 1;
        triggerEndReady = false;
      } else {
        triggerEndReady = true;
      }
    } else {
      triggerEndReady = false;
    }
  };

  const finishStatement = (end: number): void => {
    if (hasCode) statements.push(sql.slice(start, end).trim());
    resetStatement(end);
  };

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === undefined) continue;

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (quote === ']' && char === ']') {
        if (next === ']') i += 1;
        else quote = null;
      } else if (char === quote) {
        if (next === quote) i += 1;
        else quote = null;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      consumeToken();
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      consumeToken();
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      consumeToken();
      quote = char === '[' ? ']' : char;
      hasCode = true;
      previousSignificantChar = char;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(char)) {
      if (token.length === 0) tokenPrecededByDot = previousSignificantChar === '.';
      token += char;
      hasCode = true;
      previousSignificantChar = char;
      continue;
    }

    consumeToken();
    if (char === ';') {
      if (semicolonCompletesStatement(trigger, triggerBody, triggerEndReady, caseDepth)) {
        finishStatement(i + 1);
      } else {
        previousSignificantChar = char;
      }
      continue;
    }
    if (!/\s/.test(char)) {
      hasCode = true;
      previousSignificantChar = char;
    }
  }

  consumeToken();
  finishStatement(sql.length);
  return statements;
}

/** Execute SQL one complete statement at a time so the first error stops the batch. */
export function runEach(db: SqlStatementRunner, sql: string): void {
  for (const statement of splitSqlStatements(sql)) db.run(statement);
}

/** Column names of `table`; empty when the table is absent. */
function tableColumns(db: Database, table: string): Set<string> {
  return new Set(db.query<TableInfoRow, [string]>('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name));
}

// Additive-column convention: runs `sql` only when `table` lacks `column`
// (idempotent replay), and no-ops when the table is absent (the reduced
// per-migration test fixtures hand-roll partial schemas).
function addColumnIfMissing(db: Database, table: string, column: string, sql: string): void {
  const columns = tableColumns(db, table);
  if (columns.size > 0 && !columns.has(column)) runEach(db, sql);
}

// SQLite's recipe for a table rebuild that preserves FK-referenced data
// (docs §4.6 "Making Other Kinds Of Table Schema Changes"): PRAGMA
// foreign_keys = OFF → BEGIN → rebuild → COMMIT → PRAGMA foreign_keys = ON.
// PRAGMA foreign_keys is a NO-OP inside an active transaction, so the toggle
// must wrap the transaction. The `finally` re-enables FK when it was on
// before: on success the rebuilt schema is FK-valid; on a throw the inner
// transaction has already rolled the schema back to its consistent
// pre-migration state, so restoring enforcement is safe either way.
function withForeignKeysOff(db: Database, rebuild: () => void): void {
  const fkBefore =
    db
      .query<{ foreign_keys: number }, []>('PRAGMA foreign_keys')
      .get()?.foreign_keys ?? 1;
  db.run('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(rebuild)();
  } finally {
    if (fkBefore !== 0) db.run('PRAGMA foreign_keys = ON');
  }
}

/**
 * Rebuild a table with SQLite's create-copy-drop-rename sequence.
 *
 * The scratch prefix is reserved to this helper, and the UUID candidate is
 * checked against sqlite_master while the caller's schema transaction is
 * active. That combination prevents a real table from colliding with it and
 * gives the deployment rehearsal one stable artefact marker to reject.
 */
export function rebuildTable(db: Database, spec: RebuildTableSpec): void {
  if (!db.inTransaction) {
    throw new MigrationError(`rebuildTable(${spec.table}) precondition violated: transaction is not active`);
  }
  const foreignKeys = db
    .query<{ foreign_keys: number }, []>('PRAGMA foreign_keys')
    .get()?.foreign_keys;
  if (foreignKeys !== 0) {
    throw new MigrationError(
      `rebuildTable(${spec.table}) precondition violated: PRAGMA foreign_keys must be 0`,
    );
  }
  if (spec.columns.length === 0) {
    throw new MigrationError(`rebuildTable(${spec.table}) requires at least one copied column`);
  }

  const oldColumns = new Set(
    db.query<TableInfoRow, [string]>(
      'SELECT name FROM pragma_table_info(?)',
    ).all(spec.table).map((column) => column.name),
  );
  const copiedColumns = new Set(spec.columns);
  const droppedColumns = new Set(spec.dropColumns ?? []);
  const missingFromOld = spec.columns.filter((column) => !oldColumns.has(column));
  const unknownDroppedColumns = [...droppedColumns].filter((column) => !oldColumns.has(column));
  const unaccountedOldColumns = [...oldColumns].filter(
    (column) => !copiedColumns.has(column) && !droppedColumns.has(column),
  );
  if (missingFromOld.length > 0) {
    throw new MigrationError(
      `rebuildTable(${spec.table}) copied columns missing from old table: ${missingFromOld.join(', ')}`,
    );
  }
  if (unknownDroppedColumns.length > 0) {
    throw new MigrationError(
      `rebuildTable(${spec.table}) dropColumns missing from old table: ${unknownDroppedColumns.join(', ')}`,
    );
  }
  if (unaccountedOldColumns.length > 0) {
    throw new MigrationError(
      `rebuildTable(${spec.table}) old columns must be copied or explicitly dropped: ` +
        unaccountedOldColumns.join(', '),
    );
  }

  const oldObjects = db.query<SchemaObjectSnapshot, [string]>(`
    SELECT type, name, sql
      FROM sqlite_master
     WHERE tbl_name = ?
       AND type IN ('index', 'trigger')
       AND sql IS NOT NULL
     ORDER BY type, name
  `).all(spec.table);
  const droppedObjects = new Set(spec.dropObjects ?? []);

  let scratchName: string;
  do {
    scratchName = `__atelier_rebuild_${randomUUID().replaceAll('-', '_')}`;
  } while (
    db.query<{ name: string }, [string]>(
      'SELECT name FROM sqlite_master WHERE name = ?',
    ).get(scratchName) !== null
  );

  const table = quoteIdentifier(spec.table);
  const scratch = quoteIdentifier(scratchName);
  const columns = spec.columns.map(quoteIdentifier).join(', ');

  db.run(spec.createSql(scratchName));
  const scratchColumns = new Set(
    db.query<TableInfoRow, [string]>(
      'SELECT name FROM pragma_table_info(?)',
    ).all(scratchName).map((column) => column.name),
  );
  const missingFromScratch = spec.columns.filter((column) => !scratchColumns.has(column));
  if (missingFromScratch.length > 0) {
    throw new MigrationError(
      `rebuildTable(${spec.table}) copied columns missing from scratch table: ` +
        missingFromScratch.join(', '),
    );
  }
  db.run(`INSERT INTO ${scratch} (${columns}) SELECT ${columns} FROM ${table}`);
  db.run(`DROP TABLE ${table}`);

  const legacyAlterTable = db
    .query<{ legacy_alter_table: number }, []>('PRAGMA legacy_alter_table')
    .get()?.legacy_alter_table;
  if (legacyAlterTable !== 0 && legacyAlterTable !== 1) {
    throw new MigrationError(
      `rebuildTable(${spec.table}) could not read PRAGMA legacy_alter_table`,
    );
  }
  db.run('PRAGMA legacy_alter_table = ON');
  try {
    db.run(`ALTER TABLE ${scratch} RENAME TO ${table}`);
  } finally {
    db.run(`PRAGMA legacy_alter_table = ${legacyAlterTable === 0 ? 'OFF' : 'ON'}`);
  }

  const objectsBeforeRecreation = new Set(
    db.query<SchemaObjectIdentity, []>(`
      SELECT type, name, tbl_name
        FROM sqlite_master
       WHERE type IN ('index', 'trigger')
         AND sql IS NOT NULL
    `).all().map((object) => `${object.type}:${object.name}`),
  );
  for (const indexSql of spec.indexes ?? []) runEach(db, indexSql);
  for (const triggerSql of spec.triggers ?? []) runEach(db, triggerSql);

  const objectsAfterRecreation = db.query<SchemaObjectIdentity, []>(`
    SELECT type, name, tbl_name
      FROM sqlite_master
     WHERE type IN ('index', 'trigger')
       AND sql IS NOT NULL
  `).all();
  const recreatedByKey = new Map<string, SchemaObjectIdentity>(
    objectsAfterRecreation.map(
      (object): [string, SchemaObjectIdentity] => [`${object.type}:${object.name}`, object],
    ),
  );
  const missingObjects = oldObjects.filter((object) => {
    if (droppedObjects.has(object.name)) return false;
    const recreated = recreatedByKey.get(`${object.type}:${object.name}`);
    return recreated?.tbl_name !== spec.table;
  });
  if (missingObjects.length > 0) {
    throw new MigrationError(
      `rebuildTable(${spec.table}) missing recreated schema objects: ` +
        missingObjects.map((object) => `${object.type}:${object.name}`).join(', '),
    );
  }

  const misdirectedObjects = objectsAfterRecreation.filter((object) =>
    !objectsBeforeRecreation.has(`${object.type}:${object.name}`) &&
    object.tbl_name !== spec.table,
  );
  if (misdirectedObjects.length > 0) {
    throw new MigrationError(
      `rebuildTable(${spec.table}) recreated schema objects target another table: ` +
        misdirectedObjects
          .map((object) => `${object.type}:${object.name}->${object.tbl_name}`)
          .join(', '),
    );
  }

  const violations = db
    .query<{ table: string; rowid: number | null; parent: string; fkid: number }, []>(
      'PRAGMA foreign_key_check',
    )
    .all();
  if (violations.length > 0) {
    throw new MigrationError(
      `rebuildTable(${spec.table}) foreign_key_check failed (${violations.length}): ` +
        JSON.stringify(violations.slice(0, 5)),
    );
  }
}

const migration1 = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  ratio TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batches_user_created
  ON batches(user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS tiles (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tile_index INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('loading', 'done', 'failed')),
  ext TEXT,
  mime TEXT,
  error TEXT,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tiles_batch_index
  ON tiles(batch_id, tile_index ASC);

CREATE INDEX IF NOT EXISTS idx_tiles_user_status
  ON tiles(user_id, status);
`;

const migration2 = `
ALTER TABLE batches ADD COLUMN archived_at INTEGER;
ALTER TABLE tiles ADD COLUMN archived_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_batches_user_archived ON batches(user_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_tiles_user_archived ON tiles(user_id, archived_at);
`;

// Failed/loading tiles must never appear in the archive — they're hard-deleted
// on user-initiated removal. This purges any phantom rows from a prior schema
// where they were soft-archived, plus batches whose only tiles were failed.
// On a DB that only ever went through normal write paths this is a strict
// no-op; emit a structured stderr line (matching migration v4's precedent)
// ONLY when it actually destroyed rows, so an unexpected purge is greppable
// rather than a silent, unobservable, irreversible delete.
function migration3CleanupPhantomArchived(db: Database, ctx: MigrationContext): void {
  const result = db.transaction(() => {
    const tiles = db.run(
      "DELETE FROM tiles WHERE archived_at IS NOT NULL AND status IN ('failed', 'loading')",
    );
    const batches = db.run(
      `DELETE FROM batches
       WHERE archived_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tiles WHERE tiles.batch_id = batches.id)`,
    );
    return { tiles: tiles.changes, batches: batches.changes };
  })();
  if (result.tiles > 0 || result.batches > 0) {
    // Destructive purge — warn level + stable event key so it's greppable.
    ctx.log?.warn(
      { event: 'migration_purge_phantom_archived', version: 3, tiles: result.tiles, batches: result.batches },
      `migration v3: purged ${result.tiles} phantom archived tile(s) (failed/loading) + ${result.batches} now-orphaned archived batch(es)`,
    );
  }
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const loadMigration = (name: string): string => readFileSync(join(MIGRATIONS_DIR, name), 'utf8');

const migration5 = loadMigration('0005_uploads.sql');

const migration6 = loadMigration('0006_collections.sql');

const migration7 = loadMigration('0007_byok.sql');

const migration8 = loadMigration('0008_tile_indexes.sql');


const migration9 = loadMigration('0009_archive_index.sql');

const migration10 = loadMigration('0010_query_perf_indexes.sql');

const migration11 = loadMigration('0011_prompt_library.sql');

const migration12 = loadMigration('0012_drop_dead_tile_index.sql');

const migration13 = loadMigration('0013_collection_history_index.sql');

const migration14 = loadMigration('0014_drop_redundant_archive_index.sql');

const migration15 = `
ALTER TABLE batches ADD COLUMN status TEXT NOT NULL DEFAULT 'running'
  CHECK (status IN ('queued','running','done'));

ALTER TABLE batches ADD COLUMN pool TEXT NOT NULL DEFAULT 'shared'
  CHECK (pool IN ('shared','xai','byok','local'));

UPDATE batches SET status = CASE
  WHEN NOT EXISTS (SELECT 1 FROM tiles WHERE batch_id = batches.id AND status='loading')
    THEN 'done'
  ELSE 'running'
END;

UPDATE batches SET pool = CASE
  WHEN model_id = 'gpt-image-2' THEN 'shared'
  WHEN model_id = 'grok-imagine-image-quality' THEN 'xai'
  WHEN model_id IN ('gemini-3-pro-image-preview','gemini-3.1-flash-image-preview') THEN 'byok'
  WHEN model_id = 'zib-distilled' THEN 'local'
  ELSE 'shared'
END;

CREATE INDEX idx_batches_queue ON batches(pool, created_at, id) WHERE status='queued';
CREATE INDEX idx_batches_user_queued ON batches(user_id) WHERE status='queued';
`;

const migration16 = `
UPDATE batches
   SET pool = 'local'
 WHERE model_id = 'zib-distilled'
   AND pool = 'shared';
`;

const migration17 = loadMigration('0017_keystore_proof.sql');

const migration18 = loadMigration('0018_collections_join_index.sql');

const migration19Sql = loadMigration('0019_tiles_error_check.sql');

const migration20 = loadMigration('0020_variable_option_weight.sql');

const migration21 = loadMigration('0021_variable_options_user_index.sql');

const migration25Sql = loadMigration('0025_prompt_library_revision.sql');

// Migration files are sparse-numbered AND filename == migration version again:
// versions 22-24, 26-27 are fileless inline/fn migrations, so the next two .sql
// files are 0028/0029 (NOT 0026/0027 — renamed 2026-06-27 to kill the off-by-2
// skew). The binary version counter remains the source of truth.
const migration28Sql = loadMigration('0028_batches_i2v_source.sql');
const migration29Sql = loadMigration('0029_batches_motion_prompt.sql');
const migration30Sql = loadMigration('0030_users_cache_scope.sql');
const migration31Sql = loadMigration('0031_batches_card_notes.sql');
const migration32Sql = loadMigration('0032_batches_preferred_host.sql');
const migration33Sql = loadMigration('0033_tag_system_v2.sql');
const migration34Sql = loadMigration('0034_batches_duration_frames.sql');
const migration35Sql = loadMigration('0035_variable_option_weight_zero.sql');
const migration36Sql = loadMigration('0036_video_sequences.sql');
const migration37Sql = loadMigration('0037_user_text_backends.sql');
const migration38Sql = loadMigration('0038_text_backend_keys.sql');
const migration39Sql = loadMigration('0039_qwen_text_backend.sql');
const migration40Sql = loadMigration('0040_glm_flash_text_backend.sql');
const migration41Sql = loadMigration('0041_batches_context_frames.sql');
const migration42Sql = loadMigration('0042_stories.sql');
const migration43Sql = loadMigration('0043_gpt_text_backend.sql');
const migration44Sql = loadMigration('0044_drop_deepseek_pro_text_backend.sql');
const migration45Sql = loadMigration('0045_storage_encryption_keys.sql');
const migration46Sql = loadMigration('0046_drop_batches_preferred_host.sql');
const migration47Sql = loadMigration('0047_tile_moderation_reason.sql');
const migration48Sql = loadMigration('0048_tile_moderation_categories.sql');
const migration49Sql = loadMigration('0049_text_backend_effort.sql');
const migration50Sql = loadMigration('0050_glm_abliterated_text_backend.sql');
const migration51Sql = loadMigration('0051_sequence_master_revision.sql');
const migration52Sql = loadMigration('0052_batches_i2v_source_index.sql');
const migration53Sql = loadMigration('0053_batches_started_at.sql');
const migration54Sql = loadMigration('0054_batches_idempotency_key.sql');
const migration55Sql = loadMigration('0055_proxy_text_backends.sql');
// Per-user base-sampler step overrides for local models (2026-10-25). Only
// overrides are stored; an absent row means the model's `defaultSteps`.
const migration56Sql = loadMigration('0056_user_model_steps.sql');
const migration57Sql = loadMigration('0057_stories_source_upload_index.sql');
const migration58Sql = loadMigration('0058_text_providers.sql');

// Wraps migration 19 with a conditional `tile_ref_images` rebuild and the
// SQLite-recommended foreign-key dance for ALTER-table-style rebuilds.
//
// **Critical landmine**: with `foreign_keys=ON`
// (set by applyPragmas), the SQL inside `0019_tiles_error_check.sql` ran
// `DROP TABLE tiles_old`, which fires `ON DELETE CASCADE` on every
// `tile_ref_images.tile_id` row (still referencing `tiles_old` after the
// rename). All ref-image provenance silently vanished BEFORE the
// conditional `tile_ref_images` rebuild below could re-point the FK at the
// new `tiles` table. Reproduced empirically on an in-memory bun:sqlite.
//
// Per SQLite docs §4.6 ("Making Other Kinds Of Table Schema Changes"), the
// canonical recipe for a table rebuild that preserves FK-referenced data
// is: PRAGMA foreign_keys = OFF → BEGIN → rebuild → PRAGMA
// foreign_key_check → COMMIT → PRAGMA foreign_keys = ON (withForeignKeysOff).
function migration19Run(db: Database, _ctx: MigrationContext): void {
  withForeignKeysOff(db, () => {
    // Historical rename-first migration: intentionally not retrofitted.
    // New rebuilds must use rebuildTable's create-copy-drop-legacy-rename pattern.
    runEach(db, migration19Sql);
    const present =
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='tile_ref_images'",
        )
        .get()?.n ?? 0;
    if (present > 0) {
      db.run(`
          ALTER TABLE tile_ref_images RENAME TO tile_ref_images_old;

          CREATE TABLE tile_ref_images (
            tile_id    TEXT NOT NULL REFERENCES tiles(id)   ON DELETE CASCADE,
            upload_id  TEXT NOT NULL REFERENCES uploads(id) ON DELETE RESTRICT,
            position   INTEGER NOT NULL,
            PRIMARY KEY (tile_id, position)
          );

          INSERT INTO tile_ref_images (tile_id, upload_id, position)
          SELECT tile_id, upload_id, position FROM tile_ref_images_old;

          DROP TABLE tile_ref_images_old;

          CREATE INDEX idx_tile_ref_images_upload
            ON tile_ref_images(upload_id);
        `);
    }
    // Inside-transaction safety net: catch any FK violation the rebuild
    // accidentally introduced before commit. Per SQLite docs this is the
    // last fence — the recipe explicitly recommends running it before
    // committing the transaction that altered the schema.
    const violations = db
      .query<{ table: string; rowid: number; parent: string; fkid: number }, []>(
        'PRAGMA foreign_key_check',
      )
      .all();
    if (violations.length > 0) {
      throw new MigrationError(
        `migration 19 foreign_key_check failed (${violations.length}): ` +
          JSON.stringify(violations.slice(0, 5)),
      );
    }
  });
}

const migration22Sql = `
ALTER TABLE tiles RENAME TO tiles_old;

CREATE TABLE tiles (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tile_index INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('loading', 'done', 'failed')),
  ext TEXT,
  mime TEXT,
  error TEXT CHECK (
    error IS NULL OR error IN (
      'timed out',
      'upstream rejected',
      'content-policy violation',
      'interrupted',
      'unsupported format',
      'client disconnected',
      'connection lost',
      'internal error',
      'service unavailable'
    )
  ),
  completed_at INTEGER,
  archived_at INTEGER
);

INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at)
SELECT id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at
  FROM tiles_old;

DROP TABLE tiles_old;

CREATE INDEX idx_tiles_batch_index
  ON tiles(batch_id, tile_index ASC);

CREATE INDEX idx_tiles_batch_status_done
  ON tiles(batch_id, tile_index ASC)
  WHERE status = 'done';

CREATE INDEX idx_tiles_user_archived_seek
  ON tiles(user_id, archived_at DESC, batch_id DESC, tile_index ASC)
  WHERE status = 'done' AND archived_at IS NOT NULL;

CREATE INDEX idx_tiles_user_batch
  ON tiles(user_id, batch_id, tile_index ASC);
`;

// Extends migration 19's FK-toggle recipe to add 'service unavailable' to the
// tiles.error CHECK constraint. Mirrors migration19Run structure byte-for-byte:
// PRAGMA foreign_keys = OFF outside the transaction, rebuild inside, PRAGMA
// foreign_key_check before commit, finally re-enable if it was ON before.
//
// The early-exit guard (tiles table absent) exists only for test scaffolds
// that seed schema_versions directly and skip migration 1 — on those DBs the
// tiles table was never created, so the rebuild is a no-op. On fresh installs
// migration 1 creates tiles and this rebuild runs normally.
function migration22Run(db: Database, ctx: MigrationContext): void {
  const tilesPresent =
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='tiles'",
      )
      .get()?.n ?? 0;
  if (tilesPresent === 0) return;

  const tileRows =
    db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tiles')
      .get()?.n ?? 0;
  const startedAt = performance.now();
  ctx.log?.info({ event: 'migration_rebuild_start', version: 22, tileRows }, `migration v22 start: rebuilding ${tileRows} tile rows`);

  withForeignKeysOff(db, () => {
    // Historical rename-first migration: intentionally not retrofitted.
    // New rebuilds must use rebuildTable's create-copy-drop-legacy-rename pattern.
    db.run(migration22Sql);
    // Repair tile_ref_images after the tiles rebuild. On some SQLite builds
    // (notably the Bun version baked into the production image, which differs
    // from dev machines) `ALTER TABLE tiles RENAME TO tiles_old` rewrites the
    // child FK in tile_ref_images to reference `tiles_old`; dropping
    // `tiles_old` then leaves a dangling reference that `foreign_key_check`
    // rejects. Rebuilding tile_ref_images recreates its FK against the new
    // `tiles` table. Mirrors migration19Run's child rebuild (proven in prod);
    // a harmless identity rebuild on SQLite builds that do not rewrite the
    // reference. Dev-only tests missed this because dev SQLite leaves the
    // reference pointing at `tiles`.
    const refPresent =
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='tile_ref_images'",
        )
        .get()?.n ?? 0;
    if (refPresent > 0) {
      db.run(`
          ALTER TABLE tile_ref_images RENAME TO tile_ref_images_old;

          CREATE TABLE tile_ref_images (
            tile_id    TEXT NOT NULL REFERENCES tiles(id)   ON DELETE CASCADE,
            upload_id  TEXT NOT NULL REFERENCES uploads(id) ON DELETE RESTRICT,
            position   INTEGER NOT NULL,
            PRIMARY KEY (tile_id, position)
          );

          INSERT INTO tile_ref_images (tile_id, upload_id, position)
          SELECT tile_id, upload_id, position FROM tile_ref_images_old;

          DROP TABLE tile_ref_images_old;

          CREATE INDEX idx_tile_ref_images_upload
            ON tile_ref_images(upload_id);
        `);
    }
    const violations = db
      .query<{ table: string; rowid: number; parent: string; fkid: number }, []>(
        'PRAGMA foreign_key_check',
      )
      .all();
    if (violations.length > 0) {
      throw new MigrationError(
        `migration 22 foreign_key_check failed (${violations.length}): ` +
          JSON.stringify(violations.slice(0, 5)),
      );
    }
  });
  ctx.log?.info({ event: 'migration_rebuild_done', version: 22, tileRows, ms: Math.round(performance.now() - startedAt) }, `migration v22 done: rebuilt ${tileRows} tile rows in ${Math.round(performance.now() - startedAt)}ms`);
}

function migration23Run(db: Database, _ctx: MigrationContext): void {
  const batchesPresent =
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='batches'",
      )
      .get()?.n ?? 0;
  if (batchesPresent === 0) return;

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS batch_prompt_fts USING fts5(
      user_id UNINDEXED,
      batch_id UNINDEXED,
      prompt,
      tokenize = 'trigram'
    );

    INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
    SELECT batches.rowid, batches.user_id, batches.id, batches.prompt
      FROM batches
     WHERE NOT EXISTS (
       SELECT 1 FROM batch_prompt_fts WHERE batch_prompt_fts.rowid = batches.rowid
     );

    CREATE TRIGGER IF NOT EXISTS batches_ai_prompt_fts
    AFTER INSERT ON batches
    BEGIN
      INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
      VALUES (new.rowid, new.user_id, new.id, new.prompt);
    END;

    CREATE TRIGGER IF NOT EXISTS batches_ad_prompt_fts
    AFTER DELETE ON batches
    BEGIN
      DELETE FROM batch_prompt_fts WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS batches_au_prompt_fts
    AFTER UPDATE OF user_id, id, prompt ON batches
    BEGIN
      DELETE FROM batch_prompt_fts WHERE rowid = old.rowid;
      INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
      VALUES (new.rowid, new.user_id, new.id, new.prompt);
    END;
  `);
}

export type FileMigrationAction = 'moved' | 'skipped_missing' | 'skipped_existing';

export interface FileMigrationEvent {
  action: FileMigrationAction;
  path: string;
  reason: string;
  dest?: string;
  tileId?: string;
  userId?: string;
}

interface MigrationContext {
  dataDir: string;
  onFileMigrationEvent?: (event: FileMigrationEvent) => void;
  // Structured logger for migration progress / destructive-purge events.
  // Optional so tests and ad-hoc scripts can run migrate() without one; the
  // server always passes it so prod migration events are JSON, not raw stderr.
  log?: Pick<AppLogger, 'info' | 'warn'>;
  // Legacy CLIProxyAPI text provider for migration 58 to seed. Present only on
  // an upgrade (schema > 0 when migrate() started) whose boot set
  // CLIPROXY_BASE_URL.
  textSeed?: TextSeed;
}

interface SqlMigration {
  version: number;
  sql: string;
}

interface FnMigration {
  version: number;
  fn: (db: Database, ctx: MigrationContext) => void;
}
type Migration = SqlMigration | FnMigration;

function emitFileMigrationEvent(
  ctx: MigrationContext,
  counts: Record<FileMigrationAction, number>,
  event: FileMigrationEvent,
): void {
  ctx.onFileMigrationEvent?.(event);
  counts[event.action] += 1;
}

function fsyncDir(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Deployment assumption: v4 runs on a fresh boot of the new binary with no
// concurrent atelier-api processes — the compose stack defines a single
// atelier-api instance, so `docker compose up -d` stops the running
// container before starting its replacement (no rolling-restart overlap).
// If you ever run multiple api processes against the same DATA_DIR, drain
// old writers before this migration runs.
//
// Orphan files at root (no matching tile row) are NOT swept here.
// startupReconcile runs immediately after migrate() in server.ts; its
// findOrphans + threshold-guarded unlink loop handle root-level orphans
// with the existing safety nets (mount-missing guard, structured logging).
// Sweeping inside the migration would bypass that guard and is irreversible.
function migration4PhysicalUserStorage(db: Database, ctx: MigrationContext): void {
  // Pre-migration audit: USER_ID_PATTERN (now disallows leading `.`) would
  // crash-loop boot if any pre-existing user_id violates it, since validateUserId
  // in storage/files.ts throws synchronously when called for any tile row.
  const userRows = db.query<{ id: string }, []>('SELECT id FROM users').all();
  const invalid = userRows.filter((u) => !USER_ID_PATTERN.test(u.id));
  if (invalid.length > 0) {
    throw new MigrationError(
      `Refusing v4: ${invalid.length} user_id(s) violate USER_ID_PATTERN ` +
        `(leading dot or other invalid char). Manually rename or remove: ${invalid.map((u) => u.id).join(', ')}`,
    );
  }

  const root = namedArtifactRoot(ctx.dataDir, 'images');
  const rows = db
    .query<{ id: string; ext: string; user_id: string }, []>('SELECT id, ext, user_id FROM tiles WHERE ext IS NOT NULL')
    .all();
  ctx.log?.info({ event: 'migration_user_storage_start', version: 4, tileRows: rows.length }, `migration v4 start: scanning ${rows.length} tile rows for per-user move`);
  const counts = { moved: 0, skipped_existing: 0, skipped_missing: 0 };
  const dirtyUserDirs = new Set<string>();
  for (const row of rows) {
    const source = join(root, `${row.id}.${row.ext}`);
    const destDir = namedArtifactDir(ctx.dataDir, 'images', row.user_id);
    const dest = join(destDir, `${row.id}.${row.ext}`);
    if (existsSync(dest)) {
      emitFileMigrationEvent(ctx, counts, {
        action: 'skipped_existing',
        path: source,
        dest,
        tileId: row.id,
        userId: row.user_id,
        reason: 'destination already exists',
      });
      continue;
    }
    if (!existsSync(source)) {
      emitFileMigrationEvent(ctx, counts, {
        action: 'skipped_missing',
        path: source,
        dest,
        tileId: row.id,
        userId: row.user_id,
        reason: 'source and destination missing',
      });
      continue;
    }
    mkdirSync(destDir, { recursive: true });
    renameSync(source, dest);
    dirtyUserDirs.add(destDir);
    emitFileMigrationEvent(ctx, counts, {
      action: 'moved',
      path: source,
      dest,
      tileId: row.id,
      userId: row.user_id,
      reason: 'moved artifact into user directory',
    });
  }

  // Make moves crash-durable BEFORE the schema_versions row commits.
  // fsync each touched user dir (records the new entry) and the images
  // root (records the source-side entry removal + any newly created
  // user dir). Skipping this could let a power-loss leave a rename
  // visible-in-cache but unrecorded, losing the artifact silently.
  if (dirtyUserDirs.size > 0) {
    fsyncDir(root);
    for (const dir of dirtyUserDirs) fsyncDir(dir);
  }

  ctx.log?.info(
    { event: 'migration_user_storage_done', version: 4, ...counts },
    `migration v4 done: moved=${counts.moved} skipped_existing=${counts.skipped_existing} skipped_missing=${counts.skipped_missing}`,
  );
}

// Plain ADD COLUMN ×3 (no FK-rebuild). Implemented as a fn migration only so
// it is idempotent + tolerant of a partial schema: it skips columns that
// already exist (replay) and no-ops when the batches table is absent (the
// per-migration test harnesses hand-roll partial schemas without batches).
// The schema outcome is identical to three raw `ALTER TABLE batches ADD COLUMN`
// statements. ON DELETE SET NULL nulls template_id when its prompt_templates
// row is deleted.
function migration24Run(db: Database): void {
  const hasBatches = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='batches'")
    .get();
  if (!hasBatches) return;
  const existing = new Set(
    db.query<{ name: string }, []>("PRAGMA table_info('batches')").all().map((c) => c.name),
  );
  if (!existing.has('template_id')) {
    db.run('ALTER TABLE batches ADD COLUMN template_id TEXT REFERENCES prompt_templates(id) ON DELETE SET NULL');
  }
  if (!existing.has('roll_seed')) {
    db.run('ALTER TABLE batches ADD COLUMN roll_seed INTEGER');
  }
  if (!existing.has('roll_pins')) {
    db.run('ALTER TABLE batches ADD COLUMN roll_pins TEXT');
  }
}

function migration25Run(db: Database): void {
  const requiredTables = [
    'users',
    'prompt_templates',
    'variable_lists',
    'variable_options',
    'tag_dimensions',
    'dimension_tags',
    'option_tags',
  ];
  const existingTables = new Set(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN (" +
          requiredTables.map((table) => `'${table}'`).join(',') +
          ')',
      )
      .all()
      .map((row) => row.name),
  );
  if (requiredTables.some((table) => !existingTables.has(table))) return;
  runEach(db, migration25Sql);
}

// FTS housekeeping: the v23 `batches_au_prompt_fts` trigger only resynced on
// user_id/id/prompt changes, so soft-archive (UPDATE archived_at) left the row
// in batch_prompt_fts until the 30-day hard-delete purge. Search already masks
// archived batches (history.ts always ANDs `archived_at IS NULL`), so those
// rows were pure index bloat on long-lived servers. Make FTS membership track
// the active (non-archived) set, enforced on every write path: the INSERT
// trigger only indexes batches born active (`WHEN new.archived_at IS NULL`),
// and the UPDATE trigger fires on archived_at too and only re-inserts while
// active — so archive removes the row, restore re-adds it, and a batch created
// already-archived never enters the index. Then backfill — purge any
// already-archived rows — and run the FTS5 'optimize' command to reclaim the
// freed segments. Guarded on BOTH `batches` and the FTS table existing because
// the per-migration test harnesses hand-roll partial schemas; the trigger
// bodies and backfill subquery both reference `batches`. Mirrors schema.sql's
// triggers verbatim (the schema-sync parity test enforces it).
function migration26Run(db: Database): void {
  const tables = new Set(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('batches', 'batch_prompt_fts')",
      )
      .all()
      .map((row) => row.name),
  );
  if (!tables.has('batches') || !tables.has('batch_prompt_fts')) return;

  db.transaction(() => {
    db.run(`
      DROP TRIGGER IF EXISTS batches_ai_prompt_fts;

      CREATE TRIGGER batches_ai_prompt_fts
      AFTER INSERT ON batches
      WHEN new.archived_at IS NULL
      BEGIN
        INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
        VALUES (new.rowid, new.user_id, new.id, new.prompt);
      END;

      DROP TRIGGER IF EXISTS batches_au_prompt_fts;

      CREATE TRIGGER batches_au_prompt_fts
      AFTER UPDATE OF user_id, id, prompt, archived_at ON batches
      BEGIN
        DELETE FROM batch_prompt_fts WHERE rowid = old.rowid;
        INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
        SELECT new.rowid, new.user_id, new.id, new.prompt
        WHERE new.archived_at IS NULL;
      END;

      DELETE FROM batch_prompt_fts
       WHERE rowid IN (SELECT rowid FROM batches WHERE archived_at IS NOT NULL);

      INSERT INTO batch_prompt_fts(batch_prompt_fts) VALUES('optimize');
    `);
  })();
}

// Grok/xAI removed. Remap historical batches off the retired 'xai' pool so they
// match the narrowed Pool type ('shared','byok','local'). These batches are all
// terminal and never re-dispatch, so 'shared' is an inert landing pool. The
// batches CHECK constraint still permits 'xai' (intentionally not rebuilt — a
// full FK-referenced table rebuild is not worth it) but nothing emits it now.
// Guarded for the minimal migration-replay test fixtures that omit `batches`.
function migration27Run(db: Database): void {
  const hasBatches = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='batches'")
    .get();
  if (!hasBatches) return;
  db.run("UPDATE batches SET pool = 'shared' WHERE pool = 'xai'");
}

function migration30Run(db: Database): void {
  const existing = new Set(
    db.query<{ name: string }, []>("PRAGMA table_info('users')").all().map((col) => col.name),
  );
  if (!existing.has('cache_scope')) runEach(db, migration30Sql);
  // migration30Sql contains two statements (ADD COLUMN + CREATE INDEX) and fn
  // migrations deliberately run outside the schema-version transaction. If a
  // crash or disk error lands between those statements, the retry sees the
  // column and used to skip the missing uniqueness constraint while still
  // recording v30 as applied. Reassert the independently idempotent second
  // half before the runner advances schema_versions.
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cache_scope
      ON users(cache_scope)
      WHERE cache_scope IS NOT NULL;
  `);
}

function migration35Run(db: Database, ctx: MigrationContext): void {
  const variableOptionsPresent =
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='variable_options'",
      )
      .get()?.n ?? 0;
  if (variableOptionsPresent === 0) return;

  const variableOptionRows =
    db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM variable_options')
      .get()?.n ?? 0;
  const startedAt = performance.now();
  ctx.log?.info(
    { event: 'migration_rebuild_start', version: 35, variableOptionRows },
    `migration v35 start: rebuilding ${variableOptionRows} variable-option rows`,
  );

  withForeignKeysOff(db, () => {
    // Historical rename-first migration: intentionally not retrofitted.
    // New rebuilds must use rebuildTable's create-copy-drop-legacy-rename pattern.
    // Drop the child triggers BEFORE the parent rebuild. On SQLite builds that
    // rewrite references during `ALTER TABLE ... RENAME` (the production Linux
    // build does; macOS's system SQLite does not), renaming `variable_options`
    // rewrites the bodies of these triggers to read `variable_options_old`.
    // The parent rebuild then drops that table, leaving the triggers pointing
    // at a table that no longer exists — and the very next `ALTER TABLE
      // option_tags RENAME` re-parses the schema and fails with
    // `error in trigger option_tags_ai_revision: no such table:
      // main.variable_options_old`. They are recreated after the child rebuild
    // below. Dropping them first is a no-op on non-rewriting builds.
    db.run(`
        DROP TRIGGER IF EXISTS option_tags_ad_revision;
        DROP TRIGGER IF EXISTS option_tags_ai_revision;
        DROP TRIGGER IF EXISTS option_tags_au_revision;
      `);

    runEach(db, migration35Sql);

    // Some production SQLite builds rewrite this child FK to
    // `variable_options_old` during the parent rename. Rebuilding the child
    // table restores the live parent reference on every build. Its triggers
    // follow the renamed table, so drop the old table before recreating the
    // trigger names on the replacement.
    const optionTagsPresent =
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='option_tags'",
        )
        .get()?.n ?? 0;
    if (optionTagsPresent > 0) {
      db.run(`
          ALTER TABLE option_tags RENAME TO option_tags_old;

          CREATE TABLE option_tags (
            option_id  TEXT NOT NULL REFERENCES variable_options(id) ON DELETE CASCADE,
            tag_id     TEXT NOT NULL REFERENCES dimension_tags(id)   ON DELETE CASCADE,
            polarity   TEXT NOT NULL DEFAULT 'require' CHECK (polarity IN ('require', 'exclude')),
            PRIMARY KEY (option_id, tag_id)
          );

          INSERT INTO option_tags (option_id, tag_id, polarity)
          SELECT option_id, tag_id, polarity FROM option_tags_old;

          DROP TABLE option_tags_old;

          CREATE TRIGGER option_tags_ad_revision
          AFTER DELETE ON option_tags
          BEGIN
            INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
            SELECT o.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000
              FROM variable_options o
             WHERE o.id = old.option_id
            ON CONFLICT(user_id) DO UPDATE SET
              revision = prompt_library_revisions.revision + 1,
              updated_at = excluded.updated_at;
          END;

          CREATE TRIGGER option_tags_ai_revision
          AFTER INSERT ON option_tags
          BEGIN
            INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
            SELECT o.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000
              FROM variable_options o
             WHERE o.id = new.option_id
            ON CONFLICT(user_id) DO UPDATE SET
              revision = prompt_library_revisions.revision + 1,
              updated_at = excluded.updated_at;
          END;

          CREATE TRIGGER option_tags_au_revision
          AFTER UPDATE OF polarity ON option_tags
          BEGIN
            INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
            SELECT o.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000
              FROM variable_options o
             WHERE o.id = new.option_id
            ON CONFLICT(user_id) DO UPDATE SET
              revision = prompt_library_revisions.revision + 1,
              updated_at = excluded.updated_at;
          END;

          CREATE INDEX idx_option_tags_tag ON option_tags(tag_id);
        `);
    }

    const violations = db
      .query<{ table: string; rowid: number; parent: string; fkid: number }, []>(
        'PRAGMA foreign_key_check',
      )
      .all();
    if (violations.length > 0) {
      throw new MigrationError(
        `migration 35 foreign_key_check failed (${violations.length}): ` +
          JSON.stringify(violations.slice(0, 5)),
      );
    }
  });
  ctx.log?.info(
    {
      event: 'migration_rebuild_done',
      version: 35,
      variableOptionRows,
      ms: Math.round(performance.now() - startedAt),
    },
    `migration v35 done: rebuilt ${variableOptionRows} variable-option rows in ${Math.round(performance.now() - startedAt)}ms`,
  );
}

function migration36Run(db: Database): void {
  const requiredTables = ['users', 'batches', 'uploads'];
  const existingTables = new Set(
    db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'batches', 'uploads')",
    ).all().map((row) => row.name),
  );
  if (requiredTables.some((table) => !existingTables.has(table))) return;

  const statements = splitSqlStatements(migration36Sql);
  if (statements.length !== 5) {
    throw new MigrationError(`migration v36 expected 5 SQL statements, found ${statements.length}`);
  }
  const statement = (index: number): string => {
    const sql = statements[index];
    if (sql === undefined) throw new MigrationError(`migration v36 missing SQL statement ${index + 1}`);
    return sql;
  };
  const columns = (table: string): Set<string> => new Set(
    db.query<{ name: string }, []>(`PRAGMA table_info('${table}')`).all().map((column) => column.name),
  );

  db.transaction(() => {
    const sequenceTable = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='video_sequences'",
    ).get();
    if (!sequenceTable) db.run(statement(0));

    const batchColumns = columns('batches');
    if (!batchColumns.has('sequence_id')) db.run(statement(1));
    if (!batchColumns.has('sequence_index')) db.run(statement(2));
    db.run(statement(3));

    if (!columns('uploads').has('source_tile_id')) db.run(statement(4));
  })();
}

function migration37Run(db: Database): void {
  const usersTable = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
  ).get();
  if (!usersTable) return;

  const statements = splitSqlStatements(migration37Sql);
  if (statements.length !== 1) {
    throw new MigrationError(`migration v37 expected 1 SQL statement, found ${statements.length}`);
  }
  const statement = statements[0];
  if (statement === undefined) throw new MigrationError('migration v37 missing SQL statement 1');

  db.transaction(() => {
    const table = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='user_text_backends'",
    ).get();
    if (!table) db.run(statement);
  })();
}

// Columns added to user_text_backends after the historical rebuilds below
// (v49 `effort`). Production never re-runs those rebuilds, but a replay that
// rolls schema_versions back meets the later column: drop it there and let
// the later migration add it again.
function laterUserTextBackendColumns(db: Database): string[] {
  return tableColumns(db, 'user_text_backends').has('effort') ? ['effort'] : [];
}

const TEXT_BACKEND_COLUMNS = ['user_id', 'workload', 'backend', 'updated_at'] as const;

// Recreates user_text_backends from a migration's CREATE TABLE (which carries
// that migration's backend CHECK), dropping columns later migrations add.
// Must run inside withForeignKeysOff.
function rebuildTextBackends(db: Database, sql: string): void {
  rebuildTable(db, {
    table: 'user_text_backends',
    dropColumns: laterUserTextBackendColumns(db),
    createSql: (name) => sql.replace('CREATE TABLE user_text_backends', `CREATE TABLE ${name}`),
    columns: TEXT_BACKEND_COLUMNS,
  });
}

// Widens the backend CHECK with one safe-order rebuild. No-op when the table
// is absent (reduced test fixtures only) and idempotent when rerun.
function widenTextBackends(db: Database, sql: string): void {
  if (tableColumns(db, 'user_text_backends').size === 0) return;
  withForeignKeysOff(db, () => { rebuildTextBackends(db, sql); });
}

// Renames the legacy 'flash' text-backend value to 'deepseek-pro' and widens
// the backend CHECK to the three-key union. SQLite cannot alter a CHECK in
// place, so the table is rebuilt twice through rebuildTable:
//   pass 1 recreates it WITHOUT a backend CHECK so the stored 'flash' rows can
//     be rewritten in place without violating the old constraint;
//   the UPDATE then maps every 'flash' row to 'deepseek-pro' (no preference is
//     lost — a pinned user stays pinned to DeepSeek V4 Pro);
//   pass 2 recreates it with the widened CHECK from 0038 over the now-valid
//     values.
// Every step satisfies its active constraint; no transient violation exists.
// On fresh installs migration 37 creates the table immediately before this
// runs; the absent-table no-op exists only for the reduced per-migration test
// fixtures. Idempotent when re-run against an already-migrated table.
function migration38Run(db: Database): void {
  if (tableColumns(db, 'user_text_backends').size === 0) return;

  const checklessCreateSql = (name: string): string => `
    CREATE TABLE ${name} (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workload   TEXT NOT NULL,
      backend    TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, workload)
    );
  `;

  withForeignKeysOff(db, () => {
    rebuildTable(db, {
      table: 'user_text_backends',
      dropColumns: laterUserTextBackendColumns(db),
      createSql: checklessCreateSql,
      columns: TEXT_BACKEND_COLUMNS,
    });
    db.run("UPDATE user_text_backends SET backend = 'deepseek-pro' WHERE backend = 'flash'");
    rebuildTextBackends(db, migration38Sql);
  });
}

// Adds Qwen to the persisted text-backend union. SQLite cannot alter a CHECK
// in place, so rebuild the table once through the shared safe-order helper.
// No-op when the table is absent and idempotent when rerun.
function migration39Run(db: Database): void {
  widenTextBackends(db, migration39Sql);
}

// Adds GLM 5.3 Flash to the persisted text-backend union. Same
// shape as migration 39: SQLite cannot alter a CHECK in place, so rebuild the
// table once through the shared safe-order helper. No-op when the table is
// absent and idempotent when rerun.
function migration40Run(db: Database): void {
  widenTextBackends(db, migration40Sql);
}

// Widen the backend CHECK with the same safe-order rebuild as migration 40.
function migration43Run(db: Database): void {
  widenTextBackends(db, migration43Sql);
}

// Retire Pro overrides before narrowing the CHECK (2026-09-15).
function migration44Run(db: Database): void {
  if (tableColumns(db, 'user_text_backends').size === 0) return;
  withForeignKeysOff(db, () => {
    db.run("UPDATE user_text_backends SET backend = 'deepseek-flash' WHERE backend = 'deepseek-pro'");
    rebuildTextBackends(db, migration44Sql);
  });
}

// Local ComfyUI has a single host since 2026-09-27, so the forced-host
// column has nothing left to pin.
// The inverse of the additive guard: drops the column only while present.
function migration46Run(db: Database): void {
  if (tableColumns(db, 'batches').has('preferred_host')) runEach(db, migration46Sql);
}

// Splits GLM by upstream (2026-10-05): 'glm-flash' becomes GLM 5.3 Flash and
// 'glm-abliterated' GLM 5.3 Uncensored. Every stored 'glm-flash' pin was made
// against the uncensored GLM, so it moves to the 'glm-abliterated' key
// with any effort that key does not offer cleared to the default. Widens the
// CHECK first through the same safe-order rebuild as migration 44; the rebuild
// and the remap commit together, so a rerun finds no pre-split pins to move.
function migration50Run(db: Database): void {
  if (tableColumns(db, 'user_text_backends').size === 0) return;
  // First rebuild after v49's `effort`: it is carried, not dropped.
  withForeignKeysOff(db, () => {
    rebuildTable(db, {
      table: 'user_text_backends',
      createSql: (name) =>
        migration50Sql.replace('CREATE TABLE user_text_backends', `CREATE TABLE ${name}`),
      columns: [...TEXT_BACKEND_COLUMNS, 'effort'],
    });
    db.run(`
      UPDATE user_text_backends
         SET backend = 'glm-abliterated',
             effort = CASE WHEN effort IN ('low', 'high', 'max') THEN effort ELSE NULL END
       WHERE backend = 'glm-flash'
    `);
  });
}

// Retires the text backends the proxy dropped (2026-10-23) and admits their
// replacements. Pins on 'qwen', 'glm-flash' and 'deepseek-flash' are deleted
// with their efforts, so those workloads route as Auto; a Kimi effort the
// current Kimi upstream does not list (only low/high/max) resets to the
// default. Both run before the rebuild, so the narrowed CHECK never
// meets a retired key, and all three commit together. Carries `effort` like
// migration 50. No-op when the table is absent and idempotent when rerun.
function migration55Run(db: Database): void {
  if (tableColumns(db, 'user_text_backends').size === 0) return;
  withForeignKeysOff(db, () => {
    db.run("DELETE FROM user_text_backends WHERE backend IN ('qwen', 'glm-flash', 'deepseek-flash')");
    db.run(`
      UPDATE user_text_backends
         SET effort = NULL
       WHERE backend = 'kimi' AND effort IS NOT NULL AND effort NOT IN ('low', 'high', 'max')
    `);
    rebuildTable(db, {
      table: 'user_text_backends',
      createSql: (name) =>
        migration55Sql.replace('CREATE TABLE user_text_backends', `CREATE TABLE ${name}`),
      columns: [...TEXT_BACKEND_COLUMNS, 'effort'],
    });
  });
}

// Admin-managed text providers and models replace the seven fixed backends.
// Creates the five tables, then in ONE inner transaction seeds the legacy
// CLIProxyAPI provider (when boot offered a seed and none exists yet), moves
// every pin whose key has a seeded row into user_text_models with its effort,
// and drops user_text_backends. A crash leaves either the old table or the
// full new state; a rerun finds the seed present and the old table gone.
// Pins whose key has no seeded row (seedless install) or whose workload is not
// a task are dropped and counted in the log. Legacy GPT pins are dropped too:
// the old resolver ignored them (routed as Auto), so carrying one would start
// pinning GPT where it never was.
function migration58Run(db: Database, ctx: MigrationContext): void {
  db.transaction(() => {
    runEach(db, migration58Sql);
  })();
  const seed = ctx.textSeed;
  const hasLegacyPins = tableColumns(db, 'user_text_backends').size > 0;
  db.transaction(() => {
    const seeded = db
      .query<{ id: string }, [string]>('SELECT id FROM text_providers WHERE preset = ?')
      .get(LEGACY_SEED.provider.preset) !== null;
    if (seed !== undefined && !seeded) seedLegacyTextProvider(db, seed);
    if (!hasLegacyPins) return;
    const taskList = TEXT_TASKS.map(() => '?').join(', ');
    const carriedPins = `
      FROM user_text_backends u
      JOIN text_models m ON m.legacy_key = u.backend
     WHERE u.workload IN (${taskList})
       AND u.backend <> 'gpt'`;
    const total = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user_text_backends').get()?.count ?? 0;
    const carried = db
      .query<{ count: number }, string[]>(`SELECT COUNT(*) AS count ${carriedPins}`)
      .get(...TEXT_TASKS)?.count ?? 0;
    db.query<unknown, string[]>(`
      INSERT INTO user_text_models (user_id, task, text_model_id, effort, updated_at)
      SELECT u.user_id, u.workload, m.id, u.effort, u.updated_at ${carriedPins}
    `).run(...TEXT_TASKS);
    db.run('DROP TABLE user_text_backends');
    const dropped = total - carried;
    if (dropped > 0) {
      ctx.log?.warn(
        { event: 'migration_text_pins_dropped', version: 58, carried, dropped },
        `migration v58: dropped ${dropped} text-backend pins with no migrated model`,
      );
    } else {
      ctx.log?.info(
        { event: 'migration_text_pins_carried', version: 58, carried },
        `migration v58: carried ${carried} text-backend pins`,
      );
    }
  })();
}

/** Seeds the legacy CLIProxyAPI provider (spec § 11.1); exported for test fixtures. */
export function seedLegacyTextProvider(db: Database, seed: TextSeed): void {
  const now = Date.now();
  const { provider } = LEGACY_SEED;
  const providerId = randomUUID();
  db.query(`
    INSERT INTO text_providers (
      id, name, protocol, base_url, preset, auth_mode, credential_env,
      token_field, list_models, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    providerId,
    provider.name,
    provider.protocol,
    `${seed.baseUrl.replace(/\/+$/, '')}${provider.basePath}`,
    provider.preset,
    provider.authMode,
    provider.credentialEnv,
    provider.tokenField,
    provider.listModels ? 1 : 0,
    now,
    now,
  );
  const modelRowIds = new Map<string, string>();
  const insertModel = db.query(`
    INSERT INTO text_models (
      id, provider_id, model_id, display_name, legacy_key, enabled, vision, max_images,
      structured_output, reasoning_levels, reasoning_default, temperature, top_p,
      fixed_output_tokens, latency_profile, prompt_variant, screen_requests, sort_order,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  LEGACY_SEED.models.forEach((model, index) => {
    const id = randomUUID();
    const caps = model.capabilities;
    modelRowIds.set(model.legacyKey, id);
    insertModel.run(
      id,
      providerId,
      seed.modelIds[model.legacyKey],
      model.displayName,
      model.legacyKey,
      caps.vision ? 1 : 0,
      caps.maxImages,
      caps.structuredOutput,
      JSON.stringify(caps.reasoningLevels),
      caps.reasoningDefault,
      caps.temperature,
      caps.topP,
      caps.fixedOutputTokens,
      caps.latencyProfile,
      caps.promptVariant,
      model.screenRequests ? 1 : 0,
      index,
      now,
      now,
    );
  });
  const rowFor = (key: string): string => {
    const id = modelRowIds.get(key);
    if (id === undefined) throw new MigrationError(`migration v58: no seeded text model for '${key}'`);
    return id;
  };
  db.query("INSERT INTO text_defaults (scope, text_model_id, updated_at) VALUES ('default', ?, ?)")
    .run(rowFor(LEGACY_SEED.defaultKey), now);
  const writer = rowFor(LEGACY_SEED.imageWriterKey);
  const insertWriter = db.query(
    'INSERT OR IGNORE INTO image_model_writers (image_model_id, text_model_id, mode, updated_at) VALUES (?, ?, ?, ?)',
  );
  // Sunburst first: an id in both lists keeps the stricter lock.
  for (const imageModelId of seed.sunburstImageModelIds) insertWriter.run(imageModelId, writer, 'lock', now);
  for (const imageModelId of seed.gptImageModelIds) insertWriter.run(imageModelId, writer, 'prefer', now);
}

// Partial index behind every "is this upload still referenced" probe. No-op
// when batches is absent (reduced test fixtures); IF NOT EXISTS makes it
// idempotent.
function migration52Run(db: Database): void {
  if (tableColumns(db, 'batches').size === 0) return;
  runEach(db, migration52Sql);
}

// Generate idempotency key (ADD COLUMN + partial UNIQUE index). No-op when
// batches is absent (reduced test fixtures). Same crash-between-statements
// repair as migration30Run: a retry that finds the column still reasserts the
// independently idempotent index before schema_versions advances.
function migration54Run(db: Database): void {
  if (tableColumns(db, 'batches').size === 0) return;
  addColumnIfMissing(db, 'batches', 'idempotency_key', migration54Sql);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_idempotency_key
      ON batches(user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
}

function migration51Run(db: Database): void {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info('video_sequences')").all();
  // Match the additive migrations' reduced historical fixture convention.
  if (columns.length === 0) return;
  db.transaction(() => {
    runEach({
      run(sql) {
        // Permit idempotent replay of either additive column after a partial
        // historical fixture, while keeping the SQL file authoritative.
        if (columns.some((column) => sql.includes(`ADD COLUMN ${column.name} `))) return;
        db.run(sql);
      },
    }, migration51Sql);
  })();
}

function migration42Run(db: Database): void {
  const tablePresent = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='stories'",
  ).get();
  // Atomic on purpose: fn migrations run outside migrate()'s transaction, and
  // this guard names only the first of the file's four objects — a crash
  // between statements would otherwise leave `stories` present, the guard
  // satisfied, and story_segments/indexes missing forever (mirrors migration 19).
  if (!tablePresent) {
    db.transaction(() => { runEach(db, migration42Sql); })();
  }
}

function migration33Run(db: Database): void {
  const requiredTables = [
    'tag_dimensions',
    'dimension_tags',
    'option_tags',
    'variable_options',
  ];
  const existingTables = new Set(
    db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (" +
        requiredTables.map((table) => `'${table}'`).join(',') +
        ')',
    ).all().map((row) => row.name),
  );
  if (requiredTables.some((table) => !existingTables.has(table))) return;
  const statements = splitSqlStatements(migration33Sql);
  if (statements.length !== 4) {
    throw new MigrationError(`migration v33 expected 4 SQL statements, found ${statements.length}`);
  }
  const statement = (index: number): string => {
    const sql = statements[index];
    if (sql === undefined) throw new MigrationError(`migration v33 missing SQL statement ${index + 1}`);
    return sql;
  };
  const columns = (table: string): Set<string> => new Set(
    db.query<{ name: string }, []>(`PRAGMA table_info('${table}')`).all().map((column) => column.name),
  );

  db.transaction(() => {
    if (!columns('tag_dimensions').has('description')) db.run(statement(0));
    if (!columns('dimension_tags').has('parent_id')) db.run(statement(1));
    if (!columns('option_tags').has('polarity')) db.run(statement(2));

    const polarityUpdateTrigger = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='option_tags_au_revision'",
    ).get();
    if (!polarityUpdateTrigger) db.run(statement(3));
  })();
}

const migrations: readonly Migration[] = [
  { version: 1, sql: migration1 },
  { version: 2, sql: migration2 },
  { version: 3, fn: migration3CleanupPhantomArchived },
  { version: 4, fn: migration4PhysicalUserStorage },
  { version: 5, sql: migration5 },
  { version: 6, sql: migration6 },
  { version: 7, sql: migration7 },
  { version: 8, sql: migration8 },
  { version: 9, sql: migration9 },
  { version: 10, sql: migration10 },
  { version: 11, sql: migration11 },
  { version: 12, sql: migration12 },
  { version: 13, sql: migration13 },
  { version: 14, sql: migration14 },
  { version: 15, sql: migration15 },
  { version: 16, sql: migration16 },
  { version: 17, sql: migration17 },
  { version: 18, sql: migration18 },
  { version: 19, fn: migration19Run },
  { version: 20, sql: migration20 },
  { version: 21, sql: migration21 },
  { version: 22, fn: migration22Run },
  { version: 23, fn: migration23Run },
  { version: 24, fn: migration24Run },
  { version: 25, fn: migration25Run },
  { version: 26, fn: migration26Run },
  { version: 27, fn: migration27Run },
  { version: 28, fn: (db) => { addColumnIfMissing(db, 'batches', 'i2v_source_upload_id', migration28Sql); } },
  { version: 29, fn: (db) => { addColumnIfMissing(db, 'batches', 'motion_prompt', migration29Sql); } },
  { version: 30, fn: migration30Run },
  { version: 31, fn: (db) => { addColumnIfMissing(db, 'batches', 'card_notes', migration31Sql); } },
  { version: 32, fn: (db) => { addColumnIfMissing(db, 'batches', 'preferred_host', migration32Sql); } },
  { version: 33, fn: migration33Run },
  { version: 34, fn: (db) => { addColumnIfMissing(db, 'batches', 'duration_frames', migration34Sql); } },
  { version: 35, fn: migration35Run },
  { version: 36, fn: migration36Run },
  { version: 37, fn: migration37Run },
  { version: 38, fn: migration38Run },
  { version: 39, fn: migration39Run },
  { version: 40, fn: migration40Run },
  { version: 41, fn: (db) => { addColumnIfMissing(db, 'batches', 'context_frames', migration41Sql); } },
  { version: 42, fn: migration42Run },
  { version: 43, fn: migration43Run },
  { version: 44, fn: migration44Run },
  { version: 45, sql: migration45Sql },
  { version: 46, fn: migration46Run },
  { version: 47, fn: (db) => { addColumnIfMissing(db, 'tiles', 'moderation_reason', migration47Sql); } },
  { version: 48, fn: (db) => { addColumnIfMissing(db, 'tiles', 'moderation_categories', migration48Sql); } },
  { version: 49, fn: (db) => { addColumnIfMissing(db, 'user_text_backends', 'effort', migration49Sql); } },
  { version: 50, fn: migration50Run },
  { version: 51, fn: migration51Run },
  { version: 52, fn: migration52Run },
  { version: 53, fn: (db) => { addColumnIfMissing(db, 'batches', 'started_at', migration53Sql); } },
  { version: 54, fn: migration54Run },
  { version: 55, fn: migration55Run },
  { version: 56, sql: migration56Sql },
  { version: 57, sql: migration57Sql },
  { version: 58, fn: migration58Run },
];

export function migrate(
  db: Database,
  dataDir: string,
  options: {
    onFileMigrationEvent?: (event: FileMigrationEvent) => void;
    log?: Pick<AppLogger, 'info' | 'warn'>;
    // Offered by boot when CLIPROXY_BASE_URL is set; applied only when the
    // database existed before this run (schema > 0), so a fresh install never
    // gets the legacy CLIProxyAPI text provider.
    textSeed?: TextSeed;
    // Historical-fixture tests only: stop after this version.
    targetVersion?: number;
  } = {},
): { startVersion: number } {
  // Defense in depth: tests open `new Database(':memory:')` and pass it
  // straight into migrate() without going through openDb. Re-apply the
  // PRAGMA baseline so FK cascade actually fires inside the migrations
  // (especially v4's cleanup) instead of silently no-op-ing.
  applyPragmas(db);

  // Forward-only contiguity invariant: the loop applies any migration whose
  // version > current in array order and INSERTs its schema_versions row
  // (PK). An out-of-order, duplicated, or gapped version would either apply
  // migrations in the wrong order or hit a PK constraint mid-loop, leaving a
  // partially-applied schema. Assert the static shape before any DB work.
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i];
    if (m?.version !== i + 1) {
      throw new MigrationError(
        `migrations array must be contiguous and forward-only starting at 1; ` +
          `expected version ${i + 1} at index ${i}, found ${m?.version ?? 'undefined'}`,
      );
    }
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const row = db
    .query<{ version: number | null }, []>('SELECT MAX(version) AS version FROM schema_versions')
    .get();
  const current = row?.version ?? 0;
  if (current > BINARY_SCHEMA_VERSION) {
    throw new MigrationError(
      `database schema version ${current} is newer than binary schema version ${BINARY_SCHEMA_VERSION}`,
    );
  }

  const textSeed = current > 0 ? options.textSeed : undefined;
  const target = options.targetVersion ?? BINARY_SCHEMA_VERSION;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    if (migration.version > target) break;
    if ('sql' in migration) {
      db.transaction(() => {
        runEach(db, migration.sql);
        db.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      })();
    } else {
      // Fn migrations do filesystem work that SQL transactions cannot roll
      // back. Run the fn OUTSIDE any transaction; only commit the
      // schema_versions row after the fn returns cleanly. If the fn throws,
      // the schema stays at the previous version and the migration retries
      // on next boot — which is why the fn must be idempotent.
      const ctx: MigrationContext = {
        dataDir,
        ...(options.onFileMigrationEvent ? { onFileMigrationEvent: options.onFileMigrationEvent } : {}),
        ...(options.log ? { log: options.log } : {}),
        ...(textSeed ? { textSeed } : {}),
      };
      migration.fn(db, ctx);
      db.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
    }
  }
  return { startVersion: current };
}
