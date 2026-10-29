-- idx_tiles_user_status(user_id, status) was created in migration 1 and is
-- consulted by zero queries (EXPLAIN QUERY PLAN verified): every status-
-- predicated read routes to the more specific idx_tiles_user_batch /
-- idx_tiles_user_archived_* / PK autoindex, or is the boot-only reconcile
-- SCAN. It is pure write-amplification on the hottest write path (every tile
-- INSERT + every loading->done/failed UPDATE). Drop it. Precedent: 0010
-- dropped idx_tiles_user_archived / idx_batches_user_pinned for the same
-- "defined-but-superseded" reason.
DROP INDEX IF EXISTS idx_tiles_user_status;
