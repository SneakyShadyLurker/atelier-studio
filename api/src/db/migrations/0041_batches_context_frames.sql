ALTER TABLE batches
  ADD COLUMN context_frames INTEGER NOT NULL DEFAULT 0
  CHECK (context_frames >= 0);
