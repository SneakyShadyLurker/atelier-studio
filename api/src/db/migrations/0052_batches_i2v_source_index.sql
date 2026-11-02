-- "Is this upload still referenced?" (SQL_UPLOAD_UNREFERENCED) probes
-- batches.i2v_source_upload_id once per upload; without an index every probe
-- scans batches. Partial: most batches carry no I2V source, and the equality
-- predicate implies NOT NULL, so the planner can use it.
CREATE INDEX IF NOT EXISTS idx_batches_i2v_source_upload
  ON batches(i2v_source_upload_id)
  WHERE i2v_source_upload_id IS NOT NULL;
