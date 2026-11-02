import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARY_SCHEMA_VERSION, migrate } from '../db/migrate';

interface SchemaEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

function splitTopLevelTableItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote !== null) {
      if (quote === ']' ? char === ']' : char === quote) {
        if (quote !== ']' && body[i + 1] === quote) {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '[') {
      quote = ']';
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  items.push(body.slice(start));
  return items;
}

// Normalize SQL so structurally-equivalent definitions compare equal even when
// SQLite's ALTER TABLE representation appends new columns after table
// constraints, and when a rebuildTable rename re-stores the CREATE statement
// with quoted identifiers ("user_text_backends" vs user_text_backends —
// semantically identical). CREATE TABLE items are compared as a sorted
// multiset; each item still retains its complete normalized CHECK/FK/UNIQUE/PK
// definition.
const ALTERED_BY_MIGRATION_33 = new Set(['tag_dimensions', 'dimension_tags', 'option_tags']);

function normalizeSql(sql: string, objectName: string): string {
  const normalized = sql
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s*=\s*/g, ' = ')
    .replaceAll('"', '')
    .trim()
    .toLowerCase();
  if (!normalized.startsWith('create table ') || !ALTERED_BY_MIGRATION_33.has(objectName)) return normalized;

  const open = normalized.indexOf('(');
  if (open < 0) return normalized;
  let depth = 0;
  let close = -1;
  for (let i = open; i < normalized.length; i++) {
    if (normalized[i] === '(') depth += 1;
    else if (normalized[i] === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return normalized;

  const items = splitTopLevelTableItems(normalized.slice(open + 1, close))
    .map((item) => item.trim())
    .sort();
  return `${normalized.slice(0, open + 1)}${items.join(', ')})${normalized.slice(close + 1)}`;
}

function loadSchemaEntries(db: Database): Map<string, string> {
  // sqlite_master.sql captures the FULL DDL including CHECK constraints,
  // FOREIGN KEYs (with ON DELETE actions), UNIQUE clauses, and partial-index
  // WHERE predicates — all the surface area that PRAGMA table_info silently
  // omits. Excluding sqlite_autoindex_* avoids comparing implicit indexes
  // created for PRIMARY KEY / UNIQUE columns (which both schema.sql and
  // migrate() produce identically anyway).
  const entries = db
    .query<SchemaEntry, []>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master " +
        "WHERE sql IS NOT NULL " +
        "AND name NOT LIKE 'sqlite_%' " +
        "AND name != 'schema_versions' " +
        "ORDER BY type, tbl_name, name",
    )
    .all();
  const map = new Map<string, string>();
  for (const e of entries) {
    map.set(`${e.type}:${e.name}`, normalizeSql(e.sql, e.name));
  }
  return map;
}

describe('schema.sql ↔ migrate() parity', () => {
  test('cumulative migrations match the canonical schema.sql (full DDL incl. CHECK/FK/UNIQUE/partial-WHERE)', () => {
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql');
    const schemaSql = readFileSync(schemaPath, 'utf8');

    const fromSchema = new Database(':memory:');
    fromSchema.run(schemaSql);
    const expected = loadSchemaEntries(fromSchema);
    fromSchema.close();

    const fromMigrate = new Database(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-schema-sync-'));
    try {
      migrate(fromMigrate, dataDir);
      const actual = loadSchemaEntries(fromMigrate);

      // Same set of objects (tables + indexes by qualified name).
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());

      // Same DDL for each. A CHECK constraint drift, an FK ON DELETE swap, a
      // UNIQUE clause drop, or a partial-index WHERE change all surface here.
      for (const [key, expectedDdl] of expected) {
        const actualDdl = actual.get(key);
        expect(actualDdl, `missing from migrate(): ${key}`).toBeDefined();
        expect(actualDdl).toEqual(expectedDdl);
      }
    } finally {
      fromMigrate.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('BINARY_SCHEMA_VERSION equals the applied migration count (no gap/off-by-one)', () => {
    const db = new Database(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-schema-ver-'));
    try {
      migrate(db, dataDir);
      const versions = db
        .query<{ version: number }, []>('SELECT version FROM schema_versions ORDER BY version')
        .all()
        .map((r) => r.version);
      // Contiguous 1..N AND the constant tracks the last migration. Catches a
      // migration landing without the BINARY_SCHEMA_VERSION bump (or vice
      // versa) — the boot-time "db newer than binary" guard depends on it.
      expect(versions).toEqual(Array.from({ length: BINARY_SCHEMA_VERSION }, (_, i) => i + 1));
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
