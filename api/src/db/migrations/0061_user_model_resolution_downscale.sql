-- Per-user "Downsize to 2K" switch for local rows that deliver a reduced
-- image (`outputLongEdge`). NULL means the default (on); only 0 (off) is
-- stored, and a row whose three setting columns are NULL is deleted.
ALTER TABLE user_model_resolution ADD COLUMN downscale INTEGER CHECK (downscale IN (0, 1));
