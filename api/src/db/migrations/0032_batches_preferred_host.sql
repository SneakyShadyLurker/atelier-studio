ALTER TABLE batches
  ADD COLUMN preferred_host TEXT
  CHECK (preferred_host IN ('direct', 'pod'));
