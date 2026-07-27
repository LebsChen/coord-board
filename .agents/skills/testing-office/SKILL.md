---
name: testing-office
description: How to run and E2E-test the Board-hosted Office page (office-web + wrangler dev + local D1) in coord-board
---

# Testing the Coord Board Office page locally

## Run
1. Build the office bundle: `npm run build:office` (required before starting wrangler if office code changed).
2. Start: `npx wrangler dev --local --persist-to .wrangler/state --port 8787` from the repo root. `.dev.vars` must contain `BOARD_TOKEN=<local admin token>`.
3. Office UI: `http://localhost:8787/office/?project=<project_id>`.

## Auth flow
1. Share token: `POST /api/board/share-token` with `Authorization: Bearer $BOARD_TOKEN`, body `{"project_id":"<id>"}` → `token` (returned once only).
2. Bootstrap code: `POST /api/board/office/bootstrap` with `Authorization: Bearer <share token>` → single-use code, expires ~10 min. Mint it immediately before use.
3. Open `http://localhost:8787/office/?project=<id>#bootstrap=<code>`. Fragment-only URL changes do NOT reload the page — navigate via `about:blank` first. On success the fragment is stripped and an HttpOnly session cookie is set (survives reloads; cleared by the Sign out button).
4. The sign-in form also accepts a raw share token directly. Wrong-project tokens are rejected with "Invalid, expired, or wrong-project share token".

## Data model for agent states (local D1)
- Tables are singular: `agent`, `task_item` (project column is `board_id` on task_item, `project_id` on agent).
- `officeActions` (src/index.ts, `/api/board/office-actions`) derives states from `task_item`:
  - working = `phase='in_progress'` AND `lease_owner` set (phase alone is NOT enough)
  - blocked = `blocked=1`; thinking = `needs_human=1`; done = `phase='done'`; else idle
- Flip an agent live (UI polls every 2.5s, no reload needed):
  `npx wrangler d1 execute coord-board --local --persist-to .wrangler/state --command "UPDATE task_item SET phase='in_progress', lease_owner='<agent_id>' WHERE board_id='<project>' AND assignee_agent_id='<agent_id>'"`
- Create extra projects for negative tests via `POST /api/board/projects` with the board token.

## Gotchas
- Bootstrap codes are single-use; a failed page load consumes the code — mint a new one.
- Idle agents roam to lounges (Coffee/Workout/Restroom), so a "missing" figure at a desk is usually just an idle walk cycle.
