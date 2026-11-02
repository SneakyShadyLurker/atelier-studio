CREATE TABLE user_text_backends (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workload   TEXT NOT NULL,
  backend    TEXT NOT NULL CHECK(backend IN ('kimi','deepseek-flash','qwen','glm-flash','gpt')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, workload)
);
