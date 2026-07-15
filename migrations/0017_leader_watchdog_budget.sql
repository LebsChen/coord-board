-- M2/M3/M4: leader linkage, watchdog escalation state, and spawn budget breaker.

-- M2: link a project to its Cloud-Dev leader agent (role=lead).
ALTER TABLE project ADD COLUMN leader_agent_id TEXT;

-- M3: cumulative spawn budget breaker. 0 = unlimited.
ALTER TABLE project ADD COLUMN spawn_budget_max INTEGER NOT NULL DEFAULT 0;

-- M3: watchdog escalation flag; set when a spawned worker session needs Leader/human attention
-- (session ended without completing the task, failed, or hit a high-risk blocked question).
ALTER TABLE task_item ADD COLUMN needs_human INTEGER NOT NULL DEFAULT 0 CHECK (needs_human IN (0, 1));

-- M3: last normalized Devin session status observed by the watchdog, used to notify only on transitions.
ALTER TABLE task_item ADD COLUMN watchdog_status TEXT;

CREATE INDEX IF NOT EXISTS idx_task_needs_human ON task_item(board_id, needs_human, deleted_at);
