CREATE INDEX IF NOT EXISTS idx_stories_rendering_source_upload
  ON stories(source_upload_id)
  WHERE status = 'rendering';
