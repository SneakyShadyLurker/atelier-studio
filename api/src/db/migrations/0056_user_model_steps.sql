-- Per-user base-sampler step overrides for local models. Only overrides are
-- stored; an absent row means the model's `defaultSteps` (comfyui.config.ts).
-- updated_at is epoch ms.
CREATE TABLE IF NOT EXISTS user_model_steps (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id   TEXT NOT NULL,
  steps      INTEGER NOT NULL CHECK (steps BETWEEN 1 AND 100),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, model_id)
);
