-- M5: indexed cumulative spawn budget usage.
ALTER TABLE project ADD COLUMN spawn_used INTEGER NOT NULL DEFAULT 0;

UPDATE project
SET spawn_used = (
  SELECT COUNT(*)
  FROM task_event
  WHERE task_event.event_type = 'spawn_created'
    AND json_extract(task_event.payload_json, '$.project_id') = project.id
);

CREATE INDEX IF NOT EXISTS idx_project_spawn_budget ON project(spawn_budget_max, spawn_used);
