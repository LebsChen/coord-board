# Coord Board

Standalone always-on coordination task board built with **Cloudflare Workers + D1**. D1 is the durable source of truth for projects, tasks, dependencies, agents, leases, and events. The Worker is stateless, so multiple desktop clients and cloud agents can coordinate through the same board.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LebsChen/coord-board)

## Features

- Project/board tenancy with a backward-compatible `default` project.
- Atomic task claims using conditional D1 updates.
- Dependency readiness checked inside the claim statement.
- Batched claim/release/complete plus event mutations.
- Idempotency keys for mutating requests.
- Per-project agent membership and per-agent bearer tokens.
- Capability-based role authorization for management, execution, review, and verification.
- Durable project-scoped mailbox with direct and broadcast delivery.
- SHA-256 token hashes only; plaintext agent tokens are returned once at registration.
- Persistent leases with scheduled and claim-time stale-lease recovery.
- Minimal token-authenticated browser UI.

## Prerequisites

- Node.js **22 or newer**.
- A Cloudflare account with permission to create D1 databases and deploy Workers.
- Cloudflare authentication configured for Wrangler:
  - `npx wrangler login`, or
  - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment variables.
- Wrangler available through either:
  - `npm i -g wrangler`, or
  - `npx wrangler`.

## Deploy to Cloudflare

From the repository root:

```sh
npm ci
npx wrangler login
npx wrangler d1 create coord-board
```

Copy the `database_id` returned by Wrangler into `wrangler.jsonc` under the `coord-board` D1 binding:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "coord-board",
      "database_id": "replace-with-your-database-id",
      "migrations_dir": "migrations"
    }
  ]
}
```

The committed `wrangler.jsonc` currently points to the maintainer's existing database. **Forks and independent deployments must replace that ID with their own database ID before applying migrations or deploying.**

Apply the schema remotely:

```sh
npx wrangler d1 migrations apply coord-board --remote
```

Generate a strong random service token locally, then store it as a Worker secret. Do not put it in `wrangler.jsonc`, source files, or command URLs:

```sh
openssl rand -hex 32 | npx wrangler secret put BOARD_TOKEN
npx wrangler deploy
```

Wrangler prints the deployed Worker URL. Check it:

```sh
curl -fsS https://coord-board.<your-subdomain>.workers.dev/health
```

Expected response:

```json
{"ok":true,"service":"coord-board"}
```

You can also use the button above to start a Cloudflare deployment. Review the generated configuration and replace the D1 `database_id` before applying migrations.

## Local development and tests

```sh
npm ci
npm run typecheck
npm test
npx wrangler dev
```

The Worker test configuration uses a local D1 binding and the dummy test credential `"test-token"`. It is not a production secret.

## Authentication

Every `/api/board/*` request requires:

```http
Authorization: Bearer <token>
```

The `BOARD_TOKEN` Worker secret is the administrator/service credential. It can create projects, register agents, and inspect or act across all projects.

Register an agent with the administrator credential:

```sh
curl -X POST https://coord-board.example/api/board/projects \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"site-a","name":"Website A"}'

curl -X POST https://coord-board.example/api/board/agents \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"agent-a","project_id":"site-a","name":"Developer A","role":"worker"}'
```

The agent registration response includes a random `token` exactly once. Store it in the agent's secret manager. Only its SHA-256 hash is stored in D1; plaintext is never persisted:

```http
Authorization: Bearer <agent-token>
```

An agent token is confined to its own project. It may list and read tasks whose `board_id` matches its `project_id`; mutations are limited by the role capability table below. Project matching is enforced at request boundaries and inside the atomic claim update. The `default` project is created by the migration for compatibility with existing callers.

Agent-token heartbeats must be at least 30 seconds apart. Clients should back off claim retries rather than polling aggressively. Mutating endpoints accept an `Idempotency-Key` header.

### Role capabilities

Authorization uses an explicit capability set:

| Role/token | Capabilities within its project |
| --- | --- |
| Admin `BOARD_TOKEN` | All capabilities across all projects |
| Lead / orchestrator / `编排` | All capabilities within its project |
| Developer / `开发` | `claim`, `release`, `complete`, `plan_submit` |
| Reviewer / `审查` | `claim`, `release`, `complete`, `review`, `plan_submit`, `gate` |
| Tester / `测试` | `claim`, `release`, `complete`, `verify`, `plan_submit`, `gate` |
| Other worker roles | `claim`, `release`, `complete`, `plan_submit` |

The `manage` capability covers task create, update, delete, and dependency changes. `plan_submit` is available to workers; `plan_review`, `accept`, and arbitrary management are lead/admin capabilities. `gate` is available to lead, reviewer, and tester roles. Every decision is modeled as `allow`, `ask`, or `deny`, following an OpenOPC-style authorization shape. Currently, role capabilities either allow or deny; no default policy emits `ask` yet. General approval hooks for `ask` decisions remain reserved for future work.

Review and verification are annotations only. `POST /api/board/tasks/:id/review` and `POST /api/board/tasks/:id/verify` accept `{ "decision": "pass"|"reject", "note": "..." }`, record the acting agent in the task fields and `task_event`, and require the task to be `in_progress` or `done`. They do not auto-unlock dependencies or alter completion semantics.

### Plan approval and acceptance

Plan approval and three-layer completion are opt-in per task. Leaders can set `require_plan` and/or `require_acceptance` to `true` when creating or updating a task; both default to `false`, preserving the normal claim → complete flow.

- `POST /api/board/tasks/:id/plan` — a lease-owning worker submits `{ "plan": "..." }`; records `plan_status=submitted`.
- `POST /api/board/tasks/:id/plan-review` — a lead/admin submits `{ "decision": "approve"|"reject", "note": "..." }`. Rejection lets the worker resubmit. When `require_plan` is enabled, completion returns `409` until the plan is approved.
- `POST /api/board/tasks/:id/acceptance` — a lead/admin submits `{ "decision": "accept"|"reject", "note": "..." }`. With `require_acceptance`, worker completion records `acceptance_status=submitted` while the phase remains `in_progress`; dependents remain blocked. Acceptance promotes the task to `done`, while rejection returns it to `in_progress` for another attempt.

Dependencies continue to unlock only when the dependency phase is exactly `done`. Self-reported completion never unlocks an acceptance-gated dependent.

### Agent lifecycle, quality gates, and hooks

Agent registration starts an agent online. Agents can explicitly transition their own lifecycle with `POST /api/board/agents/:id/join`, `/idle`, and `/shutdown`; leads/admins can transition agents in their project. Shutdown releases all leases held by that agent so work becomes claimable again. The five-minute scheduled sweep marks stale agents idle and releases their held leases. Heartbeats restore the active/online state.

Tasks may opt into quality gates with `required_gates: ["tests", "review"]`; the default is an empty list. `POST /api/board/tasks/:id/gate` accepts `{ "gate": "tests", "decision": "pass"|"fail", "note": "..." }`. Lead, reviewer, and tester roles can record gates. Completion and acceptance return `409` until every required gate has passed; a failed gate remains recorded and blocks progress.

Project leads/admins can register post-event or failure webhooks:

- `POST /api/board/hooks` — `{ "event_type(s)": ..., "url": "...", "phase": "post"|"failure", "secret": "..." }`
- `GET /api/board/hooks?project_id=<project-id>`
- `DELETE /api/board/hooks/:id`

Hooks run out-of-band through `waitUntil`; delivery errors never fail the originating API request. Configured secrets produce an HMAC-SHA256 `x-coord-board-signature` header. Post hooks cover task, plan, gate, acceptance, lifecycle, and dead-letter events; failure hooks cover failed gates, rejected plans/acceptance, and dead-letter notifications. Blocking pre-event semantics are provided by the plan, acceptance, and quality-gate checks rather than webhooks.

### Team dashboard and leader controls

`GET /api/board/team` returns a project-scoped team snapshot for any project agent. It includes the agent roster and lifecycle metadata, each agent's currently leased task, all non-deleted tasks with phase/assignee/lease/plan/acceptance/gate state, and the project's dead-letter delivery count. Agent tokens are restricted to their own project; admin tokens must provide `?project=<project-id>` (the `board` and `project_id` query aliases are also accepted).

Leader/admin controls include:

- `POST /api/board/tasks/:id/reassign` — `{ "assignee_agent_id": "agent-id" }` or `null`; clears the lease and returns an in-progress task to `ready`.
- `POST /api/board/tasks/:id/release` — workers release their own lease; leads/admins may provide `{ "agent_id": "teammate-id" }` to force-release that teammate's lease.
- `POST /api/board/agents/:id/shutdown` — force-shutdown an agent in the leader's project and release its leases.

The root board at `/?project=<project-id>` is a unified dashboard showing agents, current work, task controls, gate state, and dead letters. For a convenient authenticated share link, append the token in the URL fragment (never the query string):

```text
/?project=<project-id>#token=<url-encoded-token>
```

`#tkn=<url-encoded-token>` is accepted as an alias. The page stores the fragment token in `sessionStorage` and immediately removes the fragment from the address bar and browser history with `history.replaceState`; fragments are not sent to the Worker or written to Cloudflare request logs. Manual password entry and the existing session-storage flow continue to work when no fragment token is present. The security tradeoff remains important: anyone who obtains the share link can use the token until it is rotated, so treat these links as sensitive and prefer rotation after sharing. Control buttons remain visible to non-leaders but receive the normal capability `403` response.

## Mailbox

The mailbox is a durable, project-scoped point-to-point and broadcast channel for agents. A `message` stores the sender, kind, subject, payload, optional `reply_to` correlation, and creation time. Each recipient gets its own `message_delivery` row, so reading is non-destructive and every recipient can independently mark a message seen, acknowledged, or rejected.

Agents may send to other agents in their own project without a special capability. Direct sends require every recipient to belong to the sender's project. Broadcast sends fan out to every other agent in the sender's project. The sender can inspect its audit copy through the sent endpoint. Admins and lead agents may inspect all mailbox deliveries in a project.

Mailbox endpoints:

- `POST /api/mailbox/messages` — send `{ "to": ["agent-id"]|"broadcast", "subject": "...", "body": "...", "reply_to": "message-id" }`. Administrator requests must also provide `project_id`; agent requests use their own project.
- `GET /api/mailbox/inbox?status=<unread|seen|acked|nacked|dead>` — non-destructive inbox listing. Agents see their own deliveries; admins/leads can inspect a project.
- `GET /api/mailbox/sent` — sender audit messages; admins/leads can inspect a project.
- `GET /api/mailbox/messages/:id` — view a message as its sender, recipient, or an admin/lead.
- `POST /api/mailbox/deliveries/:id/seen` — mark a delivery seen.
- `POST /api/mailbox/deliveries/:id/ack` — acknowledge a delivery.
- `POST /api/mailbox/deliveries/:id/nack` — reject for retry; after **3 attempts** it moves to `dead`.
- `GET /api/mailbox/deadletter` — lead/admin inspection of dead deliveries.

Send operations accept `Idempotency-Key` and replay the original response without creating a second message or delivery set. Seen, ack, and nack transitions use conditional updates and affected-row counts; repeated seen/ack/nack calls are safely idempotent where the terminal state has already been reached. Cross-project reads, sends, and delivery actions return `403` without creating rows.

## API

### Health

- `GET /health`

### Projects

- `GET /api/board/projects`
- `POST /api/board/projects`

### Tasks

- `GET /api/board/tasks?board_id=<project-id>`
- `POST /api/board/tasks`
- `GET /api/board/tasks/:id`
- `PATCH /api/board/tasks/:id`
- `DELETE /api/board/tasks/:id`
- `PUT /api/board/tasks/:id/dependencies`
- `POST /api/board/tasks/:id/claim`
- `POST /api/board/tasks/:id/release`
- `POST /api/board/tasks/:id/complete`
- `POST /api/board/tasks/:id/review`
- `POST /api/board/tasks/:id/verify`
- `POST /api/board/tasks/:id/plan`
- `POST /api/board/tasks/:id/plan-review`
- `POST /api/board/tasks/:id/acceptance`
- `POST /api/board/tasks/:id/gate`
- `POST /api/board/tasks/:id/reassign`
- `GET /api/board/tasks/:id/events`

### Mailbox

- `POST /api/mailbox/messages`
- `GET /api/mailbox/inbox`
- `GET /api/mailbox/sent`
- `GET /api/mailbox/messages/:id`
- `POST /api/mailbox/deliveries/:id/seen`
- `POST /api/mailbox/deliveries/:id/ack`
- `POST /api/mailbox/deliveries/:id/nack`
- `GET /api/mailbox/deadletter`

### Agents

- `GET /api/board/agents`
- `POST /api/board/agents` — administrator registration; returns the per-agent token once.
- `POST /api/board/agents/:id/heartbeat`
- `POST /api/board/agents/:id/join`
- `POST /api/board/agents/:id/idle`
- `POST /api/board/agents/:id/shutdown`

### Team

- `GET /api/board/team?project=<project-id>`

### Hooks

- `POST /api/board/hooks`
- `GET /api/board/hooks`
- `DELETE /api/board/hooks/:id`

Claim behavior:

- `403` — project or agent access denied.
- `409` — another live lease holds the task.
- `422` — task is unclaimable or dependencies are incomplete.
- `410` — task has been deleted.
- `429` — heartbeat was submitted before the minimum interval.

Claims use one conditional D1 `UPDATE` with lease, project, assignment, and dependency checks in its `WHERE` clause. Success is determined by the affected-row count; no read-then-write claim decision is used. Claim and event insertion are grouped with `D1Database.batch`. Expired leases are swept by the scheduled Worker trigger and before claims.

Management, review, and verification authorization is checked before any mutation. Denied requests return `403` and change zero rows. Release and completion still require lease ownership as before.

## Browser UI

Open the deployed Worker root URL in a browser. Enter the bearer token into the password form, or use a sensitive share link such as `/?project=<project-id>#token=<url-encoded-token>`. The page keeps the token in `sessionStorage` and immediately strips the fragment from the visible URL/history. Fragments avoid server-log exposure, but possession of the link grants access until the token is rotated. The page can list, create, claim, and complete tasks.

## Project layout

```text
migrations/       D1 schema migrations
src/index.ts      Cloudflare Worker and REST/UI implementation
test/             Vitest + Miniflare tests
wrangler.jsonc    Worker and D1 deployment configuration
wrangler.test.jsonc
```

## License

MIT © 2026 LebsChen.
