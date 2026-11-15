-- Shared reasoning effort (2026-11-15): the default model, each task
-- assignment and each prompt writer may carry one. NULL means none: the
-- model's own default applies. Existing rows migrate with none.
ALTER TABLE text_defaults ADD COLUMN effort TEXT CHECK (
  effort IS NULL OR effort IN ('none','minimal','low','medium','high','xhigh','max')
);
ALTER TABLE image_model_writers ADD COLUMN effort TEXT CHECK (
  effort IS NULL OR effort IN ('none','minimal','low','medium','high','xhigh','max')
);
