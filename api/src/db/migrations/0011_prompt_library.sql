CREATE TABLE IF NOT EXISTS prompt_templates (
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
CREATE INDEX IF NOT EXISTS idx_prompt_templates_user_sort
  ON prompt_templates(user_id, sort_order, name);

CREATE TABLE IF NOT EXISTS variable_lists (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_variable_lists_user_sort
  ON variable_lists(user_id, sort_order, name);

CREATE TABLE IF NOT EXISTS variable_options (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id     TEXT NOT NULL REFERENCES variable_lists(id) ON DELETE CASCADE,
  value       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variable_options_list
  ON variable_options(list_id, sort_order);

CREATE TABLE IF NOT EXISTS tag_dimensions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS dimension_tags (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dimension_id  TEXT NOT NULL REFERENCES tag_dimensions(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (dimension_id, label)
);
CREATE INDEX IF NOT EXISTS idx_dimension_tags_dim
  ON dimension_tags(dimension_id, sort_order);

CREATE TABLE IF NOT EXISTS option_tags (
  option_id  TEXT NOT NULL REFERENCES variable_options(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES dimension_tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (option_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_option_tags_tag ON option_tags(tag_id);
