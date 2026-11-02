ALTER TABLE batches
  ADD COLUMN duration_frames INTEGER
  CHECK (duration_frames IN (124, 243, 362));
