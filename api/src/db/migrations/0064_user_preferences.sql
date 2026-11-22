-- Per-user preferences that are not per model. `condense_prompts` is the
-- "Condense long prompts" switch for Krea rows: NULL means on, the default,
-- and only 0 (off) is stored; a row whose setting columns are all NULL is
-- deleted. updated_at is epoch ms.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  condense_prompts INTEGER CHECK (condense_prompts IN (0, 1)),
  updated_at       INTEGER NOT NULL
);
