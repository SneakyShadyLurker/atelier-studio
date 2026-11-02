ALTER TABLE tag_dimensions ADD COLUMN description TEXT;

ALTER TABLE dimension_tags
  ADD COLUMN parent_id TEXT REFERENCES dimension_tags(id);

ALTER TABLE option_tags
  ADD COLUMN polarity TEXT NOT NULL DEFAULT 'require'
  CHECK (polarity IN ('require', 'exclude'));

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
