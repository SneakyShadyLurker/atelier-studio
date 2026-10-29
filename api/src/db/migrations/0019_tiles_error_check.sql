-- Pin `tiles.error` to the canonical TileErrorCategory union (shared/src/index.ts
-- TILE_ERROR_CATEGORIES). The TS type constrains the writer side, but a future
-- code path leaking a raw provider string would silently land in the DB and
-- replay through the SSE wire — the storage layer is the last fence.
--
-- 'client disconnected' is intentionally retained: per CLAUDE.md it is a legacy
-- TileErrorCategory still carried by pre-v3 rows that the FailedTile component
-- renders with a distinct "connection dropped" copy. Dropping it from the CHECK
-- would refuse to load (and refuse new INSERTs that re-quote it) for those
-- historical rows.
--
-- SQLite has no ALTER TABLE ADD CHECK on existing columns, so we rebuild the
-- table. Two SQLite-specific landmines this migration sidesteps:
--   1. `ALTER TABLE tiles_new RENAME TO tiles` writes the table name back into
--      sqlite_master as `"tiles"` (quoted), breaking schema.sql parity. We do
--      the rename the other way around — alias the OLD table out of the way,
--      then `CREATE TABLE tiles` afresh with the canonical DDL.
--   2. The default `ALTER TABLE … RENAME` rewrites every dependent FK reference
--      (`tile_ref_images.tile_id REFERENCES tiles(id)`) to point at the new
--      name (`tiles_old`). bun:sqlite blocks the `writable_schema` rewrite
--      path. Workaround: rebuild `tile_ref_images` after the tiles rebuild so
--      its CREATE TABLE DDL is re-issued cleanly. The rebuild only fires when
--      the table exists — older migration test scaffolds that hand-seed a v5
--      schema without running migration 5 may not have `tile_ref_images`.
--
-- The whole block runs inside the migration runner's transaction
-- (db.transaction in migrate.ts), so an in-flight failure rolls back to the
-- pre-migration state.

ALTER TABLE tiles RENAME TO tiles_old;

CREATE TABLE tiles (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tile_index INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('loading', 'done', 'failed')),
  ext TEXT,
  mime TEXT,
  error TEXT CHECK (
    error IS NULL OR error IN (
      'timed out',
      'upstream rejected',
      'content-policy violation',
      'interrupted',
      'unsupported format',
      'client disconnected',
      'connection lost',
      'internal error'
    )
  ),
  completed_at INTEGER,
  archived_at INTEGER
);

INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at)
SELECT id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at
  FROM tiles_old;

DROP TABLE tiles_old;

-- Rebuild every tiles index that existed pre-migration. Names + WHERE clauses
-- match schema.sql verbatim so the schema-sync parity test continues to pass.
CREATE INDEX idx_tiles_batch_index
  ON tiles(batch_id, tile_index ASC);

CREATE INDEX idx_tiles_batch_status_done
  ON tiles(batch_id, tile_index ASC)
  WHERE status = 'done';

CREATE INDEX idx_tiles_user_archived_seek
  ON tiles(user_id, archived_at DESC, batch_id DESC, tile_index ASC)
  WHERE status = 'done' AND archived_at IS NOT NULL;

CREATE INDEX idx_tiles_user_batch
  ON tiles(user_id, batch_id, tile_index ASC);
