-- Tile-scope read patterns surfaced by audit 04-data.
--
-- `idx_tiles_user_batch` covers `fetchTilesForBatches` in routes/history.ts —
-- bulk-load tiles for N batches in one user's history page. Without it the
-- planner falls back to `idx_tiles_user_status` (which leads with `user_id`)
-- and post-filters by `batch_id IN (…)`, scanning every tile that user owns.
--
-- `idx_tiles_batch_status_done` is a partial index supporting `batchTilesDone`
-- (`WHERE batch_id = ? AND status = 'done'`) — called once per batch at
-- stream tear-down to decide whether to emit the `done` SSE event. Partial
-- on `status = 'done'` keeps the index tiny (only finished tiles); the
-- planner can satisfy the COUNT(*) by index-only scan.

CREATE INDEX IF NOT EXISTS idx_tiles_user_batch
  ON tiles(user_id, batch_id);

CREATE INDEX IF NOT EXISTS idx_tiles_batch_status_done
  ON tiles(batch_id, tile_index ASC)
  WHERE status = 'done';
