CREATE TABLE stories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('rendering','done','failed','canceled')),
  outline TEXT NOT NULL,
  logline TEXT NOT NULL,
  continuity_bible TEXT NOT NULL,
  ratio TEXT NOT NULL,
  source_upload_id TEXT,
  extends_tile_id TEXT,
  source_prompt TEXT,
  error TEXT,
  eta_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_stories_user ON stories(user_id, created_at DESC);

CREATE TABLE story_segments (
  story_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  beat TEXT NOT NULL,
  duration_frames INTEGER NOT NULL CHECK (duration_frames IN (124,243,362)),
  batch_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (story_id, idx)
);

CREATE INDEX idx_story_segments_batch ON story_segments(batch_id);
