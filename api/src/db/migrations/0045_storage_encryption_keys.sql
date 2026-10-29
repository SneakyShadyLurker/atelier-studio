-- Per-user at-rest artifact encryption (docs/runbook.md § Artifact encryption).
-- storage_root binds this database to one root recipient; user_storage_keys
-- holds each user's age recipient and their identity encrypted to that root.
CREATE TABLE IF NOT EXISTS storage_root (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  recipient  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_storage_keys (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  recipient        TEXT NOT NULL,
  wrapped_identity BLOB NOT NULL,
  created_at       INTEGER NOT NULL
);
