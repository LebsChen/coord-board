CREATE INDEX IF NOT EXISTS idx_message_delivery_recipient_updated
  ON message_delivery(recipient_agent_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_message_created_desc
  ON message(created_at DESC, id DESC);
