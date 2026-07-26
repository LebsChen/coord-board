ALTER TABLE task_item ADD COLUMN epic TEXT NOT NULL DEFAULT '';
ALTER TABLE task_item ADD COLUMN user_story TEXT NOT NULL DEFAULT '';
ALTER TABLE task_item ADD COLUMN risk TEXT NOT NULL DEFAULT 'low';
ALTER TABLE task_item ADD COLUMN readiness_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE task_item ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_task_epic ON task_item(board_id, epic, user_story);
