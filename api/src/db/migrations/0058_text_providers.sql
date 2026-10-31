-- Admin-managed text providers and models (replace the fixed text backends).
-- Ids are UUIDs minted in the API; timestamps are epoch ms. The task lists in
-- the CHECKs mirror TEXT_TASKS (@atelier/shared); migrate.text.test.ts pins
-- them. The function migration seeds and carries pins after these run.
CREATE TABLE IF NOT EXISTS text_providers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  protocol           TEXT NOT NULL CHECK (protocol IN ('openai-compatible', 'anthropic')),
  base_url           TEXT NOT NULL,
  preset             TEXT,
  auth_mode          TEXT NOT NULL CHECK (auth_mode IN ('none', 'stored', 'env')),
  credential_env     TEXT,
  secret_ciphertext  BLOB,
  secret_nonce       BLOB,
  secret_key_version INTEGER,
  secret_fingerprint TEXT,
  token_field        TEXT NOT NULL DEFAULT 'max_completion_tokens'
    CHECK (token_field IN ('max_completion_tokens', 'max_tokens')),
  list_models        INTEGER NOT NULL DEFAULT 1 CHECK (list_models IN (0, 1)),
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK ((auth_mode = 'stored') = (secret_ciphertext IS NOT NULL)),
  CHECK ((auth_mode = 'env') = (credential_env IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS text_models (
  id                  TEXT PRIMARY KEY,
  provider_id         TEXT NOT NULL REFERENCES text_providers(id) ON DELETE CASCADE,
  model_id            TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  legacy_key          TEXT UNIQUE,
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  vision              INTEGER NOT NULL DEFAULT 0 CHECK (vision IN (0, 1)),
  max_images          INTEGER CHECK (max_images > 0),
  structured_output   TEXT NOT NULL DEFAULT 'json_object'
    CHECK (structured_output IN ('json_schema', 'json_object', 'none')),
  reasoning_levels    TEXT NOT NULL DEFAULT '[]' CHECK (json_type(reasoning_levels) = 'array'),
  reasoning_default   TEXT
    CHECK (reasoning_default IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
  temperature         REAL CHECK (temperature BETWEEN 0 AND 2),
  top_p               REAL CHECK (top_p BETWEEN 0 AND 1),
  fixed_output_tokens INTEGER CHECK (fixed_output_tokens > 0),
  latency_profile     TEXT NOT NULL DEFAULT 'standard' CHECK (latency_profile IN ('standard', 'slow')),
  prompt_variant      TEXT NOT NULL DEFAULT 'generic' CHECK (prompt_variant IN ('generic', 'kimi')),
  screen_requests     INTEGER NOT NULL DEFAULT 0 CHECK (screen_requests IN (0, 1)),
  verified_at         INTEGER,
  probe_json          TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Not unique: each row is a settings profile, so two rows on one provider may
-- name the same upstream model (legacy slots aliased to one id, or two profiles).
CREATE INDEX IF NOT EXISTS idx_text_models_provider ON text_models(provider_id, model_id);

CREATE TABLE IF NOT EXISTS text_defaults (
  scope         TEXT PRIMARY KEY CHECK (scope IN (
    'default', 'enhance', 'motion', 'ai-fill', 'brainstorm', 'condense', 'storytelling',
    'story-segments', 'infer', 'rescue', 'list-draft', 'template-draft'
  )),
  text_model_id TEXT NOT NULL REFERENCES text_models(id) ON DELETE CASCADE,
  updated_at    INTEGER NOT NULL
);

-- image_model_id is a registry id (code, not a table), so it carries no FK.
CREATE TABLE IF NOT EXISTS image_model_writers (
  image_model_id TEXT PRIMARY KEY,
  text_model_id  TEXT NOT NULL REFERENCES text_models(id) ON DELETE CASCADE,
  mode           TEXT NOT NULL CHECK (mode IN ('lock', 'prefer')),
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_text_models (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task          TEXT NOT NULL CHECK (task IN (
    'enhance', 'motion', 'ai-fill', 'brainstorm', 'condense', 'storytelling',
    'story-segments', 'infer', 'rescue', 'list-draft', 'template-draft'
  )),
  text_model_id TEXT NOT NULL REFERENCES text_models(id) ON DELETE CASCADE,
  effort        TEXT CHECK (effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, task)
);

CREATE INDEX IF NOT EXISTS idx_user_text_models_model ON user_text_models(text_model_id);
