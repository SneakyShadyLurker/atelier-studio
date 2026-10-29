CREATE TABLE IF NOT EXISTS keystore_proof (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  ciphertext   BLOB NOT NULL,
  nonce        BLOB NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
