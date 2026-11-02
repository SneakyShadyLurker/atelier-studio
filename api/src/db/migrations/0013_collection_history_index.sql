-- Collection-filtered history query performance (audit 2026-05-22).
--
-- idx_batches_user_collection lacked the id DESC tie-breaker, so the planner
-- preferred idx_batches_user_created for GET /api/history?collectionId=...
-- and post-scanned every batch the user owns rather than pay a TEMP B-TREE
-- sort. Adding id DESC lets one index both filter collection_id and satisfy
-- the keyset ORDER BY created_at DESC, id DESC.

DROP INDEX IF EXISTS idx_batches_user_collection;
CREATE INDEX IF NOT EXISTS idx_batches_user_collection
  ON batches(user_id, collection_id, created_at DESC, id DESC);
