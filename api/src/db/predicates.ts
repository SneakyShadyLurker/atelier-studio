// Centralized SQL predicates so listing/count queries that must agree on
// what "archive-visible" means cannot drift apart. Tile-grain, post-write
// (done/ext/mime/completed_at all populated), AFTER the user soft-archived
// the row. Any new query that lists or counts archived tiles MUST use this
// constant, not a hand-typed copy — the collection-archive-count and the
// archive-view filter previously had two copies and the comment block above
// the original was a tombstone for a real drift bug.
export const ARCHIVE_VISIBLE_PREDICATE = `
  tiles.archived_at IS NOT NULL
  AND tiles.status = 'done'
  AND tiles.ext IS NOT NULL
  AND tiles.mime IS NOT NULL
  AND tiles.completed_at IS NOT NULL`;
