import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { BINARY_SCHEMA_VERSION, migrate } from '/app/api/src/db/migrate.ts';

interface TableListRow {
  readonly schema: string;
  readonly name: string;
  readonly type: string;
}

interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

const OLD_TABLE_REFERENCE_PATTERN =
  /\b(?:REFERENCES|FROM|JOIN|UPDATE|INTO|ON|TABLE)\s+(?:(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)\.)?(?:"[^"]*_old"|`[^`]*_old`|\[[^\]]*_old\]|[A-Za-z_][A-Za-z0-9_]*_old)(?=\s|[,(;]|$)/i;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function userTables(db: Database): TableListRow[] {
  return db.query<TableListRow, []>('PRAGMA table_list').all()
    .filter((row) =>
      row.schema === 'main' &&
      !row.name.startsWith('sqlite_') &&
      (row.type === 'table' || row.type === 'virtual'))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function rowCounts(db: Database): Map<string, number | null> {
  const counts = new Map<string, number | null>();
  for (const table of userTables(db)) {
    try {
      const count = db.query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}`,
      ).get()?.count ?? null;
      counts.set(table.name, count);
    } catch (error) {
      console.warn(`row count unavailable for ${table.name}: ${String(error)}`);
      counts.set(table.name, null);
    }
  }
  return counts;
}

function reportCountSummary(
  before: ReadonlyMap<string, number | null>,
  after: ReadonlyMap<string, number | null>,
): void {
  const beforeTables = [...before.keys()];
  const afterTables = [...after.keys()];
  const addedTables = afterTables.filter((name) => !before.has(name));
  const droppedTables = beforeTables.filter((name) => !after.has(name));
  const rowCountDeltas = [...new Set([...beforeTables, ...afterTables])]
    .sort()
    .map((table) => {
      const beforeCount = before.get(table) ?? null;
      const afterCount = after.get(table) ?? null;
      return {
        table,
        before: beforeCount,
        after: afterCount,
        delta: beforeCount === null || afterCount === null ? null : afterCount - beforeCount,
      };
    });

  // Counts and table-set changes are deliberately advisory. Migrations may
  // transform data or add/drop tables, so this schema-agnostic gate reports
  // them without encoding migration-specific expectations that would rot.
  console.log('migration rehearsal before/after summary:');
  console.log(JSON.stringify({ addedTables, droppedTables, rowCountDeltas }, null, 2));
}

function containsRebuildArtefact(sql: string): boolean {
  const withoutStringLiterals = sql.replace(/'(?:''|[^'])*'/g, "''");
  const normalizedSql = withoutStringLiterals.toLowerCase();
  return OLD_TABLE_REFERENCE_PATTERN.test(normalizedSql) ||
    normalizedSql.includes('__atelier_rebuild_') ||
    normalizedSql.includes('__atelier_reparse_probe');
}

function assertPostMigrationState(db: Database): void {
  const version = db.query<{ version: number | null }, []>(
    'SELECT MAX(version) AS version FROM schema_versions',
  ).get()?.version ?? null;
  if (version !== BINARY_SCHEMA_VERSION) {
    throw new Error(
      `schema version mismatch: got ${String(version)}, expected ${BINARY_SCHEMA_VERSION}`,
    );
  }

  const foreignKeyViolations = db.query<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }, []>('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) {
    throw new Error(
      `foreign_key_check failed (${foreignKeyViolations.length}): ` +
        JSON.stringify(foreignKeyViolations.slice(0, 10)),
    );
  }

  const integrityRows = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
    throw new Error(`integrity_check failed: ${JSON.stringify(integrityRows.slice(0, 10))}`);
  }

  const artefacts = db.query<SchemaObjectRow, []>(`
    SELECT type, name, sql
      FROM sqlite_master
     WHERE sql IS NOT NULL
     ORDER BY type, name
  `).all().filter((object) => containsRebuildArtefact(object.sql));
  if (artefacts.length > 0) {
    throw new Error(`schema contains rebuild artefacts: ${JSON.stringify(artefacts)}`);
  }
}

function runSchemaReparseProbe(db: Database): void {
  db.run('PRAGMA legacy_alter_table = OFF');
  const tables = userTables(db);
  const occupiedNames = new Set(
    db.query<{ name: string }, []>('SELECT name FROM sqlite_master').all().map((row) => row.name),
  );

  for (const [index, table] of tables.entries()) {
    let probeName = `${table.name}__atelier_reparse_probe_${index}`;
    while (occupiedNames.has(probeName)) probeName += '_x';
    try {
      db.transaction(() => {
        db.run(
          `ALTER TABLE ${quoteIdentifier(table.name)} RENAME TO ${quoteIdentifier(probeName)}`,
        );
        db.run(
          `ALTER TABLE ${quoteIdentifier(probeName)} RENAME TO ${quoteIdentifier(table.name)}`,
        );
      })();
    } catch (error) {
      throw new Error(`schema re-parse probe failed for table ${table.name}`, { cause: error });
    }
  }
}

function main(): void {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error('DATA_DIR is required');

  const db = new Database(join(dataDir, 'atelier.sqlite'));
  try {
    const before = rowCounts(db);
    migrate(db, dataDir);
    const after = rowCounts(db);
    reportCountSummary(before, after);
    assertPostMigrationState(db);

    // Run last: ALTER RENAME intentionally rewrites schema text. Shadow tables
    // are excluded because they are implementation-owned by their virtual
    // table; ordinary and virtual user tables are each renamed out and back.
    // Every pair is transactional, and the database itself is a throwaway copy.
    runSchemaReparseProbe(db);
    assertPostMigrationState(db);
    console.log(`migration rehearsal passed at schema version ${BINARY_SCHEMA_VERSION}`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error('migration rehearsal failed');
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
