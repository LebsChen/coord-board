PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO project(id, name, created_at, updated_at)
VALUES ('default', 'Default project', datetime('now'), datetime('now'));

ALTER TABLE agent ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE agent ADD COLUMN token_hash TEXT;
ALTER TABLE agent ADD COLUMN token_issued_at TEXT;
ALTER TABLE agent ADD COLUMN token_revoked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_project ON agent(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_token_hash ON agent(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_name ON project(name);
