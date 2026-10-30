-- Atelier database schema — cumulative state after migrations 1-56.
-- Reference only (migrate.ts is the runtime source of truth); the version
-- in this header must track BINARY_SCHEMA_VERSION when migrations are added.
--
-- This file is NOT executed at runtime. The migration runner in `migrate.ts`
-- is the source of truth for DB schema; this file exists as a quick reference
-- and to make the schema git-diffable. If migrations diverge from this file,
-- the migrations win — regenerate this file from a migrated DB:
--
--   bun -e 'import { Database } from "bun:sqlite"; import { migrate } from
--     "./api/src/db/migrate"; const db = new Database(":memory:");
--     migrate(db, "/tmp"); for (const r of db.query("SELECT sql FROM
--     sqlite_master WHERE sql IS NOT NULL ORDER BY type, tbl_name, name").all())
--     console.log(r.sql + ";\n");'
--
-- The schema_versions metadata table is created by `migrate()` itself and is
-- omitted from this reference.

-- pool: 'xai' is retired (Grok/xAI removed) but kept in the CHECK list for
-- historical rows — migration 0027 remaps them to 'shared' and nothing emits
-- 'xai' anymore. Tightening the list would require a full FK-referenced rebuild.
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  ratio TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_label TEXT NOT NULL,
  created_at INTEGER NOT NULL
, archived_at INTEGER, collection_id TEXT
  REFERENCES collections(id) ON DELETE SET NULL, pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), status TEXT NOT NULL DEFAULT 'running'
  CHECK (status IN ('queued','running','done')), pool TEXT NOT NULL DEFAULT 'shared'
  CHECK (pool IN ('shared','xai','byok','local')), template_id TEXT REFERENCES prompt_templates(id) ON DELETE SET NULL, roll_seed INTEGER, roll_pins TEXT, i2v_source_upload_id TEXT, motion_prompt TEXT, card_notes TEXT, duration_frames INTEGER
  CHECK (duration_frames IN (124, 243, 362)), sequence_id TEXT
  REFERENCES video_sequences(id) ON DELETE SET NULL, sequence_index INTEGER, context_frames INTEGER NOT NULL DEFAULT 0
  CHECK (context_frames >= 0), started_at INTEGER, idempotency_key TEXT);

CREATE TABLE collections (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE dimension_tags (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dimension_id  TEXT NOT NULL REFERENCES tag_dimensions(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  parent_id     TEXT REFERENCES dimension_tags(id),
  UNIQUE (dimension_id, label)
);

CREATE TABLE keystore_proof (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  ciphertext   BLOB NOT NULL,
  nonce        BLOB NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE option_tags (
  option_id  TEXT NOT NULL REFERENCES variable_options(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES dimension_tags(id)   ON DELETE CASCADE,
  polarity   TEXT NOT NULL DEFAULT 'require' CHECK (polarity IN ('require', 'exclude')),
  PRIMARY KEY (option_id, tag_id)
);

CREATE TABLE prompt_templates (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  notes       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE prompt_library_revisions (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- Binds the database to one storage root recipient (migration 0045).
CREATE TABLE storage_root (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  recipient  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

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

CREATE TABLE tag_dimensions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  description TEXT,
  UNIQUE (user_id, name)
);

CREATE TABLE tile_ref_images (
  tile_id    TEXT NOT NULL REFERENCES tiles(id)   ON DELETE CASCADE,
  upload_id  TEXT NOT NULL REFERENCES uploads(id) ON DELETE RESTRICT,
  position   INTEGER NOT NULL,
  PRIMARY KEY (tile_id, position)
);

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
      'internal error',
      'service unavailable'
    )
  ),
  completed_at INTEGER,
  archived_at INTEGER,
  moderation_reason TEXT CHECK (
    moderation_reason IS NULL OR moderation_reason IN (
      'sexual-age', 'graphic-violence', 'sexual-age-and-violence', 'unavailable'
    )
  ),
  moderation_categories TEXT CHECK (
    moderation_categories IS NULL OR (
      json_valid(moderation_categories) AND json_type(moderation_categories) = 'array'
    )
  )
);

CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ext          TEXT NOT NULL CHECK (ext IN ('png','webp','jpg')),
  mime         TEXT NOT NULL CHECK (mime IN ('image/png','image/webp','image/jpeg')),
  size_bytes   INTEGER NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  source_tile_id TEXT
);

CREATE TABLE video_sequences (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  master_status     TEXT NOT NULL DEFAULT 'idle'
    CHECK (master_status IN ('idle', 'stitching', 'ready', 'failed')),
  master_error      TEXT,
  master_updated_at INTEGER,
  stitch_revision   INTEGER NOT NULL DEFAULT 0,
  master_revision   INTEGER,
  stitch_pending    INTEGER NOT NULL DEFAULT 0 CHECK (stitch_pending IN (0, 1))
);

CREATE TABLE user_provider_keys (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('google')),
  ciphertext   BLOB NOT NULL,
  nonce        BLOB NOT NULL,
  key_version  INTEGER NOT NULL,
  fingerprint  TEXT NOT NULL,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Per-user artifact encryption keys (migration 0045): the user's age
-- recipient and identity encrypted to the storage root. Deleting a user
-- cascades here, which crypto-shreds their artifacts.
CREATE TABLE user_storage_keys (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  recipient        TEXT NOT NULL,
  wrapped_identity BLOB NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE user_text_backends (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workload   TEXT NOT NULL,
  backend    TEXT NOT NULL CHECK(backend IN ('kimi','mimo','grok','gemini-argon','deepseek-abliterated','glm-abliterated','gpt')),
  updated_at INTEGER NOT NULL,
  effort     TEXT CHECK (
    effort IS NULL OR effort IN ('none','minimal','low','medium','high','xhigh','max')
  ),
  PRIMARY KEY (user_id, workload)
);

-- Per-user base-sampler step overrides for local models (v56). Only overrides
-- are stored; an absent row means the model's `defaultSteps`. updated_at is
-- epoch ms.
CREATE TABLE user_model_steps (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id   TEXT NOT NULL,
  steps      INTEGER NOT NULL CHECK (steps BETWEEN 1 AND 100),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, model_id)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  cache_scope TEXT
);

CREATE UNIQUE INDEX idx_users_cache_scope
  ON users(cache_scope)
  WHERE cache_scope IS NOT NULL;

-- Rows are keyed on batches.rowid by the batches_a[idu]_prompt_fts triggers
-- below. batches has a TEXT primary key, so its hidden rowid is mutable: a
-- VACUUM renumbers it and silently desyncs this index (search/delete then hit
-- the wrong batch). A plain FTS5 'rebuild' does NOT re-key it. After any VACUUM,
-- re-sync per docs/deployment.md § WAL grows unexpectedly (DELETE + INSERT…SELECT rowid FROM batches).
CREATE VIRTUAL TABLE batch_prompt_fts USING fts5(
  user_id UNINDEXED,
  batch_id UNINDEXED,
  prompt,
  tokenize = 'trigram'
);

CREATE TABLE variable_lists (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE variable_options (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id     TEXT NOT NULL REFERENCES variable_lists(id) ON DELETE CASCADE,
  value       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 1 CHECK(weight BETWEEN 0 AND 100)
);

CREATE INDEX idx_batches_id_collection
  ON batches(id, collection_id)
  WHERE collection_id IS NOT NULL;

CREATE INDEX idx_batches_user_archived ON batches(user_id, archived_at);

CREATE INDEX idx_batches_queue ON batches(pool, created_at, id) WHERE status='queued';

CREATE INDEX idx_batches_user_collection
  ON batches(user_id, collection_id, created_at DESC, id DESC);

CREATE INDEX idx_batches_user_created
  ON batches(user_id, created_at DESC, id DESC);

CREATE INDEX idx_batches_user_pinned
  ON batches(user_id, created_at DESC, id DESC)
  WHERE pinned = 1;

CREATE INDEX idx_batches_user_queued ON batches(user_id) WHERE status='queued';

CREATE UNIQUE INDEX idx_batches_idempotency_key
  ON batches(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX idx_batches_sequence_index
  ON batches(sequence_id, sequence_index)
  WHERE sequence_id IS NOT NULL;

CREATE INDEX idx_batches_i2v_source_upload
  ON batches(i2v_source_upload_id)
  WHERE i2v_source_upload_id IS NOT NULL;

CREATE INDEX idx_collections_user_sort
  ON collections(user_id, sort_order, name);

CREATE INDEX idx_dimension_tags_dim
  ON dimension_tags(dimension_id, sort_order);

CREATE INDEX idx_dimension_tags_user_dim_sort_label
  ON dimension_tags(user_id, dimension_id, sort_order, label);

CREATE INDEX idx_dimension_tags_user_id
  ON dimension_tags(user_id, id);

CREATE INDEX idx_option_tags_tag ON option_tags(tag_id);

CREATE INDEX idx_prompt_templates_user_sort
  ON prompt_templates(user_id, sort_order, name);

CREATE INDEX idx_stories_user ON stories(user_id, created_at DESC);
CREATE INDEX idx_stories_rendering_source_upload ON stories(source_upload_id) WHERE status = 'rendering';

CREATE INDEX idx_story_segments_batch ON story_segments(batch_id);

CREATE INDEX idx_tile_ref_images_upload
  ON tile_ref_images(upload_id);

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


CREATE INDEX idx_uploads_user_created
  ON uploads(user_id, created_at DESC);

CREATE INDEX idx_uploads_user_sha256
  ON uploads(user_id, sha256);

CREATE TRIGGER batches_ad_prompt_fts
AFTER DELETE ON batches
BEGIN
  DELETE FROM batch_prompt_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER batches_ai_prompt_fts
AFTER INSERT ON batches
WHEN new.archived_at IS NULL
BEGIN
  INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
  VALUES (new.rowid, new.user_id, new.id, new.prompt);
END;

CREATE TRIGGER batches_au_prompt_fts
AFTER UPDATE OF user_id, id, prompt, archived_at ON batches
BEGIN
  DELETE FROM batch_prompt_fts WHERE rowid = old.rowid;
  INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt)
  SELECT new.rowid, new.user_id, new.id, new.prompt
  WHERE new.archived_at IS NULL;
END;

CREATE TRIGGER dimension_tags_ad_revision
AFTER DELETE ON dimension_tags
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER dimension_tags_ai_revision
AFTER INSERT ON dimension_tags
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER dimension_tags_au_revision
AFTER UPDATE ON dimension_tags
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER option_tags_ad_revision
AFTER DELETE ON option_tags
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  SELECT o.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM variable_options o
   WHERE o.id = old.option_id
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER option_tags_ai_revision
AFTER INSERT ON option_tags
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  SELECT o.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM variable_options o
   WHERE o.id = new.option_id
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER option_tags_au_revision
AFTER UPDATE OF polarity ON option_tags
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  SELECT o.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM variable_options o
   WHERE o.id = new.option_id
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;


CREATE TRIGGER prompt_templates_ad_revision
AFTER DELETE ON prompt_templates
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER prompt_templates_ai_revision
AFTER INSERT ON prompt_templates
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER prompt_templates_au_revision
AFTER UPDATE ON prompt_templates
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER tag_dimensions_ad_revision
AFTER DELETE ON tag_dimensions
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER tag_dimensions_ai_revision
AFTER INSERT ON tag_dimensions
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER tag_dimensions_au_revision
AFTER UPDATE ON tag_dimensions
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER variable_lists_ad_revision
AFTER DELETE ON variable_lists
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER variable_lists_ai_revision
AFTER INSERT ON variable_lists
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER variable_lists_au_revision
AFTER UPDATE ON variable_lists
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER variable_options_ad_revision
AFTER DELETE ON variable_options
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER variable_options_ai_revision
AFTER INSERT ON variable_options
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER variable_options_au_revision
AFTER UPDATE ON variable_options
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE INDEX idx_variable_lists_user_sort
  ON variable_lists(user_id, sort_order, name);

CREATE INDEX idx_variable_options_list
  ON variable_options(list_id, sort_order);

CREATE INDEX idx_variable_options_user
  ON variable_options(user_id, list_id, sort_order);
