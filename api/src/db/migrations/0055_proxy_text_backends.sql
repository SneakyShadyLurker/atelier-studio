CREATE TABLE user_text_backends (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workload   TEXT NOT NULL,
  backend    TEXT NOT NULL CHECK(backend IN ('kimi','mimo','grok','gemini-argon','deepseek-abliterated','glm-abliterated','gpt')),
  updated_at INTEGER NOT NULL,
  effort     TEXT CHECK (
    effort IS NULL OR effort IN ('none','minimal','low','medium','high','xhigh','max')
  ),
  PRIMARY KEY (user_id, workload)
);
