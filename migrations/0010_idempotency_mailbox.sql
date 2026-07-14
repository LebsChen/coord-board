ALTER TABLE message ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_project_idempotency
  ON message(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
