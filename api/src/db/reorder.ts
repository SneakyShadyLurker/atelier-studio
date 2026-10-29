import type { Database } from 'bun:sqlite';

export type ReorderableTable = 'prompt_templates' | 'variable_lists' | 'collections';

// Runtime allowlist for the interpolated table name. The `ReorderableTable`
// union is the compile-time guard; this Set makes the no-injection invariant
// local and self-evident, so a future widening of the param type to `string`
// fails loudly here instead of silently opening an injection hole.
const REORDERABLE_TABLES: ReadonlySet<string> = new Set<ReorderableTable>([
  'prompt_templates',
  'variable_lists',
  'collections',
]);

export function reorderOwned(
  db: Database,
  userId: string,
  table: ReorderableTable,
  orderedIds: readonly string[],
): 'ok' | 'duplicate' | 'mismatch' {
  if (!REORDERABLE_TABLES.has(table)) throw new Error(`invalid reorder table: ${JSON.stringify(table)}`);
  const unique = new Set(orderedIds);
  if (unique.size !== orderedIds.length) return 'duplicate';
  const result = db.transaction(() => {
    const owned = db.query<{ id: string }, [string]>(`SELECT id FROM ${table} WHERE user_id = ?`).all(userId);
    const ownedSet = new Set(owned.map((row) => row.id));
    if (ownedSet.size !== orderedIds.length) return 'mismatch' as const;
    for (const id of orderedIds) {
      if (!ownedSet.has(id)) return 'mismatch' as const;
    }
    const update = db.query(`UPDATE ${table} SET sort_order = ? WHERE id = ? AND user_id = ?`);
    orderedIds.forEach((id, index) => {
      update.run(index, id, userId);
    });
    return 'ok' as const;
  })();
  return result;
}
