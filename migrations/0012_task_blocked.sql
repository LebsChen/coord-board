ALTER TABLE task_item ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_task_board_blocked
  ON task_item(board_id, blocked, phase, deleted_at);
