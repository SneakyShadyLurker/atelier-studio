-- idx_tiles_user_archived_done (migration 0009) is a strict column-prefix
-- subset of idx_tiles_user_archived_seek (migration 0010): both carry the
-- identical partial-WHERE clause (status='done' AND archived_at IS NOT NULL)
-- and _seek leads with the same (user_id, archived_at DESC) columns. _seek
-- serves every query _done serves (EXPLAIN QUERY PLAN verified: the archive
-- COUNT(*) resolves to a COVERING INDEX scan on _seek when _done is absent).
-- _done therefore contributes zero read benefit and pure write cost on the
-- hottest write path. Drop it. Precedent: 0012 dropped idx_tiles_user_status
-- for the same "defined-but-superseded" reason.
DROP INDEX IF EXISTS idx_tiles_user_archived_done;
