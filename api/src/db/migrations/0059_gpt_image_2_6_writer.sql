-- CLIProxyAPI retired the GPT Image 2.5 family; the cloud image model is now
-- gpt-image-2.6-sunburst. Move the prompt-writer assignment (the GPT-6.1 Sol
-- lock) to the new id so routing keeps applying it. A row already on the new
-- id wins; the retired row is dropped either way. Batch history keeps its
-- original model_id on purpose.
UPDATE OR IGNORE image_model_writers
  SET image_model_id = 'gpt-image-2.6-sunburst'
  WHERE image_model_id = 'gpt-image-2.5-sunburst';
DELETE FROM image_model_writers WHERE image_model_id = 'gpt-image-2.5-sunburst';
