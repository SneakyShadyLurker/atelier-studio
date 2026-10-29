ALTER TABLE tiles ADD COLUMN moderation_reason TEXT CHECK (
  moderation_reason IS NULL OR moderation_reason IN (
    'sexual-age', 'graphic-violence', 'sexual-age-and-violence', 'unavailable'
  )
);
