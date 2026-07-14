CREATE TABLE IF NOT EXISTS account_claim (
  project_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  role_tag TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'released')),
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, account_ref),
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_claim_live
  ON account_claim(project_id, status, expires_at);
