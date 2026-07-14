PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS task_item (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'pending'
    CHECK (phase IN ('pending', 'ready', 'in_progress', 'done')),
  priority INTEGER NOT NULL DEFAULT 5,
  assignee_agent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (assignee_agent_id) REFERENCES agent(id)
);

CREATE TABLE IF NOT EXISTS task_dependency (
  task_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id),
  FOREIGN KEY (task_id) REFERENCES task_item(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id) REFERENCES task_item(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_session (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  disconnected_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (agent_id) REFERENCES agent(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_event (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  actor_agent_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task_item(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_agent_id) REFERENCES agent(id)
);

CREATE TABLE IF NOT EXISTS idempotency_key (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_task_board_phase ON task_item(board_id, phase, deleted_at);
CREATE INDEX IF NOT EXISTS idx_task_board_order ON task_item(board_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_dependency_depends_on ON task_dependency(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_task_event_task ON task_event(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_status ON agent(status, last_seen_at);
