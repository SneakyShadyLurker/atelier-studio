-- Covering index for the `tiles JOIN batches ON id = batch_id` lookup in
-- COLLECTION_WITH_COUNTS_SELECT (api/src/routes/collections.ts) and
-- librarySummary's archived-counts aggregate. Both compute per-collection
-- archived tile counts on every GET /api/collections (polled by the web
-- client) and walk every archived tile of every batch the user owns, then
-- chase `batches.id -> batches.collection_id` for each row to group by
-- collection. Without this index that lookup is a primary-key fetch into
-- the batches B-tree per row; with it the join becomes index-only for the
-- `collection_id` lookup we actually need.
--
-- Partial index keyed on `collection_id IS NOT NULL` keeps the index
-- compact — `unsorted` batches (no collection) are not joined back to a
-- collection row in the archived_counts subquery, so they don't need to
-- live in this index.

CREATE INDEX IF NOT EXISTS idx_batches_id_collection
  ON batches(id, collection_id)
  WHERE collection_id IS NOT NULL;
