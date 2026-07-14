CREATE TABLE IF NOT EXISTS hook_delivery (
  id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('post', 'failure')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (hook_id) REFERENCES hook(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hook_delivery_pending
  ON hook_delivery(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_hook_delivery_project
  ON hook_delivery(project_id, status, created_at);
