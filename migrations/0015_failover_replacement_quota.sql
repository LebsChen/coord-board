CREATE TABLE IF NOT EXISTS failover_replacement (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  replacement_agent_id TEXT,
  backup_account_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'created', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES task_item(id) ON DELETE CASCADE,
  FOREIGN KEY (replacement_agent_id) REFERENCES agent(id) ON DELETE SET NULL,
  FOREIGN KEY (backup_account_id) REFERENCES backup_account(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_failover_replacement_project_created
  ON failover_replacement(project_id, status, created_at);
