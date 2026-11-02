-- NULL deliberately makes existing masters recover once: their publication
-- revision cannot be inferred from the current topology revision.
ALTER TABLE video_sequences ADD COLUMN master_revision INTEGER;
-- Queue intent is independent of the currently playable publication.
ALTER TABLE video_sequences ADD COLUMN stitch_pending INTEGER NOT NULL DEFAULT 0 CHECK (stitch_pending IN (0, 1));
