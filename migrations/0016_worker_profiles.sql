CREATE TABLE IF NOT EXISTS worker_profile (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role_tag TEXT NOT NULL,
  model TEXT,
  snapshot_id TEXT,
  system_prompt TEXT,
  prompt_template TEXT,
  playbook_refs_json TEXT NOT NULL DEFAULT '[]',
  knowledge_refs_json TEXT NOT NULL DEFAULT '[]',
  mcp_tools_json TEXT NOT NULL DEFAULT '[]',
  repo_config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_worker_profile_project
  ON worker_profile(project_id, role_tag, enabled);

ALTER TABLE task_item ADD COLUMN worker_profile_id TEXT;
ALTER TABLE task_item ADD COLUMN spawn_status TEXT
  CHECK (spawn_status IN ('requested', 'spawning', 'spawned', 'failed'));

CREATE INDEX IF NOT EXISTS idx_task_spawn
  ON task_item(spawn_status, phase, board_id);
