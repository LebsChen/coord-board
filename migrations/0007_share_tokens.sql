CREATE TABLE IF NOT EXISTS share_token (
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_share_token_project_expiry
  ON share_token(project_id, expires_at);
