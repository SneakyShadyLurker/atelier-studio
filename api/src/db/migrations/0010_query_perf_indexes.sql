-- Query-performance indexes surfaced by audit pass 3.
--
-- Keep archive/history seek indexes aligned with their keyset ORDER BY terms.

DROP INDEX IF EXISTS idx_tiles_user_archived;

DROP INDEX IF EXISTS idx_batches_user_pinned;
CREATE INDEX IF NOT EXISTS idx_batches_user_pinned
  ON batches(user_id, created_at DESC, id DESC)
  WHERE pinned = 1;

DROP INDEX IF EXISTS idx_tiles_user_batch;
CREATE INDEX IF NOT EXISTS idx_tiles_user_batch
  ON tiles(user_id, batch_id, tile_index ASC);

-- Covers the full archive ORDER BY (archived_at DESC, batch_id DESC,
-- tile_index ASC) on the tiles table alone so the keyset list has no
-- cross-table TEMP B-TREE while preserving intra-batch tile_index order.
CREATE INDEX IF NOT EXISTS idx_tiles_user_archived_seek
  ON tiles(user_id, archived_at DESC, batch_id DESC, tile_index ASC)
  WHERE status = 'done' AND archived_at IS NOT NULL;
