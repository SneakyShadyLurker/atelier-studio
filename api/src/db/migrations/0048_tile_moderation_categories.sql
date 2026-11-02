ALTER TABLE tiles ADD COLUMN moderation_categories TEXT CHECK (
  moderation_categories IS NULL OR (
    json_valid(moderation_categories) AND json_type(moderation_categories) = 'array'
  )
);
