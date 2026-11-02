CREATE TABLE video_sequences (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  master_status     TEXT NOT NULL DEFAULT 'idle'
    CHECK (master_status IN ('idle', 'stitching', 'ready', 'failed')),
  master_error      TEXT,
  master_updated_at INTEGER,
  stitch_revision   INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE batches
  ADD COLUMN sequence_id TEXT REFERENCES video_sequences(id) ON DELETE SET NULL;

ALTER TABLE batches
  ADD COLUMN sequence_index INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_sequence_index
  ON batches(sequence_id, sequence_index)
  WHERE sequence_id IS NOT NULL;

ALTER TABLE uploads
  ADD COLUMN source_tile_id TEXT;
