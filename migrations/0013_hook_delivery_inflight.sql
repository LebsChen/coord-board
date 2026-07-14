PRAGMA foreign_keys = OFF;

CREATE TABLE hook_delivery_new (
  id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('post', 'failure')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (hook_id) REFERENCES hook(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);

INSERT INTO hook_delivery_new
  (id, hook_id, project_id, event_type, phase, payload_json, status, attempt_count,
   next_attempt_at, last_error, created_at, updated_at)
SELECT id, hook_id, project_id, event_type, phase, payload_json, status, attempt_count,
  next_attempt_at, last_error, created_at, updated_at
FROM hook_delivery;

DROP TABLE hook_delivery;
ALTER TABLE hook_delivery_new RENAME TO hook_delivery;

CREATE INDEX idx_hook_delivery_pending
  ON hook_delivery(status, next_attempt_at, created_at);
CREATE INDEX idx_hook_delivery_project
  ON hook_delivery(project_id, status, created_at);

PRAGMA foreign_keys = ON;
