ALTER TABLE task_item ADD COLUMN review_status TEXT CHECK (review_status IN ('pass', 'reject'));
ALTER TABLE task_item ADD COLUMN review_agent_id TEXT;
ALTER TABLE task_item ADD COLUMN review_note TEXT;
ALTER TABLE task_item ADD COLUMN reviewed_at TEXT;
ALTER TABLE task_item ADD COLUMN verify_status TEXT CHECK (verify_status IN ('pass', 'reject'));
ALTER TABLE task_item ADD COLUMN verify_agent_id TEXT;
ALTER TABLE task_item ADD COLUMN verify_note TEXT;
ALTER TABLE task_item ADD COLUMN verified_at TEXT;
