-- Archive read path surfaced by audit 04-data.
--
-- `GET /api/archive` (list + COUNT(*)) and the six archived-count scalars run
-- on every `GET /api/collections` filter `tiles JOIN batches` by
-- `user_id` + `archived_at IS NOT NULL` + `status = 'done'`, ordered by
-- `archived_at DESC`. None of the migration 1-8 indexes cover that:
-- `idx_tiles_user_archived` leads with `(user_id, archived_at)` but carries no
-- `status`, so every candidate row triggers a table lookup for the predicate
-- plus a `batches` join — a full per-user archived-tile scan on hot,
-- frequently-polled endpoints. This partial index is keyed for the exact
-- archive scope/sort and stays small (only archived done rows).

CREATE INDEX IF NOT EXISTS idx_tiles_user_archived_done
  ON tiles(user_id, archived_at DESC)
  WHERE status = 'done' AND archived_at IS NOT NULL;
