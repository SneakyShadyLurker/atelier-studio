-- What the content pre-check blocks on a screened text model: 'full' asks
-- about nudity, minors and graphic violence; 'minors' asks only about sexual
-- content involving minors or unestablished ages. Existing rows keep 'full'.
ALTER TABLE text_models ADD COLUMN screen_policy TEXT NOT NULL DEFAULT 'full'
  CHECK (screen_policy IN ('full', 'minors'));
