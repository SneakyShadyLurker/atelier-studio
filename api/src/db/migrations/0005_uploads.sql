CREATE TABLE IF NOT EXISTS uploads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ext          TEXT NOT NULL CHECK (ext IN ('png','webp','jpg')),
  mime         TEXT NOT NULL CHECK (mime IN ('image/png','image/webp','image/jpeg')),
  size_bytes   INTEGER NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_user_created
  ON uploads(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_uploads_user_sha256
  ON uploads(user_id, sha256);

CREATE TABLE IF NOT EXISTS tile_ref_images (
  tile_id    TEXT NOT NULL REFERENCES tiles(id)   ON DELETE CASCADE,
  upload_id  TEXT NOT NULL REFERENCES uploads(id) ON DELETE RESTRICT,
  position   INTEGER NOT NULL,
  PRIMARY KEY (tile_id, position)
);

CREATE INDEX IF NOT EXISTS idx_tile_ref_images_upload
  ON tile_ref_images(upload_id);
