CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_collections_user_sort
  ON collections(user_id, sort_order, name);

ALTER TABLE batches
  ADD COLUMN collection_id TEXT
  REFERENCES collections(id) ON DELETE SET NULL;

ALTER TABLE batches
  ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_batches_user_collection
  ON batches(user_id, collection_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_batches_user_pinned
  ON batches(user_id, created_at DESC)
  WHERE pinned = 1;
