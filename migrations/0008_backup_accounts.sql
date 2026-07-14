ALTER TABLE project ADD COLUMN failover_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project ADD COLUMN failover_max_replacements INTEGER NOT NULL DEFAULT 4;
ALTER TABLE project ADD COLUMN failover_cooldown_seconds INTEGER NOT NULL DEFAULT 900;
ALTER TABLE project ADD COLUMN failover_stale_grace_seconds INTEGER NOT NULL DEFAULT 600;

CREATE TABLE IF NOT EXISTS backup_account (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role_tag TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL,
  credential_type TEXT NOT NULL CHECK (credential_type IN ('apikey', 'service_user')),
  credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  key_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'reserved', 'active', 'cooldown')),
  cooldown_until TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_backup_account_reservation
  ON backup_account(project_id, role_tag, enabled, status, cooldown_until);
