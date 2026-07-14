ALTER TABLE task_item ADD COLUMN required_gates TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS task_gate (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  gate_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed')),
  by_agent TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, gate_name),
  FOREIGN KEY (task_id) REFERENCES task_item(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_gate_task ON task_gate(task_id, status);

CREATE TABLE IF NOT EXISTS agent_event (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agent(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_event_project ON agent_event(project_id, created_at);

CREATE TABLE IF NOT EXISTS hook (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT,
  phase TEXT NOT NULL DEFAULT 'post' CHECK (phase IN ('post', 'failure')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hook_project_phase ON hook(project_id, phase, active);
