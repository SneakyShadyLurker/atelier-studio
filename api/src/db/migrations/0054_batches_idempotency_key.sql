-- Client-supplied identity of one logical roll per user (POST /api/generate
-- idempotencyKey). A re-POST with a known key replays the existing batch
-- instead of creating a second one. NULL for keyless submissions (Re-roll,
-- Retry, stories), which never dedupe; the partial index keeps them out.
ALTER TABLE batches ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_idempotency_key
  ON batches(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
