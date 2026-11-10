-- Per-user render-size overrides for local rows that offer them, one column
-- per mode (text-to-image, with reference pictures). Only overrides are
-- stored: NULL means the row's default for that mode, and a row with both
-- columns NULL is deleted. updated_at is epoch ms.
CREATE TABLE IF NOT EXISTS user_model_resolution (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  text_to_image TEXT CHECK (text_to_image IN ('4mp', '8mp', '16mp')),
  reference     TEXT CHECK (reference IN ('4mp', '8mp', '16mp')),
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, model_id)
);
