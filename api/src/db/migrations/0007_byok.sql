CREATE TABLE IF NOT EXISTS user_provider_keys (
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
