-- Allow prompt-library options to be manual-only at weight 0. Rebuild the
-- table because SQLite cannot alter an existing CHECK constraint in place.
-- The migration runner disables foreign keys around this transaction and
-- separately rebuilds option_tags so its child FK targets the live table.

ALTER TABLE variable_options RENAME TO variable_options_old;

CREATE TABLE variable_options (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id     TEXT NOT NULL REFERENCES variable_lists(id) ON DELETE CASCADE,
  value       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 1 CHECK(weight BETWEEN 0 AND 100)
);

INSERT INTO variable_options (id, user_id, list_id, value, sort_order, created_at, weight)
SELECT id, user_id, list_id, value, sort_order, created_at, weight
  FROM variable_options_old;

DROP TABLE variable_options_old;

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

CREATE INDEX idx_variable_options_list
  ON variable_options(list_id, sort_order);

CREATE INDEX idx_variable_options_user
  ON variable_options(user_id, list_id, sort_order);
