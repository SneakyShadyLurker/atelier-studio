// True when `error` is a SQLite UNIQUE-constraint violation on the given table.
// Route-neutral home (collections + the prompt-library routes both use it).
export function isUniqueConstraintError(error: unknown, table: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code !== 'SQLITE_CONSTRAINT_UNIQUE') return false;
  return error.message.includes(`${table}.`);
}
