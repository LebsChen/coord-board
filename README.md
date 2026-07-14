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
| Admin `BOARD_TOKEN` | `manage`, `claim`, `release`, `complete`, `review`, `verify` across all projects |
| Lead / orchestrator / `编排` | All six capabilities |
| Developer / `开发` | `claim`, `release`, `complete` |
| Reviewer / `审查` | `claim`, `release`, `complete`, `review` |
| Tester / `测试` | `claim`, `release`, `complete`, `verify` |
| Other worker roles | `claim`, `release`, `complete` |

The `manage` capability covers task create, update, delete, and dependency changes. Every decision is modeled as `allow`, `ask`, or `deny`, following an OpenOPC-style authorization shape. Currently, role capabilities either allow or deny; no default policy emits `ask` yet. Approval hooks for `ask` decisions are reserved for Phase 3.

Review and verification are annotations only. `POST /api/board/tasks/:id/review` and `POST /api/board/tasks/:id/verify` accept `{ "decision": "pass"|"reject", "note": "..." }`, record the acting agent in the task fields and `task_event`, and require the task to be `in_progress` or `done`. They do not auto-unlock dependencies or alter completion semantics.

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
- `GET /api/board/tasks/:id/events`

### Agents

- `GET /api/board/agents`
- `POST /api/board/agents` — administrator registration; returns the per-agent token once.
- `POST /api/board/agents/:id/heartbeat`

Claim behavior:

- `403` — project or agent access denied.
- `409` — another live lease holds the task.
- `422` — task is unclaimable or dependencies are incomplete.
- `410` — task has been deleted.
- `429` — heartbeat was submitted before the minimum interval.

Claims use one conditional D1 `UPDATE` with lease, project, assignment, and dependency checks in its `WHERE` clause. Success is determined by the affected-row count; no read-then-write claim decision is used. Claim and event insertion are grouped with `D1Database.batch`. Expired leases are swept by the scheduled Worker trigger and before claims.

Management, review, and verification authorization is checked before any mutation. Denied requests return `403` and change zero rows. Release and completion still require lease ownership as before.

## Browser UI

Open the deployed Worker root URL in a browser. Enter the bearer token into the password form; the UI keeps it in `sessionStorage` and never puts it in a URL. The page can list, create, claim, and complete tasks.

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
