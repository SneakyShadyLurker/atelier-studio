-- Composite index leading with user_id for optionsGroupedByList
-- (api/src/routes/prompts/_shared.ts), which selects every option a user owns
-- with `WHERE o.user_id = ?` and no list_id filter on each full prompt-library
-- snapshot load (GET /api/prompts, /infer, /apply, /rescue). The only prior
-- index on variable_options leads with list_id (idx_variable_options_list), so
-- the user-scoped scan could not index-seek the driving table. This index lets
-- that load seek on user_id while still satisfying the existing
-- list_id/sort_order ordering for per-list reads.

CREATE INDEX IF NOT EXISTS idx_variable_options_user
  ON variable_options(user_id, list_id, sort_order);
