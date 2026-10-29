CREATE TABLE IF NOT EXISTS prompt_library_revisions (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dimension_tags_user_id
  ON dimension_tags(user_id, id);

CREATE INDEX IF NOT EXISTS idx_dimension_tags_user_dim_sort_label
  ON dimension_tags(user_id, dimension_id, sort_order, label);

CREATE TRIGGER IF NOT EXISTS prompt_templates_ai_revision
AFTER INSERT ON prompt_templates
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS prompt_templates_au_revision
AFTER UPDATE ON prompt_templates
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS prompt_templates_ad_revision
AFTER DELETE ON prompt_templates
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS variable_lists_ai_revision
AFTER INSERT ON variable_lists
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS variable_lists_au_revision
AFTER UPDATE ON variable_lists
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS variable_lists_ad_revision
AFTER DELETE ON variable_lists
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS variable_options_ai_revision
AFTER INSERT ON variable_options
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS variable_options_au_revision
AFTER UPDATE ON variable_options
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS variable_options_ad_revision
AFTER DELETE ON variable_options
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS tag_dimensions_ai_revision
AFTER INSERT ON tag_dimensions
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS tag_dimensions_au_revision
AFTER UPDATE ON tag_dimensions
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS tag_dimensions_ad_revision
AFTER DELETE ON tag_dimensions
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS dimension_tags_ai_revision
AFTER INSERT ON dimension_tags
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS dimension_tags_au_revision
AFTER UPDATE ON dimension_tags
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (new.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS dimension_tags_ad_revision
AFTER DELETE ON dimension_tags
BEGIN
  INSERT INTO prompt_library_revisions (user_id, revision, updated_at)
  VALUES (old.user_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = prompt_library_revisions.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS option_tags_ai_revision
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

CREATE TRIGGER IF NOT EXISTS option_tags_ad_revision
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
