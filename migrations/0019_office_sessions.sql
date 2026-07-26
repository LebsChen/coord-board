CREATE TABLE IF NOT EXISTS office_bootstrap (
  code_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_office_bootstrap_expiry
  ON office_bootstrap(project_id, expires_at);

CREATE TABLE IF NOT EXISTS office_session (
  session_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_office_session_expiry
  ON office_session(project_id, expires_at);
