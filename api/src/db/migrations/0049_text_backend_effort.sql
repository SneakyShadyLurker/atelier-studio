ALTER TABLE user_text_backends ADD COLUMN effort TEXT CHECK (
  effort IS NULL OR effort IN ('none','minimal','low','medium','high','xhigh','max')
);
