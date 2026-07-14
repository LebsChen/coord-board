CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sender_agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'broadcast')),
  subject TEXT,
  payload_json TEXT NOT NULL DEFAULT '',
  reply_to TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (sender_agent_id) REFERENCES agent(id),
  FOREIGN KEY (reply_to) REFERENCES message(id)
);

CREATE TABLE IF NOT EXISTS message_delivery (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread'
    CHECK (status IN ('unread', 'seen', 'acked', 'nacked', 'dead')),
  seen_at TEXT,
  acked_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (message_id, recipient_agent_id),
  FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_agent_id) REFERENCES agent(id)
);

CREATE INDEX IF NOT EXISTS idx_message_project_created
  ON message(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_sender_created
  ON message(sender_agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_recipient_status
  ON message_delivery(recipient_agent_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_delivery_project_status
  ON message_delivery(project_id, status, updated_at);
