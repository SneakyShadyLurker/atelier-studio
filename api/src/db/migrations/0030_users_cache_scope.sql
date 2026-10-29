ALTER TABLE users ADD COLUMN cache_scope TEXT;

CREATE UNIQUE INDEX idx_users_cache_scope
  ON users(cache_scope)
  WHERE cache_scope IS NOT NULL;
