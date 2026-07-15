export interface Env {
  DB: D1Database;
  BOARD_TOKEN: string;
  BACKUP_ACCOUNT_MASTER_KEY?: string;
  BOARD_BASE_URL?: string;
}

type Phase = "pending" | "ready" | "in_progress" | "done";
type Json = Record<string, unknown>;
type Capability = "manage" | "claim" | "release" | "complete" | "review" | "verify" | "plan_submit" | "plan_review" | "accept" | "gate";
type Decision = "allow" | "ask" | "deny";
type TaskRow = Record<string, unknown>;
type MailboxStatus = "unread" | "seen" | "acked" | "nacked" | "dead";
type Auth =
  | { kind: "admin"; agentId: string | null }
  | { kind: "agent"; agentId: string; projectId: string; role: string }
  | { kind: "share"; agentId: null; projectId: string; scope: "read" };

const ALL_CAPABILITIES: readonly Capability[] = [
  "manage", "claim", "release", "complete", "review", "verify", "plan_submit", "plan_review", "accept", "gate",
];
const ROLE_CAPABILITY_DEFAULTS: Record<string, readonly Capability[]> = {
  lead: ALL_CAPABILITIES,
  developer: ["claim", "release", "complete", "plan_submit"],
  reviewer: ["claim", "release", "complete", "review", "plan_submit", "gate"],
  tester: ["claim", "release", "complete", "verify", "plan_submit", "gate"],
  worker: ["claim", "release", "complete", "plan_submit"],
};
const MAILBOX_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_SECONDS = 300;
const MIN_LEASE_SECONDS = 10;
const MAX_LEASE_SECONDS = 24 * 60 * 60;
// Known boundary: requests slower than this can lose an in-progress reservation;
// terminal upsert and mailbox SQL uniqueness remain the duplicate-execution safeguards.
const IDEMPOTENCY_IN_PROGRESS_TTL_MS = 15 * 60 * 1000;
const BACKUP_ACCOUNT_KEY_VERSION = "v1";
const DEFAULT_FAILOVER_MAX_REPLACEMENTS = 4;
const DEFAULT_FAILOVER_COOLDOWN_SECONDS = 15 * 60;
const DEFAULT_FAILOVER_STALE_GRACE_SECONDS = 10 * 60;
const FAILOVER_REPLACEMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FAILOVER_REPLACEMENT_RESERVATION_TIMEOUT_MS = 10 * 60 * 1000;
const SPAWN_STALE_GRACE_MS = 10 * 60 * 1000;
const SPAWN_MAX_ACTIVE_PER_PROJECT = 8;
const WATCHDOG_BATCH_SIZE = 25;
// Re-send a wake nudge to an idle/sleeping worker session at most this often.
const WATCHDOG_WAKE_INTERVAL_MS = 20 * 60 * 1000;
// Keywords that make a blocked question high-risk enough to require human judgement.
const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /\b(delete|destroy|drop|truncate|wipe|erase|purge)\b/i,
  /\b(prod|production|live)\b/i,
  /\b(deploy|release|publish|rollback|revert)\b/i,
  /\b(force[- ]?push|rm\s+-rf|drop\s+table|drop\s+database)\b/i,
  /\b(secret|credential|password|token|api[- ]?key|private\s+key)\b/i,
  /\b(payment|charge|refund|billing|invoice|purchase)\b/i,
  /\b(irreversible|cannot\s+be\s+undone|permanent(?:ly)?)\b/i,
  /(删除|销毁|清空|生产环境|上线|部署|发布|回滚|不可逆|无法撤销|密钥|凭据|密码|付款|扣费|支付)/,
];
const DEFAULT_ACCOUNT_CLAIM_TTL_SECONDS = 5 * 60;
const MIN_ACCOUNT_CLAIM_TTL_SECONDS = 30;
const MAX_ACCOUNT_CLAIM_TTL_SECONDS = 60 * 60;
const MAX_ACCOUNT_CLAIMS_PER_REQUEST = 100;
const MAX_HOOK_DELIVERY_ATTEMPTS = 5;
const HOOK_DELIVERY_BATCH_SIZE = 50;
const HOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HOOK_DELIVERY_IN_FLIGHT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TASK_ATTEMPTS = 5;

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,idempotency-key,x-agent-id",
  "access-control-expose-headers": "content-type,idempotency-key",
  "access-control-max-age": "86400",
};

// Every browser-visible response (including errors) must carry CORS headers; otherwise a cross-origin
// caller sees a generic "Failed to fetch" instead of the real status (e.g. 401 unauthorized).
const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

const parseBody = async (request: Request): Promise<Json> => {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Json : {};
  } catch {
    return {};
  }
};

function flag(value: unknown): number {
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

function gateNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((name) => name.trim()).filter(Boolean))];
}

function requiredGates(row: TaskRow): string[] {
  try {
    return gateNames(JSON.parse(String(row.required_gates ?? "[]")));
  } catch {
    return [];
  }
}

function leaseSeconds(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_LEASE_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_LEASE_SECONDS;
  return Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, Math.floor(parsed)));
}

async function qualityGatesSatisfied(db: D1Database, row: TaskRow): Promise<boolean> {
  const gates = requiredGates(row);
  if (gates.length === 0) return true;
  const placeholders = gates.map(() => "?").join(",");
  const passed = await db.prepare(
    `SELECT COUNT(*) AS count FROM task_gate WHERE task_id = ? AND gate_name IN (${placeholders}) AND status = 'passed'`,
  ).bind(String(row.id), ...gates).first<{ count: number }>();
  return Number(passed?.count ?? 0) === gates.length;
}

async function hmacSha256(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hookEvents(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((eventType) => eventType.trim()).filter(Boolean))];
  return typeof value === "string" ? [...new Set(value.split(",").map((eventType) => eventType.trim()).filter(Boolean))] : [];
}

async function enqueueHookDeliveries(
  db: D1Database,
  projectId: string,
  eventType: string,
  phase: "post" | "failure",
  payload: Json,
): Promise<void> {
  const rows = await db.prepare(
    "SELECT id, event_types_json FROM hook WHERE project_id = ? AND phase = ? AND active = 1",
  ).bind(projectId, phase).all<{ id: string; event_types_json: string }>();
  const timestamp = now();
  const body = JSON.stringify(payload);
  const statements = rows.results.flatMap((hook) => {
    try {
      if (!hookEvents(JSON.parse(hook.event_types_json)).includes(eventType)) return [];
    } catch {
      return [];
    }
    return [db.prepare(
      `INSERT INTO hook_delivery
       (id, hook_id, project_id, event_type, phase, payload_json, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).bind(id(), hook.id, projectId, eventType, phase, body, timestamp, timestamp, timestamp)];
  });
  if (statements.length > 0) await db.batch(statements);
}

function dispatchHooks(
  ctx: ExecutionContext,
  env: Env,
  projectId: string,
  eventType: string,
  phase: "post" | "failure",
  payload: Json,
): void {
  // Keep hook persistence isolated from the business transaction; failures are explicit in Worker logs.
  ctx.waitUntil(enqueueHookDeliveries(env.DB, projectId, eventType, phase, payload).catch((error) => {
    console.error("hook outbox enqueue failed", error instanceof Error ? error.message : String(error));
  }));
}

async function deliverHookOutbox(db: D1Database): Promise<void> {
  const timestamp = now();
  const staleBefore = new Date(Date.now() - HOOK_DELIVERY_IN_FLIGHT_TIMEOUT_MS).toISOString();
  await db.prepare(
    `UPDATE hook_delivery
     SET status = 'pending', next_attempt_at = ?, updated_at = ?, last_error = COALESCE(last_error, 'delivery lease expired')
     WHERE status = 'delivering' AND updated_at <= ?`,
  ).bind(timestamp, timestamp, staleBefore).run();
  const rows = await db.prepare(
    `SELECT d.*, h.url, h.secret
     FROM hook_delivery d
     LEFT JOIN hook h ON h.id = d.hook_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= ?
     ORDER BY d.next_attempt_at, d.created_at
     LIMIT ?`,
  ).bind(timestamp, HOOK_DELIVERY_BATCH_SIZE).all<Record<string, unknown>>();
  await Promise.all(rows.results.map(async (delivery) => {
    const claimed = await db.prepare(
      "UPDATE hook_delivery SET status = 'delivering', updated_at = ? WHERE id = ? AND status = 'pending'",
    ).bind(timestamp, String(delivery.id)).run();
    if ((claimed.meta.changes ?? 0) !== 1) return;
    let error: string | null = null;
    let body = "";
    try {
      body = JSON.stringify({
        event_type: delivery.event_type,
        phase: delivery.phase,
        project_id: delivery.project_id,
        payload: JSON.parse(String(delivery.payload_json)),
      });
      if (!delivery.url) throw new Error("hook not found");
      const headers: HeadersInit = { "content-type": "application/json" };
      if (delivery.secret) headers["x-coord-board-signature"] = `sha256=${await hmacSha256(String(delivery.secret), body)}`;
      const response = await fetch(String(delivery.url), { method: "POST", headers, body });
      if (!response.ok) throw new Error(`hook returned ${response.status}`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "hook delivery failed";
    }
    if (!error) {
      await db.prepare(
        "UPDATE hook_delivery SET status = 'delivered', updated_at = ?, last_error = NULL WHERE id = ? AND status = 'delivering'",
      ).bind(timestamp, String(delivery.id)).run();
      return;
    }
    const attempts = Number(delivery.attempt_count ?? 0) + 1;
    const dead = attempts >= MAX_HOOK_DELIVERY_ATTEMPTS;
    const backoffSeconds = Math.min(60 * 60, 30 * (2 ** Math.max(0, attempts - 1)));
    const nextAttempt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
    await db.prepare(
      `UPDATE hook_delivery
       SET status = ?, attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'delivering'`,
    ).bind(dead ? "dead" : "pending", attempts, nextAttempt, error, timestamp, String(delivery.id)).run();
  }));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(value);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function cryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function backupCryptoKey(env: Env): Promise<CryptoKey> {
  const encoded = env.BACKUP_ACCOUNT_MASTER_KEY?.trim();
  if (!encoded) throw new Error("backup account encryption key is not configured");
  const raw = fromBase64(encoded);
  if (raw.byteLength !== 32) throw new Error("backup account encryption key must be 32 bytes");
  return crypto.subtle.importKey("raw", cryptoBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptBackupCredential(env: Env, credential: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: cryptoBuffer(iv) },
    await backupCryptoKey(env),
    cryptoBuffer(new TextEncoder().encode(credential)),
  );
  return { ciphertext: base64(new Uint8Array(encrypted)), iv: base64(iv) };
}

async function decryptBackupCredential(env: Env, ciphertext: string, iv: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: cryptoBuffer(fromBase64(iv)) },
    await backupCryptoKey(env),
    cryptoBuffer(fromBase64(ciphertext)),
  );
  return new TextDecoder().decode(decrypted);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function authenticate(request: Request, env: Env): Promise<Auth | null> {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length);
  if (token === env.BOARD_TOKEN) {
    return { kind: "admin", agentId: request.headers.get("x-agent-id") || null };
  }
  const tokenHash = await sha256(token);
  const agent = await env.DB.prepare(
    "SELECT id, project_id, role FROM agent WHERE token_hash = ? AND token_revoked_at IS NULL",
  ).bind(tokenHash).first<{ id: string; project_id: string; role: string }>();
  if (agent) return { kind: "agent", agentId: agent.id, projectId: agent.project_id, role: agent.role };
  const share = await env.DB.prepare(
    "SELECT project_id, scope FROM share_token WHERE token_hash = ? AND expires_at > ? AND scope = 'read'",
  ).bind(tokenHash, now()).first<{ project_id: string; scope: "read" }>();
  return share
    ? { kind: "share", agentId: null, projectId: share.project_id, scope: "read" }
    : null;
}

function isAdmin(auth: Auth): auth is Extract<Auth, { kind: "admin" }> {
  return auth.kind === "admin";
}

function isShare(auth: Auth): auth is Extract<Auth, { kind: "share" }> {
  return auth.kind === "share";
}

function canManage(auth: Auth): boolean {
  return isAdmin(auth) || (auth.kind === "agent" && roleCapabilities(auth.role).includes("manage"));
}

function roleCapabilities(role: string): readonly Capability[] {
  if (/lead|orchestrator|编排/i.test(role)) return ROLE_CAPABILITY_DEFAULTS.lead;
  if (/审查|review/i.test(role)) return ROLE_CAPABILITY_DEFAULTS.reviewer;
  if (/测试|test/i.test(role)) return ROLE_CAPABILITY_DEFAULTS.tester;
  if (/开发|developer|dev/i.test(role)) return ROLE_CAPABILITY_DEFAULTS.developer;
  return ROLE_CAPABILITY_DEFAULTS.worker;
}

function capabilityDecision(auth: Auth, capability: Capability, task: TaskRow | null): { decision: Decision; reason: string } {
  if (isAdmin(auth)) return { decision: "allow", reason: "admin token has all capabilities" };
  if (isShare(auth)) return { decision: "deny", reason: "share tokens are read-only" };
  if (!task || auth.projectId !== String(task.board_id)) {
    return { decision: "deny", reason: "task belongs to another project" };
  }
  if (roleCapabilities(auth.role).includes(capability)) {
    return { decision: "allow", reason: `role ${auth.role} allows ${capability}` };
  }
  return { decision: "deny", reason: `role ${auth.role} does not allow ${capability}` };
}

function capabilityDenied(auth: Auth, capability: Capability, task: TaskRow | null): Response | null {
  const result = capabilityDecision(auth, capability, task);
  if (result.decision === "allow") return null;
  if (result.decision === "ask") {
    return json({ error: "capability approval required", capability, authorization: result.decision }, 403);
  }
  return json({ error: "capability denied", capability, reason: result.reason, authorization: result.decision }, 403);
}

function actor(auth: Auth): string | null {
  return auth.agentId;
}

function bodyAgent(body: Json, auth: Auth): string {
  const requested = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (isAdmin(auth)) return requested || auth.agentId || "";
  if (isShare(auth)) return "";
  return requested || auth.agentId;
}

function checkAgentIdentity(body: Json, auth: Auth): Response | null {
  if (!isAdmin(auth) && typeof body.agent_id === "string" && body.agent_id !== auth.agentId) {
    return json({ error: "agent token identity mismatch" }, 403);
  }
  return null;
}

function projectAllowed(auth: Auth, projectId: string): boolean {
  return isAdmin(auth) || auth.projectId === projectId;
}

function isMailboxInspector(auth: Auth): boolean {
  return isAdmin(auth) || (auth.kind === "agent" && roleCapabilities(auth.role).includes("manage"));
}

function briefingCapabilities(role: string): Capability[] {
  return [...roleCapabilities(role)];
}

function briefingMarkdown(role: string): string {
  const capabilities = briefingCapabilities(role);
  const lines = [
    "## Coord Board access",
    "",
    "Authenticate every Board API request with `Authorization: Bearer <token>`; the calling session supplies the token separately.",
    "Use the Board API and mailbox as the only worker↔team communication channel; send updates and read replies through those endpoints.",
    "",
    "### Read",
    "- `GET /api/board/tasks?project=<project>` — list tasks for the project.",
    "- `GET /api/board/tasks/:id` — read one task, dependencies, and gates.",
    "- `GET /api/board/tasks/:id/events` — read the task event history.",
    "- `GET /api/board/team?project=<project>` — read the team overview when permitted.",
    "",
  ];
  if (capabilities.includes("claim")) {
    lines.push(
      "### Work leases",
      "- `POST /api/board/tasks/:id/claim` with `{ \"agent_id\": \"<your-agent-id>\", \"lease_seconds\": 300 }` to claim an eligible task.",
      "- `POST /api/board/tasks/:id/renew` with `{ \"agent_id\": \"<your-agent-id>\", \"lease_generation\": <generation>, \"lease_seconds\": 300 }` to renew your current lease without changing its generation.",
      "- Start renewing before expiry (for example every 60–120 seconds for a 300-second lease); a renewal requires the current generation and an unexpired lease.",
    );
  }
  if (capabilities.includes("release")) {
    lines.push("- `POST /api/board/tasks/:id/release` with `{ \"agent_id\": \"<your-agent-id>\" }` to release your own lease.");
  }
  if (capabilities.includes("complete")) {
    lines.push("- `POST /api/board/tasks/:id/complete` with `{ \"agent_id\": \"<your-agent-id>\", \"result\": \"<summary>\" }` to complete a task or submit acceptance when required; hold a valid lease.");
  }
  if (capabilities.includes("plan_submit")) {
    lines.push("- `POST /api/board/tasks/:id/plan` with `{ \"agent_id\": \"<your-agent-id>\", \"plan\": \"<plan>\" }` to submit a plan while holding the task lease.");
  }
  if (capabilities.includes("review")) {
    lines.push("- `POST /api/board/tasks/:id/review` with `{ \"decision\": \"pass\"|\"reject\", \"note\": \"<note>\" }` to record a review.");
  }
  if (capabilities.includes("verify")) {
    lines.push("- `POST /api/board/tasks/:id/verify` with `{ \"decision\": \"pass\"|\"reject\", \"note\": \"<note>\" }` to record verification.");
  }
  if (capabilities.includes("gate")) {
    lines.push("- `POST /api/board/tasks/:id/gate` with `{ \"gate\": \"<required-gate>\", \"decision\": \"pass\"|\"fail\", \"note\": \"<note>\" }` to record a quality gate.");
  }
  lines.push(
    "",
    "### Mailbox",
    "- `POST /api/mailbox/messages` with `{ \"to\": [\"<agent-id>\"], \"subject\": \"<subject>\", \"body\": <payload> }` to send a direct message; use `\"to\": \"broadcast\"` for the project team.",
    "- `GET /api/mailbox/inbox?project_id=<project>` to read received messages.",
    "- `POST /api/mailbox/deliveries/:id/seen` to mark a delivery seen.",
    "- `POST /api/mailbox/deliveries/:id/ack` to acknowledge a delivery.",
    "- `POST /api/mailbox/deliveries/:id/nack` to retry or dead-letter a delivery.",
  );
  if (capabilities.includes("manage")) {
    lines.push(
      "",
      "### Leader controls",
      "- `POST /api/board/tasks` with `{ \"board_id\": \"<project>\", \"title\": \"<title>\", \"description\": \"<description>\" }` to create a task.",
      "- `PATCH /api/board/tasks/:id` to update task fields, including `{ \"assignee_agent_id\": \"<agent-id>\" }` or `{ \"assignee_agent_id\": null }`.",
      "- `POST /api/board/tasks/:id/reassign` with `{ \"assignee_agent_id\": \"<agent-id>\" }` or `null` to reassign and release the current lease.",
      "- `PUT /api/board/tasks/:id/dependencies` with `{ \"depends_on\": [\"<task-id>\"] }` to replace dependencies.",
      "- `POST /api/board/tasks/:id/plan-review` with `{ \"decision\": \"approve\"|\"reject\", \"note\": \"<note>\" }` to review a submitted plan.",
      "- `POST /api/board/tasks/:id/acceptance` with `{ \"decision\": \"accept\"|\"reject\", \"note\": \"<note>\" }` to accept or reject submitted completion.",
      "- `POST /api/board/tasks/:id/gate` with `{ \"gate\": \"<required-gate>\", \"decision\": \"pass\"|\"fail\", \"note\": \"<note>\" }` to record a quality gate.",
      "- `GET /api/board/team?project=<project>` to inspect the team overview.",
      "- `POST /api/board/tasks/:id/release` with `{ \"agent_id\": \"<teammate-id>\" }` to force-release a teammate's lease.",
      "- `POST /api/board/agents/:id/shutdown` with `{ \"revoke_token\": true }` to force-shutdown a teammate and revoke its token.",
      "",
      "### Orchestration (Leader / human-in-the-loop)",
      "- `GET /api/board/leader?project=<project>` for a read-only leader dashboard: task/phase counts plus the blocked and needs-human worklists.",
      "- Spawned workers auto-drive themselves; the watchdog polls their Devin sessions. When a worker becomes `blocked`, its task is flagged `blocked=1` and you receive a mailbox message with the question and choices.",
      "- `POST /api/board/tasks/:id/answer` with `{ \"message\": \"<answer or chosen option>\" }` to forward an answer to the worker's Devin session and clear the block.",
      "- Tasks flagged `needs_human=1` require your judgement (high-risk question, or a worker session that ended or failed before completing). Reassign, re-spawn (`PATCH /api/board/tasks/:id { \"spawn\": true }`), or answer as appropriate.",
      "- `GET /api/board/spawn-stats?project=<project>` for per-profile spawn/session metrics and budget usage.",
      "- `POST /api/board/provision` (admin) to seed a project, worker profiles, and encrypted backup accounts in one request.",
    );
  }
  return lines.join("\n");
}

function idempotencyKey(request: Request, body: Json): string | null {
  return request.headers.get("idempotency-key") ||
    (typeof body.idempotency_key === "string" ? body.idempotency_key : null);
}

async function replayOrReserve(db: D1Database, scope: string, key: string | null): Promise<Response | null> {
  if (!key) return null;
  const result = await db.prepare(
    "INSERT OR IGNORE INTO idempotency_key(scope, key, created_at) VALUES (?, ?, ?)",
  ).bind(scope, key, now()).run();
  if ((result.meta.changes ?? 0) === 0) {
    const row = await db.prepare(
      "SELECT response_status, response_body FROM idempotency_key WHERE scope = ? AND key = ?",
    ).bind(scope, key).first<{ response_status: number | null; response_body: string | null }>();
    if (row?.response_status && row.response_body) return json(JSON.parse(row.response_body), row.response_status);
    return json({ error: "idempotency request is still in progress" }, 409);
  }
  return null;
}

async function saveIdempotentResponse(db: D1Database, scope: string, key: string | null, response: Response): Promise<Response> {
  if (!key) return response;
  const body = await response.clone().text();
  await db.prepare(
    `INSERT INTO idempotency_key(scope, key, response_status, response_body, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET response_status = excluded.response_status,
       response_body = excluded.response_body`,
  ).bind(scope, key, response.status, body, now()).run();
  return response;
}

async function releaseAgentLeases(
  db: D1Database,
  agentId: string,
  timestamp = now(),
  expiredOnly = false,
): Promise<string[]> {
  const leaseCondition = expiredOnly
    ? " AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?"
    : "";
  const leaseValues = expiredOnly ? [timestamp] : [];
  const rows = await db.prepare(
    `SELECT id, board_id FROM task_item WHERE lease_owner = ? AND phase = 'in_progress' AND deleted_at IS NULL${leaseCondition}`,
  ).bind(agentId, ...leaseValues).all<{ id: string; board_id: string }>();
  if (rows.results.length === 0) return [];
  await db.batch(rows.results.flatMap((row) => [
    db.prepare(
      `UPDATE task_item SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ? AND phase = 'in_progress'${leaseCondition}`,
    ).bind(timestamp, row.id, agentId, ...leaseValues),
    event(db, row.id, "agent_lease_released", agentId, { reason: "agent lifecycle transition", project_id: row.board_id }),
  ]));
  return rows.results.map((row) => row.board_id);
}

type StaleFailoverCandidate = {
  task_id: string;
  project_id: string;
  agent_id: string;
  role: string;
  lease_generation: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  assignee_agent_id: string | null;
};

async function reserveBackupAccount(
  db: D1Database,
  projectId: string,
  roleTag: string,
  timestamp: string,
): Promise<Record<string, unknown> | null> {
  await db.prepare(
    "UPDATE backup_account SET status = 'idle', cooldown_until = NULL, updated_at = ? WHERE project_id = ? AND status = 'active' AND cooldown_until IS NOT NULL AND cooldown_until <= ?",
  ).bind(timestamp, projectId, timestamp).run();
  const candidates = await db.prepare(
    `SELECT * FROM backup_account
     WHERE project_id = ? AND role_tag = ? AND enabled = 1 AND status = 'idle'
       AND (cooldown_until IS NULL OR cooldown_until <= ?)
     ORDER BY last_used_at IS NOT NULL, last_used_at, id`,
  ).bind(projectId, roleTag, timestamp).all<Record<string, unknown>>();
  for (const candidate of candidates.results) {
    const result = await db.prepare(
      `UPDATE backup_account SET status = 'reserved', updated_at = ?
       WHERE id = ? AND project_id = ? AND enabled = 1 AND status = 'idle'
         AND (cooldown_until IS NULL OR cooldown_until <= ?)`,
    ).bind(timestamp, candidate.id, projectId, timestamp).run();
    if ((result.meta.changes ?? 0) === 1) return { ...candidate, status: "reserved", updated_at: timestamp };
  }
  return null;
}

function failoverBoardUrl(env: Env): string {
  return env.BOARD_BASE_URL?.trim() || "https://coord-board.ideading.workers.dev";
}

async function registerFailoverAgent(
  db: D1Database,
  candidate: StaleFailoverCandidate,
  backup: Record<string, unknown>,
): Promise<{ id: string; token: string }> {
  const agentId = `failover-${candidate.task_id.slice(0, 8)}-${id().slice(0, 8)}`;
  const token = randomToken();
  const timestamp = now();
  const metadata = JSON.stringify({
    cloud_failover: true,
    backup_account_id: String(backup.id),
    replacement_for_agent_id: candidate.agent_id,
    replacement_for_task_id: candidate.task_id,
  });
  await db.batch([
    db.prepare(
      `INSERT INTO agent(
         id, project_id, name, role, status, last_seen_at, metadata_json,
         token_hash, token_issued_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      agentId, candidate.project_id, `Replacement for ${candidate.agent_id}`, candidate.role,
      timestamp, metadata, await sha256(token), timestamp, timestamp, timestamp,
    ),
    db.prepare(
      "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, 'agent_failover_registered', ?, ?)",
    ).bind(id(), agentId, candidate.project_id, JSON.stringify({
      replacement_for_agent_id: candidate.agent_id,
      task_id: candidate.task_id,
      backup_account_id: String(backup.id),
    }), timestamp),
  ]);
  return { id: agentId, token };
}

// v3 SessionCreateRequest agent-mode enum. A worker profile's free-form "model" is only forwarded
// as devin_mode when it names one of these; otherwise it stays as prompt context.
const DEVIN_MODES: ReadonlySet<string> = new Set(["normal", "fast", "lite", "ultra", "fusion"]);

async function createDevinSession(
  env: Env,
  orgId: string,
  credential: string,
  prompt: string,
  options: {
    playbookId?: string | null;
    knowledgeIds?: string[];
    devinMode?: string | null;
    title?: string | null;
  } = {},
): Promise<string> {
  // Only fields defined by v3 SessionCreateRequest are sent. Snapshot selection is not a
  // session-create field in v3 (it is bound via repo snapshot_setup), so it is not sent here.
  const requestBody: Json = { prompt };
  if (options.playbookId) requestBody.playbook_id = options.playbookId;
  if (options.knowledgeIds && options.knowledgeIds.length) requestBody.knowledge_ids = options.knowledgeIds;
  if (options.devinMode && DEVIN_MODES.has(options.devinMode.trim().toLowerCase())) {
    requestBody.devin_mode = options.devinMode.trim().toLowerCase();
  }
  if (options.title && options.title.trim()) requestBody.title = options.title.trim().slice(0, 200);
  const response = await fetch(
    `https://api.devin.ai/v3/organizations/${encodeURIComponent(orgId)}/sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    },
  );
  if (!response.ok) throw new Error(`Devin session creation failed (${response.status})`);
  const data = await response.json() as { session_id?: string; devin_id?: string };
  const sessionId = data.session_id || data.devin_id;
  if (!sessionId) throw new Error("Devin session creation returned no session id");
  return sessionId;
}

async function createFailoverSession(
  env: Env,
  candidate: StaleFailoverCandidate,
  backup: Record<string, unknown>,
  agent: { id: string; token: string },
): Promise<string> {
  const credential = await decryptBackupCredential(
    env,
    String(backup.credential_ciphertext),
    String(backup.credential_iv),
  );
  const roleBriefing = briefingMarkdown(candidate.role);
  const prompt = [
    `You are the cloud replacement worker for role "${candidate.role}".`,
    `The previous worker "${candidate.agent_id}" became unhealthy; continue task "${candidate.task_id}" from the Board.`,
    `Board URL: ${failoverBoardUrl(env)}`,
    `Board project: ${candidate.project_id}`,
    `Your new Board agent id: ${agent.id}`,
    `Your per-agent Board bearer token: ${agent.token}`,
    roleBriefing,
    `Claim task ${candidate.task_id} using the Board API, then continue the task. Do not rely on the desktop client.`,
  ].join("\n\n");
  return createDevinSession(env, String(backup.org_id), credential, prompt);
}

type WorkerProfileRow = {
  id: string;
  role_tag: string;
  model: string | null;
  snapshot_id: string | null;
  system_prompt: string | null;
  prompt_template: string | null;
  playbook_refs_json: string;
  knowledge_refs_json: string;
  mcp_tools_json: string;
  repo_config_json: string;
};

function buildSpawnPrompt(
  env: Env,
  task: { id: string; project_id: string; title: string; description: string },
  profile: WorkerProfileRow,
  agent: { id: string; token: string },
): string {
  const parseArray = (value: string): unknown[] => {
    try {
      const parsed = JSON.parse(value || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const model = profile.model ? profile.model.trim() : "";
  const playbooks = parseArray(profile.playbook_refs_json);
  const knowledge = parseArray(profile.knowledge_refs_json);
  const mcpTools = parseArray(profile.mcp_tools_json);
  let repoConfig: Json = {};
  try {
    const parsed = JSON.parse(profile.repo_config_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) repoConfig = parsed as Json;
  } catch {
    repoConfig = {};
  }
  const lines: string[] = [];
  if (profile.system_prompt && profile.system_prompt.trim()) lines.push(profile.system_prompt.trim());
  lines.push(`You are a cloud worker for role "${profile.role_tag}" spawned by the Coord Board.`);
  if (model) lines.push(`Preferred model: ${model}.`);
  const promptTemplate = profile.prompt_template && profile.prompt_template.trim()
    ? profile.prompt_template
      .replaceAll("{{task_id}}", task.id)
      .replaceAll("{{task_title}}", task.title)
      .replaceAll("{{task_description}}", task.description)
      .replaceAll("{{project_id}}", task.project_id)
      .replaceAll("{{agent_id}}", agent.id)
    : `Task: ${task.title}\n\n${task.description}`.trim();
  lines.push(promptTemplate);
  lines.push(`Board URL: ${failoverBoardUrl(env)}`);
  lines.push(`Board project: ${task.project_id}`);
  lines.push(`Your Board agent id: ${agent.id}`);
  lines.push(`Your per-agent Board bearer token: ${agent.token}`);
  if (playbooks.length) lines.push(`Follow these playbooks: ${playbooks.map(String).join(", ")}.`);
  if (knowledge.length) lines.push(`Apply this knowledge: ${knowledge.map(String).join(", ")}.`);
  if (mcpTools.length) lines.push(`Use these MCP tools when available: ${mcpTools.map(String).join(", ")}.`);
  if (profile.snapshot_id && profile.snapshot_id.trim()) lines.push(`Preferred machine snapshot: ${profile.snapshot_id.trim()}.`);
  if (Object.keys(repoConfig).length) lines.push(`Repository configuration: ${JSON.stringify(repoConfig)}.`);
  lines.push(briefingMarkdown(profile.role_tag));
  lines.push(`Claim task ${task.id} using the Board API, then work it to completion. Do not rely on the desktop client.`);
  return lines.join("\n\n");
}

async function createWorkerSession(
  env: Env,
  task: { id: string; project_id: string; title: string; description: string },
  profile: WorkerProfileRow,
  backup: Record<string, unknown>,
  agent: { id: string; token: string },
): Promise<string> {
  const credential = await decryptBackupCredential(
    env,
    String(backup.credential_ciphertext),
    String(backup.credential_iv),
  );
  const prompt = buildSpawnPrompt(env, task, profile, agent);
  const parseStrings = (value: string): string[] => {
    try {
      const parsed = JSON.parse(value || "[]");
      return Array.isArray(parsed) ? parsed.map(String).filter((s) => s.trim()) : [];
    } catch {
      return [];
    }
  };
  const playbookRefs = parseStrings(profile.playbook_refs_json);
  const knowledgeIds = parseStrings(profile.knowledge_refs_json);
  return createDevinSession(env, String(backup.org_id), credential, prompt, {
    playbookId: playbookRefs.length ? playbookRefs[0] : null,
    knowledgeIds,
    devinMode: profile.model,
    title: task.title,
  });
}

async function terminateFailoverSession(
  env: Env,
  backup: Record<string, unknown>,
  sessionId: string,
): Promise<boolean> {
  try {
    const credential = await decryptBackupCredential(
      env,
      String(backup.credential_ciphertext),
      String(backup.credential_iv),
    );
    const response = await fetch(
      `https://api.devin.ai/v3/organizations/${encodeURIComponent(String(backup.org_id))}/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${credential}` },
      },
    );
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

type DevinSessionStatus = "running" | "blocked" | "idle" | "finished" | "failed" | "unknown";

type DevinSessionView = {
  status: DevinSessionStatus;
  completed: boolean;
  // Devin flagged this as requiring explicit approval (status_detail = waiting_for_approval):
  // always route to a human regardless of the question wording.
  approvalRequired: boolean;
  question: string | null;
  choices: string[];
};

const DEVIN_API_BASE = "https://api.devin.ai/v3/organizations";

// Devin v3 SessionResponse.status_detail values that mean the session cannot make progress and
// needs a human (billing/quota/errors), as opposed to a normal working/waiting state.
const DEVIN_FAILED_DETAILS: ReadonlySet<string> = new Set([
  "error",
  "usage_limit_exceeded",
  "out_of_credits",
  "out_of_quota",
  "no_quota_allocation",
  "payment_declined",
  "org_usage_limit_exceeded",
  "total_session_limit_exceeded",
]);

function hasStructuredOutput(output: unknown): boolean {
  if (output === undefined || output === null) return false;
  if (typeof output === "string") return output.trim().length > 0;
  if (Array.isArray(output)) return output.length > 0;
  if (typeof output === "object") return Object.keys(output as Record<string, unknown>).length > 0;
  return false;
}

// Map the authoritative v3 SessionResponse.status + status_detail onto the watchdog's coarse state.
// v3 status enum:        new | claimed | running | exit | error | suspended | resuming
// v3 status_detail enum: working | waiting_for_user | waiting_for_approval | finished | inactivity |
//                        user_request | usage_limit_exceeded | out_of_credits | out_of_quota |
//                        no_quota_allocation | payment_declined | org_usage_limit_exceeded |
//                        total_session_limit_exceeded | error
function normalizeDevinStatus(status: string, detail: string): DevinSessionStatus {
  const s = status.trim().toLowerCase();
  const d = detail.trim().toLowerCase();
  if (s === "error" || DEVIN_FAILED_DETAILS.has(d)) return "failed";
  if (d === "finished" || s === "exit") return "finished";
  if (s === "suspended") {
    // Suspended-for-input is a block; suspended for inactivity/user request is a wakeable sleep.
    if (d === "waiting_for_user" || d === "waiting_for_approval") return "blocked";
    return "idle";
  }
  if (s === "running" || s === "resuming" || s === "claimed" || s === "new") return "running";
  return "unknown";
}

// Fetch the latest Devin-authored message as the blocked question. The v3 SessionResponse does not
// carry the question text, so we read it from the (paginated) session messages endpoint. Choices are
// not a structured API field, so we best-effort parse option lines out of the message text.
async function fetchDevinBlockedQuestion(
  orgId: string,
  credential: string,
  sessionId: string,
): Promise<{ question: string | null; choices: string[] }> {
  try {
    const response = await fetch(
      `${DEVIN_API_BASE}/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "GET", headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" } },
    );
    if (!response.ok) return { question: null, choices: [] };
    const raw = (await response.json()) as Record<string, unknown>;
    const items = Array.isArray(raw.items) ? raw.items : [];
    let question: string | null = null;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (record.source === "devin" && typeof record.message === "string" && record.message.trim()) {
          question = record.message.trim();
          break;
        }
      }
    }
    return { question, choices: question ? extractChoices(question) : [] };
  } catch {
    return { question: null, choices: [] };
  }
}

// Best-effort extraction of enumerated options from a question body (e.g. "1. Foo", "- Bar",
// "a) Baz"). Devin's API has no structured choice field, so this is heuristic and may be empty.
function extractChoices(text: string): string[] {
  const choices: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]|\d+[.)]|[a-zA-Z][.)])\s+(.{1,200})$/);
    if (match && match[1].trim()) choices.push(match[1].trim());
  }
  return choices;
}

// Poll a spawned worker's Devin session (v3 SessionResponse). Returns null on any transient/transport
// error so the watchdog simply retries on the next tick rather than escalating a temporary blip.
async function fetchDevinSession(
  orgId: string,
  credential: string,
  sessionId: string,
): Promise<DevinSessionView | null> {
  try {
    const response = await fetch(
      `${DEVIN_API_BASE}/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" } },
    );
    if (!response.ok) return null;
    const session = (await response.json()) as Record<string, unknown>;
    const rawStatus = typeof session.status === "string" ? session.status : "";
    const rawDetail = typeof session.status_detail === "string" ? session.status_detail : "";
    const status = normalizeDevinStatus(rawStatus, rawDetail);
    const approvalRequired = rawDetail.trim().toLowerCase() === "waiting_for_approval";
    const completed = status === "finished" || (status !== "blocked" && hasStructuredOutput(session.structured_output));
    let question: string | null = null;
    let choices: string[] = [];
    if (status === "blocked") {
      const extracted = await fetchDevinBlockedQuestion(orgId, credential, sessionId);
      question = extracted.question;
      choices = extracted.choices;
    }
    return { status, completed, approvalRequired, question, choices };
  } catch {
    return null;
  }
}

// Send a message to a Devin session (v3). A message to a suspended session auto-resumes it, which is
// exactly how the watchdog wakes an idle worker and how the Leader's answer reaches a blocked one.
async function sendDevinSessionMessage(
  orgId: string,
  credential: string,
  sessionId: string,
  message: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${DEVIN_API_BASE}/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

function isHighRiskQuestion(text: string): boolean {
  if (!text) return false;
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(text));
}

// Deliver a system message to a project's leader agent (or, if none is registered, to every
// manage-capable agent in the project). Used by the watchdog to escalate blocked/needs-human events.
async function notifyLeader(
  db: D1Database,
  projectId: string,
  subject: string,
  payload: Json,
): Promise<void> {
  const project = await db.prepare("SELECT leader_agent_id FROM project WHERE id = ?")
    .bind(projectId).first<{ leader_agent_id: string | null }>();
  const recipients: string[] = [];
  if (project?.leader_agent_id) {
    const leader = await db.prepare("SELECT id FROM agent WHERE id = ? AND project_id = ?")
      .bind(project.leader_agent_id, projectId).first<{ id: string }>();
    if (leader) recipients.push(leader.id);
  }
  if (recipients.length === 0) {
    const leads = await db.prepare(
      "SELECT id, role FROM agent WHERE project_id = ? AND status <> 'shutdown'",
    ).bind(projectId).all<{ id: string; role: string }>();
    for (const agent of leads.results) {
      if (roleCapabilities(agent.role).includes("manage")) recipients.push(agent.id);
    }
  }
  if (recipients.length === 0) return;
  const timestamp = now();
  const messageId = id();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO message(id, project_id, sender_agent_id, kind, subject, payload_json, reply_to, idempotency_key, created_at)
       VALUES (?, ?, NULL, 'direct', ?, ?, NULL, NULL, ?)`,
    ).bind(messageId, projectId, subject, JSON.stringify(payload), timestamp),
  ];
  for (const recipient of recipients) {
    statements.push(db.prepare(
      "INSERT INTO message_delivery(id, message_id, project_id, recipient_agent_id, status, seen_at, acked_at, attempt_count, updated_at) VALUES (?, ?, ?, ?, 'unread', NULL, NULL, 0, ?)",
    ).bind(id(), messageId, projectId, recipient, timestamp));
  }
  await db.batch(statements);
}

type WatchdogCandidate = {
  task_id: string;
  project_id: string;
  title: string;
  blocked: number;
  needs_human: number;
  watchdog_status: string | null;
  agent_id: string;
  metadata_json: string;
};

// Poll spawned worker sessions and drive the human-in-the-loop loop:
// - blocked  -> flag task.blocked, escalate the question to the Leader (needs_human when high-risk);
// - idle     -> wake the session so it keeps working, UNLESS it has really finished the task;
// - finished/failed without the Board task being done -> flag needs_human for the Leader.
async function runWatchdog(db: D1Database, env: Env, timestamp: string): Promise<void> {
  const candidates = await db.prepare(
    `SELECT t.id AS task_id, t.board_id AS project_id, t.title, t.blocked, t.needs_human,
            t.watchdog_status, a.id AS agent_id, a.metadata_json AS metadata_json
     FROM task_item t
     JOIN agent a ON a.project_id = t.board_id
       AND json_extract(a.metadata_json, '$.cloud_spawn') = 1
       AND json_extract(a.metadata_json, '$.task_id') = t.id
       AND COALESCE(json_extract(a.metadata_json, '$.leader_sleep'), 0) <> 1
     WHERE t.spawn_status = 'spawned' AND t.deleted_at IS NULL AND t.phase <> 'done'
     ORDER BY t.updated_at
     LIMIT ?`,
  ).bind(WATCHDOG_BATCH_SIZE).all<WatchdogCandidate>();
  for (const candidate of candidates.results) {
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(candidate.metadata_json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const sessionId = typeof meta.session_id === "string" ? meta.session_id : "";
    const backupAccountId = typeof meta.backup_account_id === "string" ? meta.backup_account_id : "";
    if (!sessionId || !backupAccountId) continue;
    const backup = await db.prepare(
      "SELECT * FROM backup_account WHERE id = ? AND project_id = ?",
    ).bind(backupAccountId, candidate.project_id).first<Record<string, unknown>>();
    if (!backup) continue;
    let credential: string;
    try {
      credential = await decryptBackupCredential(env, String(backup.credential_ciphertext), String(backup.credential_iv));
    } catch {
      continue;
    }
    const session = await fetchDevinSession(String(backup.org_id), credential, sessionId);
    if (!session) continue;
    await handleWatchdogSession(db, env, candidate, backup, credential, sessionId, session, meta, timestamp);
  }
}

async function handleWatchdogSession(
  db: D1Database,
  env: Env,
  candidate: WatchdogCandidate,
  backup: Record<string, unknown>,
  credential: string,
  sessionId: string,
  session: DevinSessionView,
  meta: Record<string, unknown>,
  timestamp: string,
): Promise<void> {
  const prevStatus = candidate.watchdog_status || "";
  const transitioned = session.status !== prevStatus;
  if (transitioned) {
    await db.prepare("UPDATE task_item SET watchdog_status = ?, updated_at = ? WHERE id = ?")
      .bind(session.status, timestamp, candidate.task_id).run();
  }

  if (session.status === "blocked") {
    if (transitioned || candidate.blocked !== 1) {
      const questionText = session.question || "The worker session is blocked and awaiting input.";
      // Devin's explicit approval-required state always needs a human; otherwise fall back to
      // scanning the question/choices for high-risk keywords.
      const highRisk = session.approvalRequired || isHighRiskQuestion(`${questionText} ${session.choices.join(" ")}`);
      await db.batch([
        db.prepare("UPDATE task_item SET blocked = 1, needs_human = ?, updated_at = ? WHERE id = ?")
          .bind(highRisk ? 1 : Number(candidate.needs_human ?? 0), timestamp, candidate.task_id),
        event(db, candidate.task_id, highRisk ? "worker_blocked_needs_human" : "worker_blocked", candidate.agent_id, {
          project_id: candidate.project_id,
          session_id: sessionId,
          question: questionText,
          choices: session.choices,
          high_risk: highRisk,
        }),
      ]);
      await notifyLeader(db, candidate.project_id, highRisk ? "Worker blocked (needs human)" : "Worker blocked", {
        type: highRisk ? "worker_blocked_needs_human" : "worker_blocked",
        task_id: candidate.task_id,
        agent_id: candidate.agent_id,
        question: questionText,
        choices: session.choices,
        high_risk: highRisk,
        answer_endpoint: `POST /api/board/tasks/${candidate.task_id}/answer`,
      });
    }
    return;
  }

  if (session.status === "failed") {
    if (transitioned || candidate.needs_human !== 1) {
      await db.batch([
        db.prepare("UPDATE task_item SET needs_human = 1, updated_at = ? WHERE id = ?").bind(timestamp, candidate.task_id),
        event(db, candidate.task_id, "worker_session_failed", candidate.agent_id, {
          project_id: candidate.project_id, session_id: sessionId,
        }),
      ]);
      await notifyLeader(db, candidate.project_id, "Worker session failed", {
        type: "worker_session_failed", task_id: candidate.task_id, agent_id: candidate.agent_id, session_id: sessionId,
      });
    }
    return;
  }

  if (session.status === "finished" || session.completed) {
    // The session ended (or reported completion) but the Board task is not marked done. Do not
    // wake it and do not auto-complete: hand it to the Leader/human to verify and close out.
    if (transitioned || candidate.needs_human !== 1) {
      await db.batch([
        db.prepare("UPDATE task_item SET needs_human = 1, updated_at = ? WHERE id = ?").bind(timestamp, candidate.task_id),
        event(db, candidate.task_id, "worker_session_ended", candidate.agent_id, {
          project_id: candidate.project_id, session_id: sessionId, status: session.status, completed: session.completed,
        }),
      ]);
      await notifyLeader(db, candidate.project_id, "Worker session ended without completing task", {
        type: "worker_session_ended",
        task_id: candidate.task_id,
        agent_id: candidate.agent_id,
        session_id: sessionId,
        note: "Session finished/produced output but the Board task is not done. Verify and mark done, or re-spawn.",
      });
    }
    return;
  }

  // Worker resumed on its own after having been blocked: clear the block.
  if (session.status === "running" && candidate.blocked === 1) {
    await db.batch([
      db.prepare("UPDATE task_item SET blocked = 0, updated_at = ? WHERE id = ?").bind(timestamp, candidate.task_id),
      event(db, candidate.task_id, "worker_unblocked", candidate.agent_id, { project_id: candidate.project_id, session_id: sessionId }),
    ]);
    return;
  }

  // Idle/sleeping (e.g. the ~30-min browser-inactivity sleep) but NOT actually finished: nudge it
  // to keep working, throttled so we do not spam an already-awake session.
  if (session.status === "idle") {
    const lastWakeAt = typeof meta.last_wake_at === "string" ? Date.parse(meta.last_wake_at) : NaN;
    const dueForWake = !Number.isFinite(lastWakeAt) || Date.now() - lastWakeAt >= WATCHDOG_WAKE_INTERVAL_MS;
    if (!dueForWake) return;
    const woke = await sendDevinSessionMessage(
      String(backup.org_id), credential, sessionId,
      `Please continue working on Board task ${candidate.task_id}. If you have finished, mark it complete via the Board API; otherwise resume where you left off.`,
    );
    if (woke) {
      await db.batch([
        db.prepare("UPDATE agent SET metadata_json = json_set(metadata_json, '$.last_wake_at', ?), updated_at = ? WHERE id = ? AND project_id = ?")
          .bind(timestamp, timestamp, candidate.agent_id, candidate.project_id),
        event(db, candidate.task_id, "worker_wake_nudge", candidate.agent_id, { project_id: candidate.project_id, session_id: sessionId }),
      ]);
    }
  }
}

async function reserveFailoverQuota(
  db: D1Database,
  projectId: string,
  taskId: string,
  backupAccountId: string,
  maxReplacements: number,
  timestamp: string,
): Promise<string | null> {
  const reservationId = id();
  const windowStart = new Date(Date.now() - FAILOVER_REPLACEMENT_WINDOW_MS).toISOString();
  const result = await db.prepare(
    `INSERT INTO failover_replacement
       (id, project_id, task_id, backup_account_id, status, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'reserved', ?, ?
     WHERE (
       SELECT COUNT(*) FROM failover_replacement
       WHERE project_id = ? AND status IN ('reserved', 'created') AND created_at > ?
     ) < ?`,
  ).bind(
    reservationId,
    projectId,
    taskId,
    backupAccountId,
    timestamp,
    timestamp,
    projectId,
    windowStart,
    maxReplacements,
  ).run();
  return (result.meta.changes ?? 0) === 1 ? reservationId : null;
}

async function runCloudFailover(
  db: D1Database,
  env: Env,
  timestamp: string,
): Promise<void> {
  const projects = await db.prepare(
    `SELECT id, failover_max_replacements, failover_cooldown_seconds, failover_stale_grace_seconds
     FROM project WHERE failover_enabled = 1`,
  ).all<{ id: string; failover_max_replacements: number; failover_cooldown_seconds: number; failover_stale_grace_seconds: number }>();
  for (const project of projects.results) {
    const staleBefore = new Date(
      Date.now() - (Number(project.failover_stale_grace_seconds) || DEFAULT_FAILOVER_STALE_GRACE_SECONDS) * 1000,
    ).toISOString();
    const candidates = await db.prepare(
    `SELECT t.id AS task_id, t.board_id AS project_id, t.lease_owner, t.lease_expires_at,
              t.assignee_agent_id, t.lease_generation, a.id AS agent_id, a.role
       FROM task_item t
       JOIN agent a ON a.id = COALESCE(t.lease_owner, t.assignee_agent_id)
       WHERE t.board_id = ? AND t.phase = 'in_progress' AND t.deleted_at IS NULL
         AND a.project_id = ? AND a.last_seen_at IS NOT NULL AND a.last_seen_at <= ?
         AND a.status NOT IN ('shutdown')`,
    ).bind(project.id, project.id, staleBefore).all<StaleFailoverCandidate>();
    const seenAgents = new Set<string>();
    for (const candidate of candidates.results) {
      if (seenAgents.has(candidate.agent_id)) continue;
      seenAgents.add(candidate.agent_id);
      const maxReplacements = Math.max(
        1,
        Number(project.failover_max_replacements) || DEFAULT_FAILOVER_MAX_REPLACEMENTS,
      );
      const backup = await reserveBackupAccount(db, project.id, candidate.role, timestamp);
      if (!backup) continue;
      const quotaReservation = await reserveFailoverQuota(
        db,
        project.id,
        candidate.task_id,
        String(backup.id),
        maxReplacements,
        timestamp,
      );
      if (!quotaReservation) {
        await db.prepare(
          "UPDATE backup_account SET status = 'idle', cooldown_until = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND status = 'reserved'",
        ).bind(timestamp, backup.id, project.id).run();
        break;
      }
      const generation = Number(candidate.lease_generation) + 1;
      const reservationLeaseOwner = `failover-reservation-${quotaReservation}`;
      const leaseOwnerCondition = candidate.lease_owner
        ? "lease_owner = ?"
        : "lease_owner IS NULL AND assignee_agent_id = ?";
      const leaseUpdate = await db.prepare(
        `UPDATE task_item SET lease_owner = ?, lease_expires_at = NULL, lease_generation = ?,
           updated_at = ? WHERE id = ? AND board_id = ? AND phase = 'in_progress'
           AND lease_generation = ?
           AND ${leaseOwnerCondition}`,
      ).bind(
        reservationLeaseOwner,
        generation,
        timestamp,
        candidate.task_id,
        project.id,
        candidate.lease_generation,
        candidate.agent_id,
      ).run();
      if ((leaseUpdate.meta.changes ?? 0) !== 1) {
        await db.batch([
          db.prepare(
            "DELETE FROM failover_replacement WHERE id = ? AND status = 'reserved'",
          ).bind(quotaReservation),
          db.prepare(
            "UPDATE backup_account SET status = 'idle', cooldown_until = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND status = 'reserved'",
          ).bind(timestamp, backup.id, project.id),
        ]);
        continue;
      }
      let replacement: { id: string; token: string } | null = null;
      let sessionId: string | null = null;
      try {
        replacement = await registerFailoverAgent(db, candidate, backup);
        await db.prepare(
          "UPDATE failover_replacement SET replacement_agent_id = ?, updated_at = ? WHERE id = ? AND status = 'reserved'",
        ).bind(replacement.id, timestamp, quotaReservation).run();
        sessionId = await createFailoverSession(env, candidate, backup, replacement);
        const leaseCheck = await db.prepare(
          "SELECT id FROM task_item WHERE id = ? AND board_id = ? AND phase = 'in_progress' AND lease_owner = ? AND lease_generation = ?",
        ).bind(candidate.task_id, project.id, reservationLeaseOwner, generation).first();
        if (!leaseCheck) throw new Error("task lease changed after failover session creation");
        await db.prepare(
          "UPDATE failover_replacement SET session_id = ?, status = 'created', updated_at = ? WHERE id = ? AND status = 'reserved'",
        ).bind(sessionId, timestamp, quotaReservation).run();
        const releaseReservationLease = await db.prepare(
          "UPDATE task_item SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND board_id = ? AND lease_owner = ? AND lease_generation = ?",
        ).bind(timestamp, candidate.task_id, project.id, reservationLeaseOwner, generation).run();
        if ((releaseReservationLease.meta.changes ?? 0) !== 1) throw new Error("task lease changed while finalizing failover");
        await db.prepare(
          "UPDATE agent SET metadata_json = json_set(metadata_json, '$.session_id', ?), updated_at = ? WHERE id = ? AND project_id = ?",
        ).bind(sessionId, timestamp, replacement.id, project.id).run();
        const cooldownUntil = new Date(
          Date.now() + (Number(project.failover_cooldown_seconds) || DEFAULT_FAILOVER_COOLDOWN_SECONDS) * 1000,
        ).toISOString();
        const old = await db.prepare("SELECT metadata_json FROM agent WHERE id = ?").bind(candidate.agent_id).first<{ metadata_json: string }>();
        let oldBackupId = "";
        try {
          oldBackupId = String((JSON.parse(old?.metadata_json || "{}") as Json).backup_account_id || "");
        } catch {
          oldBackupId = "";
        }
        await db.batch([
          db.prepare(
            "UPDATE backup_account SET status = 'active', cooldown_until = ?, last_used_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
          ).bind(cooldownUntil, timestamp, timestamp, backup.id, project.id),
          ...(oldBackupId && oldBackupId !== String(backup.id) ? [db.prepare(
            "UPDATE backup_account SET status = 'active', cooldown_until = ?, updated_at = ? WHERE id = ? AND project_id = ?",
          ).bind(cooldownUntil, timestamp, oldBackupId, project.id)] : []),
          db.prepare(
            "UPDATE agent SET status = 'shutdown', token_revoked_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
          ).bind(timestamp, timestamp, candidate.agent_id, project.id),
          db.prepare(
            "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, 'agent_failover', ?, ?)",
          ).bind(id(), candidate.agent_id, project.id, JSON.stringify({
            replacement_agent_id: replacement.id,
            task_id: candidate.task_id,
            backup_account_id: String(backup.id),
          }), timestamp),
          event(db, candidate.task_id, "agent_failover", replacement.id, {
            project_id: project.id,
            previous_agent_id: candidate.agent_id,
            replacement_agent_id: replacement.id,
            lease_generation: generation,
            backup_account_id: String(backup.id),
          }),
        ]);
      } catch (error) {
        let sessionTerminated = false;
        if (sessionId) {
          sessionTerminated = await terminateFailoverSession(env, backup, sessionId);
        }
        if (replacement) {
          await db.prepare("DELETE FROM agent WHERE id = ? AND project_id = ?").bind(replacement.id, project.id).run();
        }
        await db.batch([
          db.prepare(
            "DELETE FROM failover_replacement WHERE id = ? AND status IN ('reserved', 'created')",
          ).bind(quotaReservation),
          db.prepare(
            "UPDATE backup_account SET status = 'idle', cooldown_until = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND status = 'reserved'",
          ).bind(timestamp, backup.id, project.id),
          db.prepare(
            `UPDATE task_item SET lease_owner = ?, lease_expires_at = ?, lease_generation = ?, updated_at = ?
             WHERE id = ? AND board_id = ? AND phase = 'in_progress'
               AND lease_owner = ? AND lease_generation = ?`,
          ).bind(
            candidate.lease_owner,
            candidate.lease_expires_at,
            candidate.lease_generation,
            timestamp,
            candidate.task_id,
            project.id,
            reservationLeaseOwner,
            generation,
          ),
          event(db, candidate.task_id, "agent_failover_failed", candidate.agent_id, {
            project_id: project.id,
            failed_agent_id: candidate.agent_id,
            backup_account_id: String(backup.id),
            session_id: sessionId,
            session_terminated: sessionTerminated,
            reason: error instanceof Error ? error.message : "session creation failed",
          }),
        ]);
      }
    }
  }
}

async function registerSpawnAgent(
  db: D1Database,
  projectId: string,
  taskId: string,
  role: string,
  backup: Record<string, unknown>,
): Promise<{ id: string; token: string }> {
  const agentId = `spawn-${taskId.slice(0, 8)}-${id().slice(0, 8)}`;
  const token = randomToken();
  const timestamp = now();
  const metadata = JSON.stringify({ cloud_spawn: true, task_id: taskId, backup_account_id: String(backup.id) });
  await db.batch([
    db.prepare(
      `INSERT INTO agent(
         id, project_id, name, role, status, last_seen_at, metadata_json,
         token_hash, token_issued_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      agentId, projectId, `Worker for ${taskId}`, role,
      timestamp, metadata, await sha256(token), timestamp, timestamp, timestamp,
    ),
    db.prepare(
      "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, 'agent_spawn_registered', ?, ?)",
    ).bind(id(), agentId, projectId, JSON.stringify({ task_id: taskId, backup_account_id: String(backup.id) }), timestamp),
  ]);
  return { id: agentId, token };
}

async function releaseSpawnResources(
  db: D1Database,
  env: Env,
  projectId: string,
  backup: Record<string, unknown>,
  agent: { id: string; token: string } | null,
  sessionId: string | null,
  timestamp: string,
): Promise<void> {
  if (sessionId) await terminateFailoverSession(env, backup, sessionId);
  if (agent) {
    await db.prepare("DELETE FROM agent WHERE id = ? AND project_id = ?").bind(agent.id, projectId).run();
  }
  await db.prepare(
    "UPDATE backup_account SET status = 'idle', cooldown_until = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND status = 'reserved'",
  ).bind(timestamp, backup.id, projectId).run();
}

async function reconcileStaleSpawns(db: D1Database, env: Env, timestamp: string): Promise<void> {
  // Recover tasks whose spawn was claimed but never finished (e.g. isolate died mid-spawn).
  // If a Devin session was already created before the isolate died, its id was persisted onto
  // the spawn agent; terminate that orphaned session and release its account before re-queuing.
  const cutoff = new Date(Date.now() - SPAWN_STALE_GRACE_MS).toISOString();
  const stale = await db.prepare(
    "SELECT id, board_id FROM task_item WHERE spawn_status = 'spawning' AND updated_at <= ?",
  ).bind(cutoff).all<{ id: string; board_id: string }>();
  for (const stuck of stale.results) {
    const orphans = await db.prepare(
      `SELECT id, metadata_json FROM agent
       WHERE project_id = ? AND json_extract(metadata_json, '$.cloud_spawn') = 1
         AND json_extract(metadata_json, '$.task_id') = ?`,
    ).bind(stuck.board_id, stuck.id).all<{ id: string; metadata_json: string }>();
    for (const orphan of orphans.results) {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(orphan.metadata_json || "{}"); } catch { meta = {}; }
      const backupId = meta.backup_account_id ? String(meta.backup_account_id) : null;
      const sessionId = meta.session_id ? String(meta.session_id) : null;
      if (backupId) {
        if (sessionId) {
          const backup = await db.prepare(
            "SELECT * FROM backup_account WHERE id = ? AND project_id = ?",
          ).bind(backupId, stuck.board_id).first<Record<string, unknown>>();
          if (backup) await terminateFailoverSession(env, backup, sessionId).catch(() => undefined);
        }
        await db.prepare(
          "UPDATE backup_account SET status = 'idle', cooldown_until = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND status = 'reserved'",
        ).bind(timestamp, backupId, stuck.board_id).run().catch(() => undefined);
      }
      await db.prepare("DELETE FROM agent WHERE id = ? AND project_id = ?").bind(orphan.id, stuck.board_id).run();
    }
    await db.prepare(
      "UPDATE task_item SET spawn_status = 'requested', updated_at = ? WHERE id = ? AND spawn_status = 'spawning'",
    ).bind(timestamp, stuck.id).run();
  }
}

async function runWorkerSpawn(db: D1Database, env: Env, timestamp: string): Promise<void> {
  await reconcileStaleSpawns(db, env, timestamp);
  const pending = await db.prepare(
    `SELECT t.id AS task_id, t.board_id AS project_id, t.title, t.description, t.worker_profile_id
     FROM task_item t
     WHERE t.spawn_status = 'requested' AND t.deleted_at IS NULL
       AND t.phase IN ('pending', 'ready') AND t.worker_profile_id IS NOT NULL
     ORDER BY t.priority, t.sort_order, t.created_at
     LIMIT 25`,
  ).all<{ task_id: string; project_id: string; title: string; description: string; worker_profile_id: string }>();
  for (const candidate of pending.results) {
    // Atomically claim the task AND enforce the per-project concurrency cap in one
    // statement: D1 serializes writes, so folding the count into the CAS predicate makes
    // the quota race-free (unlike a separate count-then-act check).
    const claim = await db.prepare(
      `UPDATE task_item SET spawn_status = 'spawning', updated_at = ?
       WHERE id = ? AND spawn_status = 'requested'
         AND (
           SELECT COUNT(*) FROM task_item active
           WHERE active.board_id = ? AND active.deleted_at IS NULL AND active.id <> ?
             AND active.spawn_status IN ('spawning', 'spawned') AND active.phase <> 'done'
         ) < ?`,
    ).bind(timestamp, candidate.task_id, candidate.project_id, candidate.task_id, SPAWN_MAX_ACTIVE_PER_PROJECT).run();
    if ((claim.meta.changes ?? 0) !== 1) continue;
    const profile = await db.prepare(
      "SELECT * FROM worker_profile WHERE id = ? AND project_id = ? AND enabled = 1",
    ).bind(candidate.worker_profile_id, candidate.project_id).first<WorkerProfileRow>();
    if (!profile) {
      await db.batch([
        db.prepare("UPDATE task_item SET spawn_status = 'failed', updated_at = ? WHERE id = ? AND spawn_status = 'spawning'").bind(timestamp, candidate.task_id),
        event(db, candidate.task_id, "spawn_failed", null, { reason: "worker profile missing or disabled" }),
      ]);
      continue;
    }
    // Budget breaker: stop spawning new workers once the project has consumed its cumulative
    // spawn budget (0 = unlimited). Counted from spawn_created events so it survives restarts.
    const budgetRow = await db.prepare("SELECT spawn_budget_max FROM project WHERE id = ?")
      .bind(candidate.project_id).first<{ spawn_budget_max: number }>();
    const budgetMax = Number(budgetRow?.spawn_budget_max ?? 0);
    if (budgetMax > 0) {
      const usedRow = await db.prepare(
        "SELECT COUNT(*) AS c FROM task_event WHERE event_type = 'spawn_created' AND json_extract(payload_json, '$.project_id') = ?",
      ).bind(candidate.project_id).first<{ c: number }>();
      if (Number(usedRow?.c ?? 0) >= budgetMax) {
        await db.batch([
          db.prepare("UPDATE task_item SET spawn_status = 'failed', needs_human = 1, updated_at = ? WHERE id = ? AND spawn_status = 'spawning'")
            .bind(timestamp, candidate.task_id),
          event(db, candidate.task_id, "spawn_budget_exceeded", null, {
            project_id: candidate.project_id, budget_max: budgetMax, used: Number(usedRow?.c ?? 0),
          }),
        ]);
        await notifyLeader(db, candidate.project_id, "Spawn budget exceeded", {
          type: "spawn_budget_exceeded", task_id: candidate.task_id, budget_max: budgetMax, used: Number(usedRow?.c ?? 0),
        });
        continue;
      }
    }
    const backup = await reserveBackupAccount(db, candidate.project_id, profile.role_tag, timestamp);
    if (!backup) {
      await db.prepare(
        "UPDATE task_item SET spawn_status = 'requested', updated_at = ? WHERE id = ? AND spawn_status = 'spawning'",
      ).bind(timestamp, candidate.task_id).run();
      continue;
    }
    const taskForSession = {
      id: candidate.task_id,
      project_id: candidate.project_id,
      title: candidate.title,
      description: candidate.description,
    };
    let agent: { id: string; token: string } | null = null;
    let sessionId: string | null = null;
    try {
      agent = await registerSpawnAgent(db, candidate.project_id, candidate.task_id, profile.role_tag, backup);
      sessionId = await createWorkerSession(env, taskForSession, profile, backup, agent);
      // Persist the session id onto the agent immediately so that if the isolate dies
      // before the commit below, reconcileStaleSpawns can find and terminate this session.
      await db.prepare(
        "UPDATE agent SET metadata_json = json_set(metadata_json, '$.session_id', ?), updated_at = ? WHERE id = ? AND project_id = ?",
      ).bind(sessionId, timestamp, agent.id, candidate.project_id).run();
      // Commit the task transition first so we never leave a live session on a task
      // that was deleted or re-claimed while we were talking to the Devin API.
      const assigned = await db.prepare(
        "UPDATE task_item SET spawn_status = 'spawned', assignee_agent_id = ?, phase = CASE WHEN phase = 'pending' THEN 'ready' ELSE phase END, updated_at = ? WHERE id = ? AND spawn_status = 'spawning' AND deleted_at IS NULL",
      ).bind(agent.id, timestamp, candidate.task_id).run();
      if ((assigned.meta.changes ?? 0) !== 1) {
        await releaseSpawnResources(db, env, candidate.project_id, backup, agent, sessionId, timestamp);
        await event(db, candidate.task_id, "spawn_aborted", null, {
          project_id: candidate.project_id,
          worker_profile_id: profile.id,
          reason: "task no longer claimable when spawn completed",
        }).run().catch(() => undefined);
        continue;
      }
      const cooldownUntil = new Date(Date.now() + DEFAULT_FAILOVER_COOLDOWN_SECONDS * 1000).toISOString();
      await db.batch([
        db.prepare(
          "UPDATE backup_account SET status = 'active', cooldown_until = ?, last_used_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
        ).bind(cooldownUntil, timestamp, timestamp, backup.id, candidate.project_id),
        event(db, candidate.task_id, "spawn_created", agent.id, {
          project_id: candidate.project_id,
          worker_profile_id: profile.id,
          backup_account_id: String(backup.id),
          session_id: sessionId,
        }),
      ]);
    } catch (error) {
      await releaseSpawnResources(db, env, candidate.project_id, backup, agent, sessionId, timestamp);
      await db.batch([
        db.prepare(
          "UPDATE task_item SET spawn_status = 'failed', updated_at = ? WHERE id = ? AND spawn_status = 'spawning'",
        ).bind(timestamp, candidate.task_id),
        event(db, candidate.task_id, "spawn_failed", null, {
          project_id: candidate.project_id,
          worker_profile_id: profile.id,
          backup_account_id: String(backup.id),
          reason: error instanceof Error ? error.message : "worker session creation failed",
        }),
      ]);
    }
  }
}

async function sweepLeases(db: D1Database, env?: Env): Promise<void> {
  const timestamp = now();
  const staleIdempotencyBefore = new Date(Date.now() - IDEMPOTENCY_IN_PROGRESS_TTL_MS).toISOString();
  const hookDeliveryRetentionBefore = new Date(Date.now() - HOOK_DELIVERY_RETENTION_MS).toISOString();
  await db.prepare(
    "DELETE FROM idempotency_key WHERE response_status IS NULL AND created_at <= ?",
  ).bind(staleIdempotencyBefore).run();
  await db.prepare(
    "DELETE FROM hook_delivery WHERE status IN ('delivered', 'dead') AND updated_at <= ?",
  ).bind(hookDeliveryRetentionBefore).run();
  await db.prepare("DELETE FROM share_token WHERE expires_at < ?").bind(timestamp).run();
  await db.prepare(
    "UPDATE backup_account SET status = 'idle', cooldown_until = NULL, updated_at = ? WHERE status = 'reserved' AND updated_at <= ?",
  ).bind(timestamp, new Date(Date.now() - 10 * 60 * 1000).toISOString()).run().catch(() => undefined);
  await db.prepare(
    "UPDATE account_claim SET status = 'released', expires_at = ? WHERE status = 'claimed' AND expires_at <= ?",
  ).bind(timestamp, timestamp).run().catch(() => undefined);
  await db.prepare(
    "DELETE FROM failover_replacement WHERE status = 'reserved' AND updated_at <= ?",
  ).bind(new Date(Date.now() - FAILOVER_REPLACEMENT_RESERVATION_TIMEOUT_MS).toISOString()).run().catch(() => undefined);
  if (env) await runCloudFailover(db, env, timestamp);
  await db.prepare(
    "UPDATE task_item SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND phase = 'in_progress'",
  ).bind(timestamp, timestamp).run();
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const stale = await db.prepare(
    "SELECT id, project_id FROM agent WHERE last_seen_at IS NOT NULL AND last_seen_at <= ? AND status NOT IN ('idle', 'shutdown')",
  ).bind(staleBefore).all<{ id: string; project_id: string }>();
  for (const agent of stale.results) {
    await db.prepare(
      "UPDATE agent SET status = 'idle', updated_at = ? WHERE id = ? AND status NOT IN ('idle', 'shutdown')",
    ).bind(timestamp, agent.id).run();
    await releaseAgentLeases(db, agent.id, timestamp, true);
  }
}

function event(db: D1Database, taskId: string, type: string, actorId: string | null, payload: Json = {}): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO task_event(id, task_id, actor_agent_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id(), taskId, actorId, type, JSON.stringify(payload), now());
}

function conditionalEvent(
  db: D1Database,
  taskId: string,
  type: string,
  actorId: string | null,
  payload: Json,
  condition: string,
  values: unknown[],
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO task_event(id, task_id, actor_agent_id, event_type, payload_json, created_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE ${condition}`,
  ).bind(id(), taskId, actorId, type, JSON.stringify(payload), now(), ...values);
}

async function task(db: D1Database, taskId: string): Promise<Record<string, unknown> | null> {
  return db.prepare("SELECT * FROM task_item WHERE id = ?").bind(taskId).first<Record<string, unknown>>();
}

const D1_MAX_IN_PARAMS = 90;

async function selectByIdChunks<T>(
  db: D1Database,
  ids: string[],
  build: (placeholders: string) => string,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < ids.length; offset += D1_MAX_IN_PARAMS) {
    const chunk = ids.slice(offset, offset + D1_MAX_IN_PARAMS);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db.prepare(build(placeholders)).bind(...chunk).all<T>();
    out.push(...result.results);
  }
  return out;
}

async function listDependencies(db: D1Database, taskId: string): Promise<string[]> {
  const result = await db.prepare(
    "SELECT depends_on_id FROM task_dependency WHERE task_id = ? ORDER BY depends_on_id",
  ).bind(taskId).all<{ depends_on_id: string }>();
  return result.results.map((row) => row.depends_on_id);
}

async function listGates(db: D1Database, taskId: string): Promise<Record<string, unknown>[]> {
  const result = await db.prepare(
    "SELECT gate_name, status, by_agent, note, created_at, updated_at FROM task_gate WHERE task_id = ? ORDER BY gate_name",
  ).bind(taskId).all<Record<string, unknown>>();
  return result.results;
}

function dependencyGraphHasCycle(edges: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const dependency of edges.get(node) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...edges.keys()].some(visit);
}

async function taskView(db: D1Database, row: Record<string, unknown>) {
  return {
    ...row,
    required_gates: requiredGates(row),
    dependencies: await listDependencies(db, String(row.id)),
    gates: await listGates(db, String(row.id)),
  };
}

async function authorizeTask(
  db: D1Database,
  auth: Auth,
  taskId: string,
): Promise<{ row: Record<string, unknown> | null; error: Response | null }> {
  const row = await task(db, taskId);
  if (!row || row.deleted_at) return { row: null, error: json({ error: "task not found" }, 410) };
  if (!projectAllowed(auth, String(row.board_id))) {
    return { row: null, error: json({ error: "task belongs to another project" }, 403) };
  }
  return { row, error: null };
}

async function handleTask(request: Request, env: Env, auth: Auth, taskId?: string): Promise<Response> {
  const db = env.DB;
  const method = request.method;
  if (method === "GET" && !taskId) {
    const url = new URL(request.url);
    const requestedBoard = url.searchParams.get("board_id") || url.searchParams.get("project") || url.searchParams.get("board");
    if (requestedBoard && !projectAllowed(auth, requestedBoard)) {
      return json({ error: "project access denied" }, 403);
    }
    const board = requestedBoard || (isAdmin(auth) ? null : auth.projectId);
    const query = board
      ? db.prepare("SELECT * FROM task_item WHERE board_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at").bind(board)
      : db.prepare("SELECT * FROM task_item WHERE deleted_at IS NULL ORDER BY board_id, sort_order, created_at");
    const rows = (await query.all()).results as Record<string, unknown>[];
    return json({ tasks: await Promise.all(rows.map((row) => taskView(db, row))) });
  }
  if (!taskId && method === "POST") {
    const body = await parseBody(request);
    const boardId = String(body.board_id || "default");
    const denied = capabilityDenied(auth, "manage", { board_id: boardId });
    if (denied) return denied;
    if (!projectAllowed(auth, boardId)) return json({ error: "project access denied" }, 403);
    const project = await env.DB.prepare("SELECT id FROM project WHERE id = ?").bind(boardId).first();
    if (!project) return json({ error: "project not found" }, 422);
    const identityError = checkAgentIdentity(body, auth);
    if (identityError) return identityError;
    const assignee = body.assignee_agent_id ? String(body.assignee_agent_id) : null;
    if (assignee) {
      const assigneeRow = await env.DB.prepare("SELECT project_id FROM agent WHERE id = ?").bind(assignee).first<{ project_id: string }>();
      if (!assigneeRow) return json({ error: "assignee agent not found" }, 422);
      if (assigneeRow.project_id !== boardId) return json({ error: "assignee belongs to another project" }, 403);
    }
    const workerProfileId = body.worker_profile_id ? String(body.worker_profile_id).trim() : null;
    if (workerProfileId) {
      const profileRow = await env.DB.prepare(
        "SELECT project_id FROM worker_profile WHERE id = ?",
      ).bind(workerProfileId).first<{ project_id: string }>();
      if (!profileRow) return json({ error: "worker profile not found" }, 422);
      if (profileRow.project_id !== boardId) return json({ error: "worker profile belongs to another project" }, 403);
    }
    const spawnRequested = flag(body.spawn) === 1;
    if (spawnRequested && !workerProfileId) return json({ error: "spawn requires worker_profile_id" }, 422);
    const spawnStatus = spawnRequested ? "requested" : null;
    const key = idempotencyKey(request, body);
    const replay = await replayOrReserve(db, `task:create:${boardId}`, key);
    if (replay) return replay;
    const taskIdNew = id();
    const timestamp = now();
    const phase: Phase = body.phase === "ready" ? "ready" : "pending";
    const requirePlan = flag(body.require_plan);
    const requireAcceptance = flag(body.require_acceptance);
    const requiredGateNames = gateNames(body.required_gates);
    const responseBody = {
      id: taskIdNew,
      board_id: boardId,
      title: String(body.title || "").trim(),
      description: String(body.description || ""),
      phase,
      require_plan: requirePlan,
      require_acceptance: requireAcceptance,
      plan_text: null,
      plan_status: null,
      plan_agent_id: null,
      plan_submitted_at: null,
      plan_reviewed_by: null,
      plan_review_note: null,
      plan_reviewed_at: null,
      acceptance_status: null,
      acceptance_agent_id: null,
      acceptance_note: null,
      acceptance_at: null,
      required_gates: JSON.stringify(requiredGateNames),
      priority: Number(body.priority ?? 5),
      assignee_agent_id: assignee,
      worker_profile_id: workerProfileId,
      spawn_status: spawnStatus,
      sort_order: Number(body.sort_order ?? 0),
      dependencies: [],
      created_at: timestamp,
      updated_at: timestamp,
    };
    if (!responseBody.title) return json({ error: "title is required" }, 400);
    await db.batch([
      db.prepare(
        `INSERT INTO task_item(
          id, board_id, title, description, phase, require_plan, require_acceptance, required_gates, priority,
          assignee_agent_id, worker_profile_id, spawn_status, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        taskIdNew, responseBody.board_id, responseBody.title, responseBody.description, phase,
        requirePlan, requireAcceptance, responseBody.required_gates, responseBody.priority, responseBody.assignee_agent_id,
        workerProfileId, spawnStatus, responseBody.sort_order, timestamp, timestamp,
      ),
      event(db, taskIdNew, "created", actor(auth), {
        title: responseBody.title,
        ...(workerProfileId ? { worker_profile_id: workerProfileId } : {}),
        ...(spawnStatus ? { spawn_status: spawnStatus } : {}),
      }),
    ]);
    return saveIdempotentResponse(db, `task:create:${boardId}`, key, json(responseBody, 201));
  }
  if (!taskId) return json({ error: "not found" }, 404);
  const access = await authorizeTask(db, auth, taskId);
  if (access.error) return access.error;
  const current = access.row as Record<string, unknown>;
  if (method === "GET") return json(await taskView(db, current));
  if (method === "PATCH" || method === "DELETE") {
    const denied = capabilityDenied(auth, "manage", current);
    if (denied) return denied;
  }
  const body = await parseBody(request);
  const identityError = checkAgentIdentity(body, auth);
  if (identityError) return identityError;
  if (method === "PATCH") {
    const title = body.title === undefined ? current.title : String(body.title).trim();
    const description = body.description === undefined ? current.description : String(body.description);
    const priority = body.priority === undefined ? current.priority : Number(body.priority);
    const phase = body.phase === undefined ? current.phase : String(body.phase);
    const requirePlan = body.require_plan === undefined ? Number(current.require_plan ?? 0) : flag(body.require_plan);
    const requireAcceptance = body.require_acceptance === undefined ? Number(current.require_acceptance ?? 0) : flag(body.require_acceptance);
    const requestedAttempts = body.attempt_count === undefined
      ? Number(current.attempt_count ?? 0)
      : Math.max(0, Math.floor(Number(body.attempt_count)));
    const attemptCount = Number.isFinite(requestedAttempts) ? requestedAttempts : Number(current.attempt_count ?? 0);
    const blocked = phase === "pending" && attemptCount === 0 ? 0 : Number(current.blocked ?? 0);
    const requiredGateNames = body.required_gates === undefined
      ? requiredGates(current)
      : gateNames(body.required_gates);
    const assigneeSpecified = body.assignee_agent_id !== undefined;
    const assignee = !assigneeSpecified || body.assignee_agent_id === null || body.assignee_agent_id === ""
      ? (assigneeSpecified ? null : current.assignee_agent_id ?? null)
      : String(body.assignee_agent_id);
    if (!["pending", "ready", "in_progress", "done"].includes(String(phase))) {
      return json({ error: "invalid phase" }, 422);
    }
    if (assigneeSpecified && assignee !== null) {
      const target = await db.prepare(
        "SELECT id FROM agent WHERE id = ? AND project_id = ?",
      ).bind(assignee, String(current.board_id)).first();
      if (!target) return json({ error: "assignee agent not found in project" }, 422);
    }
    const profileSpecified = body.worker_profile_id !== undefined;
    const workerProfileId = !profileSpecified
      ? (current.worker_profile_id ? String(current.worker_profile_id) : null)
      : (body.worker_profile_id === null || body.worker_profile_id === "" ? null : String(body.worker_profile_id).trim());
    if (profileSpecified && workerProfileId !== null) {
      const profileRow = await db.prepare(
        "SELECT project_id FROM worker_profile WHERE id = ?",
      ).bind(workerProfileId).first<{ project_id: string }>();
      if (!profileRow) return json({ error: "worker profile not found" }, 422);
      if (profileRow.project_id !== String(current.board_id)) return json({ error: "worker profile belongs to another project" }, 403);
    }
    const requeueSpawn = flag(body.spawn) === 1;
    if (requeueSpawn && !workerProfileId) return json({ error: "spawn requires worker_profile_id" }, 422);
    const currentSpawnStatus = current.spawn_status ? String(current.spawn_status) : null;
    if (requeueSpawn && (currentSpawnStatus === "spawning" || currentSpawnStatus === "spawned")) {
      return json({ error: "task already has an active spawn" }, 409);
    }
    // Clearing the profile must also clear a pending spawn so it can't strand as 'requested'.
    const spawnStatus = requeueSpawn
      ? "requested"
      : (workerProfileId === null ? null : currentSpawnStatus);
    const nextRow = {
      ...current,
      require_plan: requirePlan,
      require_acceptance: requireAcceptance,
      required_gates: JSON.stringify(requiredGateNames),
    };
    const currentRequiresAcceptance = Number(current.require_acceptance ?? 0) === 1;
    const currentRequiresPlan = Number(current.require_plan ?? 0) === 1;
    if (phase === "done" && (requireAcceptance || currentRequiresAcceptance)) {
      return json({ error: "acceptance-required tasks must be accepted before done" }, 422);
    }
    if (phase === "done" && (requirePlan || currentRequiresPlan) && current.plan_status !== "approved") {
      return json({ error: "plan approval required before setting task done" }, 409);
    }
    if (phase === "done" && !(await qualityGatesSatisfied(db, nextRow))) {
      return json({ error: "required quality gates must pass before setting task done" }, 409);
    }
    const key = idempotencyKey(request, body);
    const replay = await replayOrReserve(db, `task:update:${taskId}`, key);
    if (replay) return replay;
    const timestamp = now();
    const responseBody = {
      ...current,
      title,
      description,
      priority,
      phase,
      require_plan: requirePlan,
      require_acceptance: requireAcceptance,
      required_gates: JSON.stringify(requiredGateNames),
      assignee_agent_id: assignee,
      worker_profile_id: workerProfileId,
      spawn_status: spawnStatus,
      attempt_count: attemptCount,
      blocked,
      lease_owner: phase === "done" ? null : current.lease_owner ?? null,
      lease_expires_at: phase === "done" ? null : current.lease_expires_at ?? null,
      updated_at: timestamp,
    };
    const gateRequirementsChanged = JSON.stringify(requiredGates(current)) !== responseBody.required_gates;
    await db.batch([
      db.prepare(
        `UPDATE task_item
         SET title = ?, description = ?, priority = ?, phase = ?, require_plan = ?, require_acceptance = ?, required_gates = ?, assignee_agent_id = ?, worker_profile_id = ?, spawn_status = ?, attempt_count = ?, blocked = ?,
             lease_owner = CASE WHEN ? = 'done' THEN NULL ELSE lease_owner END,
             lease_expires_at = CASE WHEN ? = 'done' THEN NULL ELSE lease_expires_at END,
             updated_at = ?
         WHERE id = ? AND deleted_at IS NULL AND board_id = ?`,
      ).bind(title, description, priority, phase, requirePlan, requireAcceptance, responseBody.required_gates, assignee, workerProfileId, spawnStatus, attemptCount, blocked, phase, phase, timestamp, taskId, String(current.board_id)),
      event(db, taskId, "updated", actor(auth), { phase, assignee_agent_id: assignee }),
      ...(phase === "done" && gateRequirementsChanged
        ? [event(db, taskId, "done_gate_requirements_changed", actor(auth), {
          project_id: String(current.board_id),
          previous_required_gates: requiredGates(current),
          required_gates: requiredGateNames,
        })]
        : []),
    ]);
    return saveIdempotentResponse(db, `task:update:${taskId}`, key, json(await taskView(db, responseBody)));
  }
  if (method === "DELETE") {
    const key = idempotencyKey(request, body);
    const replay = await replayOrReserve(db, `task:delete:${taskId}`, key);
    if (replay) return replay;
    const timestamp = now();
    await db.batch([
      db.prepare("UPDATE task_item SET deleted_at = ?, updated_at = ? WHERE id = ? AND board_id = ?").bind(timestamp, timestamp, taskId, String(current.board_id)),
      event(db, taskId, "deleted", actor(auth)),
    ]);
    return saveIdempotentResponse(db, `task:delete:${taskId}`, key, json({ ok: true }));
  }
  return json({ error: "method not allowed" }, 405);
}

async function notifyProjectLeaders(
  db: D1Database,
  projectId: string,
  subject: string,
  payload: Json,
): Promise<void> {
  const agents = await db.prepare(
    "SELECT id, role FROM agent WHERE project_id = ? AND status <> 'shutdown'",
  ).bind(projectId).all<{ id: string; role: string }>();
  const recipients = agents.results
    .filter((agent) => roleCapabilities(agent.role).includes("manage"))
    .map((agent) => agent.id);
  if (recipients.length === 0) return;
  const timestamp = now();
  const messageId = id();
  const message = db.prepare(
    `INSERT INTO message
     (id, project_id, sender_agent_id, kind, subject, payload_json, reply_to, idempotency_key, created_at)
     VALUES (?, ?, NULL, 'direct', ?, ?, NULL, NULL, ?)`,
  ).bind(messageId, projectId, subject, JSON.stringify(payload), timestamp);
  const deliveries = recipients.map((recipient) => db.prepare(
    `INSERT INTO message_delivery
     (id, message_id, project_id, recipient_agent_id, status, seen_at, acked_at, attempt_count, updated_at)
     VALUES (?, ?, ?, ?, 'unread', NULL, NULL, 0, ?)`,
  ).bind(id(), messageId, projectId, recipient, timestamp));
  await db.batch([message, ...deliveries]);
}

async function claimTask(request: Request, env: Env, auth: Auth, ctx: ExecutionContext, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "claim", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const identityError = checkAgentIdentity(body, auth);
  if (identityError) return identityError;
  const owner = bodyAgent(body, auth);
  if (!owner) return json({ error: "agent_id or x-agent-id is required" }, 400);
  const projectId = String(access.row?.board_id);
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, `task:claim:${taskId}`, key);
  if (replay) return replay;
  const currentAttempts = Number(access.row?.attempt_count ?? 0);
  if (Number(access.row?.blocked ?? 0) === 1 || currentAttempts >= MAX_TASK_ATTEMPTS) {
    const timestamp = now();
    const blocked = await env.DB.batch([
      env.DB.prepare(
        `UPDATE task_item
         SET blocked = 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND board_id = ? AND deleted_at IS NULL AND blocked = 0 AND attempt_count >= ?`,
      ).bind(timestamp, taskId, projectId, MAX_TASK_ATTEMPTS),
      conditionalEvent(
        env.DB,
        taskId,
        "task_blocked",
        owner,
        { project_id: projectId, attempt_count: currentAttempts, reason: "attempt threshold exceeded" },
        "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND blocked = 1 AND updated_at = ?)",
        [taskId, projectId, timestamp],
      ),
    ]);
    if ((blocked[0].meta.changes ?? 0) === 1) {
      await notifyProjectLeaders(env.DB, projectId, "疑似毒任务已熔断", {
        task_id: taskId,
        attempt_count: currentAttempts,
        reason: "task exceeded the retry attempt threshold",
      });
    }
    const blockedTask = await task(env.DB, taskId);
    const response = json({
      error: "task blocked after exceeding retry attempt threshold",
      task: await taskView(env.DB, blockedTask as Record<string, unknown>),
    }, 423);
    return saveIdempotentResponse(env.DB, `task:claim:${taskId}`, key, response);
  }
  const requestedLeaseSeconds = leaseSeconds(body.lease_seconds);
  const expires = new Date(Date.now() + requestedLeaseSeconds * 1000).toISOString();
  const generation = Number(body.lease_generation ?? 0);
  const timestamp = now();
  const update = env.DB.prepare(
    `UPDATE task_item
     SET phase = 'in_progress', lease_owner = ?, lease_expires_at = ?, lease_generation = lease_generation + 1,
         attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = ? AND board_id = ? AND deleted_at IS NULL
       AND blocked = 0 AND attempt_count < ?
       AND (phase IN ('pending', 'ready') OR (phase = 'in_progress' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND (assignee_agent_id IS NULL OR assignee_agent_id = ?)
       AND NOT EXISTS (
         SELECT 1 FROM task_dependency d
         JOIN task_item dependency ON dependency.id = d.depends_on_id
         WHERE d.task_id = task_item.id AND (dependency.deleted_at IS NOT NULL OR dependency.phase <> 'done')
       )
       AND (? = 0 OR lease_generation = ?)`
  ).bind(owner, expires, timestamp, taskId, projectId, MAX_TASK_ATTEMPTS, timestamp, timestamp, owner, generation, generation);
  const result = await env.DB.batch([
    update,
    conditionalEvent(
      env.DB,
      taskId,
      "claimed",
      owner,
      { lease_expires_at: expires, project_id: projectId },
      "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND lease_owner = ? AND updated_at = ?)",
      [taskId, projectId, owner, timestamp],
    ),
  ]);
  const changed = result[0].meta.changes ?? 0;
  if (changed !== 1) {
    const row = await task(env.DB, taskId);
    if (!row || row.deleted_at) return json({ error: "task gone" }, 410);
    if (!projectAllowed(auth, String(row.board_id))) return json({ error: "project access denied" }, 403);
    if (row.lease_owner && row.lease_expires_at && String(row.lease_expires_at) > timestamp) {
      return json({ error: "lease held", task: row }, 409);
    }
    return json({ error: "task is unclaimable or dependencies are unmet", task: await taskView(env.DB, row) }, 422);
  }
  const claimed = await task(env.DB, taskId);
  dispatchHooks(ctx, env, projectId, "task_claimed", "post", { task_id: taskId, actor_agent_id: owner, lease_expires_at: expires });
  const response = json(await taskView(env.DB, claimed as Record<string, unknown>), 200);
  return saveIdempotentResponse(env.DB, `task:claim:${taskId}`, key, response);
}

async function renewTask(request: Request, env: Env, auth: Auth, ctx: ExecutionContext, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "claim", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const identityError = checkAgentIdentity(body, auth);
  if (identityError) return identityError;
  const owner = bodyAgent(body, auth);
  if (!owner) return json({ error: "agent_id or x-agent-id is required" }, 400);
  const generation = Number(body.lease_generation);
  if (!Number.isInteger(generation) || generation < 0) {
    return json({ error: "lease_generation is required" }, 400);
  }
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, `task:renew:${taskId}`, key);
  if (replay) return replay;
  const timestamp = now();
  const expires = new Date(Date.now() + leaseSeconds(body.lease_seconds) * 1000).toISOString();
  const projectId = String(access.row?.board_id);
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_item
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND board_id = ? AND deleted_at IS NULL AND phase = 'in_progress'
         AND lease_owner = ? AND lease_generation = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
    ).bind(expires, timestamp, taskId, projectId, owner, generation, timestamp),
    conditionalEvent(
      env.DB,
      taskId,
      "lease_renewed",
      owner,
      { lease_expires_at: expires, lease_generation: generation, project_id: projectId },
      "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at = ? AND updated_at = ?)",
      [taskId, projectId, owner, generation, expires, timestamp],
    ),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) {
    return json({ error: "lease not owned or already expired" }, 409);
  }
  dispatchHooks(ctx, env, projectId, "task_lease_renewed", "post", {
    task_id: taskId,
    actor_agent_id: owner,
    lease_expires_at: expires,
    lease_generation: generation,
  });
  return saveIdempotentResponse(
    env.DB,
    `task:renew:${taskId}`,
    key,
    json(await taskView(env.DB, await task(env.DB, taskId) as Record<string, unknown>)),
  );
}

async function releaseTask(request: Request, env: Env, auth: Auth, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const body = await parseBody(request);
  const currentOwner = access.row?.lease_owner ? String(access.row.lease_owner) : null;
  const requestedOwner = body.agent_id === null ? null : (body.agent_id === undefined ? currentOwner : String(body.agent_id));
  const override = requestedOwner !== null && (isAdmin(auth) || auth.agentId !== requestedOwner);
  const denied = override
    ? capabilityDenied(auth, "manage", access.row)
    : capabilityDenied(auth, "release", access.row);
  if (denied) return denied;
  if (!override) {
    const identityError = checkAgentIdentity(body, auth);
    if (identityError) return identityError;
  }
  const owner = requestedOwner || bodyAgent(body, auth);
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, `task:release:${taskId}`, key);
  if (replay) return replay;
  const timestamp = now();
  const projectId = String(access.row?.board_id);
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE task_item SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND board_id = ? AND lease_owner = ? AND deleted_at IS NULL",
    ).bind(timestamp, taskId, projectId, owner),
    conditionalEvent(env.DB, taskId, "released", actor(auth), { project_id: projectId, released_agent_id: owner, forced: override }, "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND lease_owner IS NULL AND updated_at = ?)", [taskId, projectId, timestamp]),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "lease not owned" }, 409);
  return saveIdempotentResponse(env.DB, `task:release:${taskId}`, key, json({ ok: true }));
}

async function reassignTask(request: Request, env: Env, auth: Auth, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "manage", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const assignee = body.assignee_agent_id === null || body.assignee_agent_id === ""
    ? null
    : (body.assignee_agent_id === undefined ? undefined : String(body.assignee_agent_id));
  if (assignee !== null && assignee !== undefined) {
    const target = await env.DB.prepare("SELECT id FROM agent WHERE id = ? AND project_id = ?").bind(assignee, access.row?.board_id).first();
    if (!target) return json({ error: "assignee agent not found in project" }, 422);
  }
  const current = access.row as Record<string, unknown>;
  const timestamp = now();
  const nextPhase = current.phase === "in_progress" ? "ready" : current.phase;
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_item
       SET assignee_agent_id = ?, phase = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND board_id = ? AND deleted_at IS NULL`,
    ).bind(assignee ?? null, nextPhase, timestamp, taskId, current.board_id),
    event(env.DB, taskId, "reassigned", actor(auth), {
      project_id: current.board_id,
      assignee_agent_id: assignee ?? null,
      previous_assignee_agent_id: current.assignee_agent_id ?? null,
      previous_lease_owner: current.lease_owner ?? null,
    }),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "task not found" }, 404);
  return json(await taskView(env.DB, await task(env.DB, taskId) as Record<string, unknown>));
}

async function completeTask(request: Request, env: Env, auth: Auth, ctx: ExecutionContext, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "complete", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const identityError = checkAgentIdentity(body, auth);
  if (identityError) return identityError;
  const owner = bodyAgent(body, auth);
  const current = access.row as Record<string, unknown>;
  const timestamp = now();
  const leaseOverride = canManage(auth);
  if (!leaseOverride && (
    current.lease_owner !== owner ||
    !current.lease_expires_at ||
    String(current.lease_expires_at) <= timestamp
  )) {
    return json({ error: "an active lease owned by the completing agent is required" }, 409);
  }
  if (Number(current.require_plan ?? 0) === 1 && current.plan_status !== "approved") {
    return json({ error: "plan approval required before completion" }, 409);
  }
  if (!(await qualityGatesSatisfied(env.DB, current))) {
    return json({ error: "required quality gates must pass before completion" }, 409);
  }
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, `task:complete:${taskId}`, key);
  if (replay) return replay;
  const projectId = String(access.row?.board_id);
  const requiresAcceptance = Number(current.require_acceptance ?? 0) === 1;
  const leaseCondition = leaseOverride
    ? ""
    : " AND lease_owner = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > ?";
  const leaseValues = leaseOverride ? [] : [owner, timestamp];
  const result = await env.DB.batch([
    requiresAcceptance
      ? env.DB.prepare(
        `UPDATE task_item
         SET acceptance_status = 'submitted', acceptance_agent_id = ?, acceptance_note = ?,
             acceptance_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND board_id = ? AND deleted_at IS NULL${leaseCondition}`,
      ).bind(owner, body.result === undefined ? null : String(body.result), timestamp, timestamp, taskId, projectId, ...leaseValues)
      : env.DB.prepare(
        `UPDATE task_item SET phase = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND board_id = ? AND deleted_at IS NULL${leaseCondition}`,
      ).bind(timestamp, taskId, projectId, ...leaseValues),
    conditionalEvent(
      env.DB,
      taskId,
      requiresAcceptance ? "completion_submitted" : "completed",
      owner,
      { result: body.result ?? null, project_id: projectId, acceptance_required: requiresAcceptance },
      requiresAcceptance
        ? "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND acceptance_status = 'submitted' AND updated_at = ?)"
        : "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND phase = 'done' AND updated_at = ?)",
      [taskId, projectId, timestamp],
    ),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "task not found or lease not owned" }, 409);
  const completed = await task(env.DB, taskId);
  dispatchHooks(ctx, env, projectId, requiresAcceptance ? "task_completion_submitted" : "task_completed", "post", { task_id: taskId, actor_agent_id: owner, result: body.result ?? null });
  return saveIdempotentResponse(env.DB, `task:complete:${taskId}`, key, json(await taskView(env.DB, completed as Record<string, unknown>)));
}

async function submitPlan(request: Request, env: Env, auth: Auth, ctx: ExecutionContext, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "plan_submit", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const identityError = checkAgentIdentity(body, auth);
  if (identityError) return identityError;
  const plan = typeof body.plan === "string" ? body.plan.trim() : "";
  if (!plan) return json({ error: "plan is required" }, 400);
  const current = access.row as Record<string, unknown>;
  const owner = bodyAgent(body, auth);
  const timestamp = now();
  const projectId = String(current.board_id);
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_item
       SET plan_text = ?, plan_status = 'submitted', plan_agent_id = ?,
           plan_submitted_at = ?, plan_reviewed_by = NULL, plan_review_note = NULL,
           plan_reviewed_at = NULL, updated_at = ?
       WHERE id = ? AND board_id = ? AND deleted_at IS NULL AND phase = 'in_progress'
         AND lease_owner = ? AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
    ).bind(plan, owner, timestamp, timestamp, taskId, projectId, owner, timestamp),
    conditionalEvent(
      env.DB,
      taskId,
      "plan_submitted",
      actor(auth),
      { project_id: projectId },
      "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND plan_status = 'submitted' AND updated_at = ?)",
      [taskId, projectId, timestamp],
    ),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) {
    return json({ error: "plan requires an active lease owned by the submitting agent" }, 409);
  }
  dispatchHooks(ctx, env, projectId, "plan_submitted", "post", { task_id: taskId, actor_agent_id: owner });
  return json(await taskView(env.DB, await task(env.DB, taskId) as Record<string, unknown>));
}

async function reviewPlan(request: Request, env: Env, auth: Auth, ctx: ExecutionContext, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "plan_review", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
  if (!decision) return json({ error: "decision must be approve or reject" }, 400);
  const current = access.row as Record<string, unknown>;
  if (current.plan_status !== "submitted") return json({ error: "plan is not awaiting review" }, 409);
  const note = body.note === undefined ? null : String(body.note);
  const timestamp = now();
  const projectId = String(current.board_id);
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_item
       SET plan_status = ?, plan_reviewed_by = ?, plan_review_note = ?, plan_reviewed_at = ?, updated_at = ?
       WHERE id = ? AND board_id = ? AND deleted_at IS NULL AND plan_status = 'submitted'`,
    ).bind(decision === "approve" ? "approved" : "rejected", actor(auth), note, timestamp, timestamp, taskId, projectId),
    conditionalEvent(
      env.DB,
      taskId,
      "plan_reviewed",
      actor(auth),
      { decision, note, project_id: projectId },
      "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND updated_at = ?)",
      [taskId, projectId, timestamp],
    ),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "plan changed; retry" }, 409);
  dispatchHooks(ctx, env, projectId, "plan_reviewed", decision === "reject" ? "failure" : "post", { task_id: taskId, actor_agent_id: actor(auth), decision, note });
  return json(await taskView(env.DB, await task(env.DB, taskId) as Record<string, unknown>));
}

async function acceptance(request: Request, env: Env, auth: Auth, ctx: ExecutionContext, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "accept", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const decision = body.decision === "accept" || body.decision === "reject" ? body.decision : null;
  if (!decision) return json({ error: "decision must be accept or reject" }, 400);
  const current = access.row as Record<string, unknown>;
  if (Number(current.require_acceptance ?? 0) !== 1) return json({ error: "acceptance is not required for this task" }, 422);
  if (current.acceptance_status !== "submitted") return json({ error: "task is not awaiting acceptance" }, 409);
  if (!(await qualityGatesSatisfied(env.DB, current))) {
    return json({ error: "required quality gates must pass before acceptance" }, 409);
  }
  const note = body.note === undefined ? null : String(body.note);
  const timestamp = now();
  const projectId = String(current.board_id);
  const accepted = decision === "accept";
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_item
       SET phase = ?, acceptance_status = ?, acceptance_agent_id = ?, acceptance_note = ?,
           acceptance_at = ?, lease_owner = CASE WHEN ? = 'done' THEN NULL ELSE lease_owner END,
           lease_expires_at = CASE WHEN ? = 'done' THEN NULL ELSE lease_expires_at END, updated_at = ?
       WHERE id = ? AND board_id = ? AND deleted_at IS NULL
         AND require_acceptance = 1 AND acceptance_status = 'submitted' AND phase = 'in_progress'`,
    ).bind(
      accepted ? "done" : "in_progress",
      accepted ? "accepted" : "rejected",
      actor(auth),
      note,
      timestamp,
      accepted ? "done" : "in_progress",
      accepted ? "done" : "in_progress",
      timestamp,
      taskId,
      projectId,
    ),
    conditionalEvent(
      env.DB,
      taskId,
      accepted ? "accepted" : "acceptance_rejected",
      actor(auth),
      { decision, note, project_id: projectId },
      accepted
        ? "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND phase = 'done' AND acceptance_status = 'accepted' AND updated_at = ?)"
        : "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND phase = 'in_progress' AND acceptance_status = 'rejected' AND updated_at = ?)",
      [taskId, projectId, timestamp],
    ),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "acceptance changed; retry" }, 409);
  dispatchHooks(ctx, env, projectId, accepted ? "task_accepted" : "task_acceptance_rejected", accepted ? "post" : "failure", { task_id: taskId, actor_agent_id: actor(auth), decision, note });
  return json(await taskView(env.DB, await task(env.DB, taskId) as Record<string, unknown>));
}

async function recordGate(
  request: Request,
  env: Env,
  auth: Auth,
  ctx: ExecutionContext,
  taskId: string,
): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "gate", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const gate = typeof body.gate === "string" ? body.gate.trim() : "";
  const decision = body.decision === "pass" || body.decision === "fail" ? body.decision : null;
  if (!gate || !decision) return json({ error: "gate and decision must be provided" }, 400);
  const current = access.row as TaskRow;
  if (!requiredGates(current).includes(gate)) return json({ error: "gate is not required by this task" }, 422);
  if (current.phase !== "in_progress" && current.phase !== "done") {
    return json({ error: "gate requires an in_progress or done task" }, 422);
  }
  const timestamp = now();
  const note = body.note === undefined ? null : String(body.note);
  const projectId = String(current.board_id);
  const gateId = id();
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO task_gate(id, task_id, gate_name, status, by_agent, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, gate_name) DO UPDATE SET
         status = excluded.status, by_agent = excluded.by_agent, note = excluded.note, updated_at = excluded.updated_at`,
    ).bind(gateId, taskId, gate, decision === "pass" ? "passed" : "failed", actor(auth), note, timestamp, timestamp),
    event(
      env.DB,
      taskId,
      decision === "pass" ? "gate_passed" : "gate_failed",
      actor(auth),
      { gate, note, project_id: projectId },
    ),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "gate update failed" }, 409);
  dispatchHooks(ctx, env, projectId, decision === "pass" ? "gate_passed" : "gate_failed", decision === "fail" ? "failure" : "post", {
    task_id: taskId,
    gate,
    decision,
    note,
    actor_agent_id: actor(auth),
  });
  const gateRow = await env.DB.prepare("SELECT * FROM task_gate WHERE task_id = ? AND gate_name = ?").bind(taskId, gate).first();
  return json({ gate: gateRow, task: await taskView(env.DB, await task(env.DB, taskId) as Record<string, unknown>) });
}

async function dependencies(request: Request, env: Env, auth: Auth, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "manage", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const ids = Array.isArray(body.depends_on) ? body.depends_on.map(String) : [];
  if (ids.includes(taskId)) return json({ error: "dependency cycle" }, 422);
  const projectId = String(access.row?.board_id);
  const placeholders = ids.map(() => "?").join(",") || "NULL";
  const existing = ids.length
    ? await env.DB.prepare(`SELECT id, board_id FROM task_item WHERE id IN (${placeholders}) AND deleted_at IS NULL`).bind(...ids).all<{ id: string; board_id: string }>()
    : { results: [] };
  if (existing.results.length !== ids.length) return json({ error: "dependency task not found" }, 422);
  if (existing.results.some((row) => row.board_id !== projectId)) {
    return json({ error: "dependency belongs to another project" }, 403);
  }
  const projectTasks = await env.DB.prepare(
    "SELECT id FROM task_item WHERE board_id = ? AND deleted_at IS NULL",
  ).bind(projectId).all<{ id: string }>();
  const dependencyRows = await env.DB.prepare(
    `SELECT d.task_id, d.depends_on_id
     FROM task_dependency d
     JOIN task_item t ON t.id = d.task_id
     WHERE t.board_id = ? AND t.deleted_at IS NULL`,
  ).bind(projectId).all<{ task_id: string; depends_on_id: string }>();
  const graph = new Map<string, string[]>(
    projectTasks.results.map((row) => [row.id, []]),
  );
  for (const row of dependencyRows.results) {
    graph.set(row.task_id, [...(graph.get(row.task_id) ?? []), row.depends_on_id]);
  }
  graph.set(taskId, ids);
  if (dependencyGraphHasCycle(graph)) return json({ error: "dependency cycle" }, 422);
  const timestamp = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM task_dependency WHERE task_id = ?").bind(taskId),
    ...ids.map((dependencyId) => env.DB.prepare("INSERT INTO task_dependency(task_id, depends_on_id) VALUES (?, ?)").bind(taskId, dependencyId)),
    event(env.DB, taskId, "dependencies_updated", actor(auth), { depends_on: ids, project_id: projectId }),
  ];
  await env.DB.batch(statements);
  return json({ task_id: taskId, depends_on: ids, updated_at: timestamp });
}

async function assessTask(
  request: Request,
  env: Env,
  auth: Auth,
  taskId: string,
  capability: "review" | "verify",
): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, capability, access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const decision = body.decision === "pass" || body.decision === "reject" ? body.decision : null;
  if (!decision) return json({ error: "decision must be pass or reject" }, 400);
  const current = access.row as TaskRow;
  if (current.phase !== "in_progress" && current.phase !== "done") {
    return json({ error: `${capability} requires an in_progress or done task` }, 422);
  }
  const note = body.note === undefined ? null : String(body.note);
  const timestamp = now();
  const statusColumn = capability === "review" ? "review_status" : "verify_status";
  const agentColumn = capability === "review" ? "review_agent_id" : "verify_agent_id";
  const noteColumn = capability === "review" ? "review_note" : "verify_note";
  const timeColumn = capability === "review" ? "reviewed_at" : "verified_at";
  const eventType = capability === "review" ? "reviewed" : "verified";
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_item
       SET ${statusColumn} = ?, ${agentColumn} = ?, ${noteColumn} = ?, ${timeColumn} = ?, updated_at = ?
       WHERE id = ? AND board_id = ? AND deleted_at IS NULL AND phase IN ('in_progress', 'done')`,
    ).bind(decision, actor(auth), note, timestamp, timestamp, taskId, String(current.board_id)),
    conditionalEvent(
      env.DB,
      taskId,
      eventType,
      actor(auth),
      { decision, note, capability, project_id: String(current.board_id) },
      "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND updated_at = ? AND phase IN ('in_progress', 'done'))",
      [taskId, String(current.board_id), timestamp],
    ),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: `${capability} task phase changed; retry` }, 422);
  const updated = await task(env.DB, taskId);
  return json(await taskView(env.DB, updated as TaskRow));
}

function mailboxPayload(row: Record<string, unknown>): unknown {
  const value = String(row.payload_json ?? "");
  if (!value) return "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mailboxMessageView(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, payload: mailboxPayload(row) };
}

async function mailboxCursor(
  secret: string,
  projectId: string,
  mode: "inbox" | "sent",
  createdAt: string,
  rowId: string,
): Promise<string> {
  const encoded = base64(new TextEncoder().encode(JSON.stringify({
    project_id: projectId, mode, created_at: createdAt, id: rowId,
  })));
  return `${encoded}.${await hmacSha256(secret, encoded)}`;
}

async function parseMailboxCursor(
  secret: string,
  value: string | null,
  projectId: string,
  mode: "inbox" | "sent",
): Promise<{ created_at: string; id: string } | null> {
  if (!value) return null;
  try {
    const [encoded, signature] = value.split(".");
    if (!encoded || !signature || signature !== await hmacSha256(secret, encoded)) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64(encoded))) as Record<string, unknown>;
    if (
      parsed.project_id !== projectId ||
      parsed.mode !== mode ||
      typeof parsed.created_at !== "string" ||
      typeof parsed.id !== "string"
    ) return null;
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    return null;
  }
}

async function mailboxDeliveryView(db: D1Database, deliveryId: string): Promise<Record<string, unknown> | null> {
  const row = await db.prepare(
    `SELECT d.*, m.sender_agent_id, m.kind, m.subject, m.payload_json, m.reply_to, m.created_at AS message_created_at
     FROM message_delivery d
     JOIN message m ON m.id = d.message_id
     WHERE d.id = ?`,
  ).bind(deliveryId).first<Record<string, unknown>>();
  return row ? { ...row, payload: mailboxPayload(row) } : null;
}

async function mailboxProject(request: Request, auth: Auth, body?: Json): Promise<string | null> {
  if (!isAdmin(auth)) {
    const requested = new URL(request.url).searchParams.get("project_id") ||
      (typeof body?.project_id === "string" ? body.project_id : null);
    return requested && requested !== auth.projectId ? null : auth.projectId;
  }
  return (typeof body?.project_id === "string" ? body.project_id : null) ||
    new URL(request.url).searchParams.get("project_id");
}

async function sendMailboxMessage(request: Request, env: Env, auth: Auth): Promise<Response> {
  const body = await parseBody(request);
  const projectId = await mailboxProject(request, auth, body);
  if (!projectId) return json({ error: "project access denied" }, 403);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id = ?").bind(projectId).first();
  if (!project) return json({ error: "project not found" }, 422);

  const senderId = isAdmin(auth)
    ? (typeof body.sender_agent_id === "string" ? body.sender_agent_id.trim() : auth.agentId || "")
    : auth.agentId;
  if (senderId) {
    const sender = await env.DB.prepare("SELECT project_id FROM agent WHERE id = ?").bind(senderId).first<{ project_id: string }>();
    if (!sender) return json({ error: "sender agent not found" }, 422);
    if (sender.project_id !== projectId) return json({ error: "sender belongs to another project" }, 403);
  }

  const replyTo = typeof body.reply_to === "string" && body.reply_to.trim() ? body.reply_to.trim() : null;
  if (replyTo) {
    const parent = await env.DB.prepare("SELECT project_id FROM message WHERE id = ?").bind(replyTo).first<{ project_id: string }>();
    if (!parent) return json({ error: "reply message not found" }, 422);
    if (parent.project_id !== projectId) return json({ error: "reply message belongs to another project" }, 403);
  }

  const to = body.to === "broadcast"
    ? "broadcast"
    : Array.isArray(body.to)
      ? [...new Set(body.to.map(String).map((value) => value.trim()).filter(Boolean))]
      : null;
  if (to !== "broadcast" && (!to || to.length === 0)) {
    return json({ error: "to must be a non-empty agent id array or broadcast" }, 400);
  }

  let recipients: string[];
  if (to === "broadcast") {
    const rows = await env.DB.prepare(
      "SELECT id FROM agent WHERE project_id = ? AND (? = '' OR id <> ?) ORDER BY id",
    ).bind(projectId, senderId || "", senderId || "").all<{ id: string }>();
    recipients = rows.results.map((row) => row.id);
  } else {
    const placeholders = to.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, project_id FROM agent WHERE id IN (${placeholders})`,
    ).bind(...to).all<{ id: string; project_id: string }>();
    if (rows.results.length !== to.length) return json({ error: "recipient agent not found" }, 422);
    if (rows.results.some((row) => row.project_id !== projectId)) {
      return json({ error: "recipient belongs to another project" }, 403);
    }
    recipients = to;
  }

  const payloadValue = body.body !== undefined ? body.body : body.payload;
  const payloadJson = payloadValue === undefined
    ? ""
    : typeof payloadValue === "string"
      ? JSON.stringify(payloadValue)
      : JSON.stringify(payloadValue);
  const messageId = id();
  const timestamp = now();
  const kind = to === "broadcast" ? "broadcast" : "direct";
  const subject = body.subject === undefined ? null : String(body.subject);
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, `mailbox:send:${projectId}`, key);
  if (replay) return replay;
  const message = {
    id: messageId,
    project_id: projectId,
    sender_agent_id: senderId || null,
    kind,
    subject,
    payload_json: payloadJson,
    reply_to: replyTo,
    idempotency_key: key || null,
    created_at: timestamp,
  };
  const deliveries = recipients.map((recipientAgentId) => ({
    id: id(),
    message_id: messageId,
    project_id: projectId,
    recipient_agent_id: recipientAgentId,
    status: "unread" as MailboxStatus,
    seen_at: null,
    acked_at: null,
    attempt_count: 0,
    updated_at: timestamp,
  }));
  // Return the prior result if this idempotency key already produced a message
  // (replayOrReserve above guards the common case; this covers a slipped-through race).
  if (key) {
    const existing = await env.DB.prepare(
      "SELECT * FROM message WHERE project_id = ? AND idempotency_key = ?",
    ).bind(projectId, key).first<Record<string, unknown>>();
    if (existing) {
      const existingDeliveries = await env.DB.prepare(
        "SELECT * FROM message_delivery WHERE message_id = ? ORDER BY id",
      ).bind(String(existing.id)).all<Record<string, unknown>>();
      return json({
        message: { ...existing, payload: mailboxPayload(existing) },
        deliveries: existingDeliveries.results,
      }, 201);
    }
  }
  // Insert the message and all of its deliveries atomically so an isolate death can
  // never leave a message row with no delivery rows (or vice versa).
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO message(id, project_id, sender_agent_id, kind, subject, payload_json, reply_to, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    ).bind(
      message.id, message.project_id, message.sender_agent_id, message.kind, message.subject,
      message.payload_json, message.reply_to, message.idempotency_key, message.created_at,
    ),
    ...deliveries.map((delivery) => env.DB.prepare(
      "INSERT INTO message_delivery(id, message_id, project_id, recipient_agent_id, status, seen_at, acked_at, attempt_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(delivery.id, delivery.message_id, delivery.project_id, delivery.recipient_agent_id, delivery.status, delivery.seen_at, delivery.acked_at, delivery.attempt_count, delivery.updated_at)),
  ]);
  const response = json({
    message: { ...message, payload: mailboxPayload(message) },
    deliveries,
  }, 201);
  return saveIdempotentResponse(env.DB, `mailbox:send:${projectId}`, key, response);
}

async function listMailbox(request: Request, env: Env, auth: Auth, sent: boolean): Promise<Response> {
  const url = new URL(request.url);
  const requestedProject = url.searchParams.get("project_id") || url.searchParams.get("project");
  if (!isAdmin(auth) && requestedProject && requestedProject !== auth.projectId) {
    return json({ error: "project access denied" }, 403);
  }
  const projectId = requestedProject || (isAdmin(auth) ? null : auth.projectId);
  const status = url.searchParams.get("status");
  const parsedLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(parsedLimit) ? Math.min(200, Math.max(1, Math.floor(parsedLimit))) : 50;
  const cursorValue = url.searchParams.get("cursor");
  const cursorScope = projectId ?? "*";
  const cursor = await parseMailboxCursor(env.BOARD_TOKEN, cursorValue, cursorScope, sent ? "sent" : "inbox");
  if (cursorValue && !cursor) return json({ error: "invalid mailbox cursor" }, 400);
  const validStatuses: MailboxStatus[] = ["unread", "seen", "acked", "nacked", "dead"];
  if (!sent && status && !validStatuses.includes(status as MailboxStatus)) {
    return json({ error: "invalid mailbox status" }, 400);
  }
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (projectId) {
    conditions.push(sent ? "m.project_id = ?" : "d.project_id = ?");
    values.push(projectId);
  }
  if (sent) {
    if (!isAdmin(auth) && !isMailboxInspector(auth)) {
      conditions.push("m.sender_agent_id = ?");
      values.push(auth.agentId);
    }
    if (isMailboxInspector(auth) && !isAdmin(auth)) {
      conditions.push("m.project_id = ?");
      values.push(auth.projectId);
    }
    if (cursor) {
      conditions.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      values.push(cursor.created_at, cursor.created_at, cursor.id);
    }
  } else {
    if (!isAdmin(auth) && !isMailboxInspector(auth)) {
      conditions.push("d.recipient_agent_id = ?");
      values.push(auth.agentId);
    }
    if (isMailboxInspector(auth) && !isAdmin(auth)) {
      conditions.push("d.project_id = ?");
      values.push(auth.projectId);
    }
    if (status) {
      conditions.push("d.status = ?");
      values.push(status);
    }
    if (cursor) {
      conditions.push("(d.updated_at < ? OR (d.updated_at = ? AND d.id < ?))");
      values.push(cursor.created_at, cursor.created_at, cursor.id);
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = sent
    ? `SELECT m.* FROM message m ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`
    : `SELECT d.*, m.sender_agent_id, m.kind, m.subject, m.payload_json, m.reply_to, m.created_at AS message_created_at
       FROM message_delivery d JOIN message m ON m.id = d.message_id ${where} ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`;
  const rows = await env.DB.prepare(query).bind(...values, limit + 1).all<Record<string, unknown>>();
  const hasMore = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? await mailboxCursor(
      env.BOARD_TOKEN,
      cursorScope,
      sent ? "sent" : "inbox",
      String(sent ? last.created_at : last.updated_at),
      String(last.id),
    )
    : null;
  return json({
    messages: sent ? page.map(mailboxMessageView) : [],
    deliveries: sent ? [] : page.map((row) => ({ ...row, payload: mailboxPayload(row) })),
    next_cursor: nextCursor,
  });
}

async function getMailboxMessage(env: Env, auth: Auth, messageId: string): Promise<Response> {
  const message = await env.DB.prepare("SELECT * FROM message WHERE id = ?").bind(messageId).first<Record<string, unknown>>();
  if (!message) return json({ error: "message not found" }, 404);
  const projectId = String(message.project_id);
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  let allowed = isMailboxInspector(auth) || message.sender_agent_id === auth.agentId;
  if (!isAdmin(auth) && !allowed) {
    const delivery = await env.DB.prepare(
      "SELECT id FROM message_delivery WHERE message_id = ? AND recipient_agent_id = ?",
    ).bind(messageId, auth.agentId).first();
    allowed = Boolean(delivery);
  }
  if (!allowed) return json({ error: "message access denied" }, 403);
  const deliveries = await env.DB.prepare(
    "SELECT * FROM message_delivery WHERE message_id = ? ORDER BY recipient_agent_id",
  ).bind(messageId).all<Record<string, unknown>>();
  return json({
    message: mailboxMessageView(message),
    deliveries: deliveries.results,
  });
}

async function authorizeMailboxDelivery(
  env: Env,
  auth: Auth,
  deliveryId: string,
): Promise<{ row: Record<string, unknown> | null; error: Response | null }> {
  const row = await env.DB.prepare(
    "SELECT * FROM message_delivery WHERE id = ?",
  ).bind(deliveryId).first<Record<string, unknown>>();
  if (!row) return { row: null, error: json({ error: "delivery not found" }, 404) };
  if (!projectAllowed(auth, String(row.project_id))) {
    return { row: null, error: json({ error: "project access denied" }, 403) };
  }
  if (!isMailboxInspector(auth) && row.recipient_agent_id !== auth.agentId) {
    return { row: null, error: json({ error: "delivery access denied" }, 403) };
  }
  return { row, error: null };
}

async function transitionMailboxDelivery(
  request: Request,
  env: Env,
  auth: Auth,
  ctx: ExecutionContext,
  deliveryId: string,
  action: "seen" | "ack" | "nack",
): Promise<Response> {
  const access = await authorizeMailboxDelivery(env, auth, deliveryId);
  if (access.error) return access.error;
  const row = access.row as Record<string, unknown>;
  const projectId = String(row.project_id);
  const recipientCondition = isMailboxInspector(auth)
    ? "project_id = ?"
    : "project_id = ? AND recipient_agent_id = ?";
  const recipientValues = isMailboxInspector(auth)
    ? [projectId]
    : [projectId, auth.agentId];
  const timestamp = now();
  let sql: string;
  let values: unknown[];
  if (action === "seen") {
    sql = `UPDATE message_delivery SET status = 'seen', seen_at = COALESCE(seen_at, ?), updated_at = ?
           WHERE id = ? AND ${recipientCondition} AND status IN ('unread', 'nacked')`;
    values = [timestamp, timestamp, deliveryId, ...recipientValues];
  } else if (action === "ack") {
    sql = `UPDATE message_delivery SET status = 'acked', acked_at = COALESCE(acked_at, ?), updated_at = ?
           WHERE id = ? AND ${recipientCondition} AND status IN ('unread', 'seen', 'nacked')`;
    values = [timestamp, timestamp, deliveryId, ...recipientValues];
  } else {
    sql = `UPDATE message_delivery
           SET status = CASE WHEN attempt_count + 1 >= ? THEN 'dead' ELSE 'unread' END,
               attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ? AND ${recipientCondition} AND status IN ('unread', 'seen', 'nacked')`;
    values = [MAILBOX_MAX_ATTEMPTS, timestamp, deliveryId, ...recipientValues];
  }
  const result = await env.DB.prepare(sql).bind(...values).run();
  if ((result.meta.changes ?? 0) === 0) {
    const current = await mailboxDeliveryView(env.DB, deliveryId);
    if (current && (
      (action === "seen" && ["seen", "acked"].includes(String(current.status))) ||
      (action === "ack" && current.status === "acked") ||
      (action === "nack" && current.status === "dead")
    )) {
      return json({ delivery: current, idempotent: true });
    }
    return json({ error: action === "nack" ? "delivery cannot be nacked" : `delivery cannot be marked ${action}` }, 409);
  }
  if (action === "nack" && Number((await mailboxDeliveryView(env.DB, deliveryId))?.attempt_count ?? 0) >= MAILBOX_MAX_ATTEMPTS) {
    dispatchHooks(ctx, env, projectId, "delivery_dead_lettered", "failure", { delivery_id: deliveryId, message_id: row.message_id, recipient_agent_id: row.recipient_agent_id });
  }
  return json({ delivery: await mailboxDeliveryView(env.DB, deliveryId) });
}

async function mailbox(request: Request, env: Env, auth: Auth, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const sendMatch = url.pathname === "/api/mailbox/messages" && request.method === "POST";
  if (sendMatch) return sendMailboxMessage(request, env, auth);
  if (url.pathname === "/api/mailbox/inbox" && request.method === "GET") return listMailbox(request, env, auth, false);
  if (url.pathname === "/api/mailbox/sent" && request.method === "GET") return listMailbox(request, env, auth, true);
  if (url.pathname === "/api/mailbox/deadletter" && request.method === "GET") {
    if (!isMailboxInspector(auth)) return json({ error: "leader authorization required" }, 403);
    const inboxUrl = new URL(request.url);
    inboxUrl.pathname = "/api/mailbox/inbox";
    inboxUrl.searchParams.set("status", "dead");
    return listMailbox(new Request(inboxUrl), env, auth, false);
  }
  const messageMatch = url.pathname.match(/^\/api\/mailbox\/messages\/([^/]+)$/);
  if (messageMatch && request.method === "GET") return getMailboxMessage(env, auth, messageMatch[1]);
  const deliveryMatch = url.pathname.match(/^\/api\/mailbox\/deliveries\/([^/]+)\/(seen|ack|nack)$/);
  if (deliveryMatch && request.method === "POST") {
    return transitionMailboxDelivery(request, env, auth, ctx, deliveryMatch[1], deliveryMatch[2] as "seen" | "ack" | "nack");
  }
  return json({ error: "not found" }, 404);
}

async function projects(request: Request, env: Env, auth: Auth): Promise<Response> {
  if (request.method === "GET") {
    const rows = isAdmin(auth)
      ? await env.DB.prepare("SELECT id, name, metadata_json, created_at, updated_at FROM project ORDER BY name").all()
      : await env.DB.prepare("SELECT id, name, metadata_json, created_at, updated_at FROM project WHERE id = ?").bind(auth.projectId).all();
    return json({ projects: rows.results });
  }
  if (!isAdmin(auth) || request.method !== "POST") return json({ error: "admin authorization required" }, 403);
  const body = await parseBody(request);
  const projectId = String(body.id || "").trim();
  const name = String(body.name || projectId).trim();
  if (!projectId || !name) return json({ error: "id and name are required" }, 400);
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, "project:create", key);
  if (replay) return replay;
  const timestamp = now();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO project(id, name, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(projectId, name, JSON.stringify(body.metadata || {}), timestamp, timestamp).run();
  if ((result.meta.changes ?? 0) !== 1) return json({ error: "project already exists" }, 409);
  const response = json({ id: projectId, name, metadata_json: JSON.stringify(body.metadata || {}), created_at: timestamp, updated_at: timestamp }, 201);
  return saveIdempotentResponse(env.DB, "project:create", key, response);
}

async function briefing(request: Request, env: Env, auth: Auth): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const url = new URL(request.url);
  const role = (url.searchParams.get("role") || "").trim();
  if (!role) return json({ error: "role is required" }, 400);
  if (auth.kind === "agent" && auth.role !== role) {
    return json({ error: "role does not match authenticated agent" }, 403);
  }
  const project = url.searchParams.get("project") || url.searchParams.get("project_id");
  if (project && !projectAllowed(auth, project)) return json({ error: "project access denied" }, 403);
  return json({
    role,
    project: project || (isAdmin(auth) || isShare(auth) ? null : auth.projectId),
    capabilities: briefingCapabilities(role),
    briefing_markdown: briefingMarkdown(role),
  });
}

type SpawnSessionContext = { agentId: string; sessionId: string; orgId: string; credential: string };

// Resolve the Devin session + decrypted credential for a task's spawned worker. The credential
// is decrypted here only to call the Devin API and is never returned to the caller.
async function spawnSessionContext(
  db: D1Database,
  env: Env,
  projectId: string,
  taskId: string,
): Promise<SpawnSessionContext | null> {
  const agent = await db.prepare(
    `SELECT id, metadata_json FROM agent
     WHERE project_id = ? AND json_extract(metadata_json, '$.cloud_spawn') = 1
       AND json_extract(metadata_json, '$.task_id') = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(projectId, taskId).first<{ id: string; metadata_json: string }>();
  if (!agent) return null;
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(agent.metadata_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const sessionId = typeof meta.session_id === "string" ? meta.session_id : "";
  const backupAccountId = typeof meta.backup_account_id === "string" ? meta.backup_account_id : "";
  if (!sessionId || !backupAccountId) return null;
  const backup = await db.prepare("SELECT * FROM backup_account WHERE id = ? AND project_id = ?")
    .bind(backupAccountId, projectId).first<Record<string, unknown>>();
  if (!backup) return null;
  let credential: string;
  try {
    credential = await decryptBackupCredential(env, String(backup.credential_ciphertext), String(backup.credential_iv));
  } catch {
    return null;
  }
  return { agentId: agent.id, sessionId, orgId: String(backup.org_id), credential };
}

// M3: Leader/human forwards an answer (or a chosen option) to a blocked worker's Devin session,
// then clears the block. Answers are passed through verbatim so a normalized choice label reaches
// the worker exactly as selected.
async function answerWorker(request: Request, env: Env, auth: Auth, taskId: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "manage", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const message = String(body.message || body.answer || "").trim();
  if (!message) return json({ error: "message is required" }, 400);
  const projectId = String(access.row?.board_id);
  const context = await spawnSessionContext(env.DB, env, projectId, taskId);
  if (!context) return json({ error: "no active worker session for this task" }, 404);
  const sent = await sendDevinSessionMessage(context.orgId, context.credential, context.sessionId, message);
  if (!sent) return json({ error: "failed to deliver answer to worker session" }, 502);
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE task_item SET blocked = 0, needs_human = 0, updated_at = ? WHERE id = ?").bind(timestamp, taskId),
    event(env.DB, taskId, "worker_answered", actor(auth), { project_id: projectId, agent_id: context.agentId }),
  ]);
  return json({ ok: true, task_id: taskId, delivered: true });
}

// New requirement: once the Leader has verified/closed out a worker and has no further work for it,
// tell the worker to sleep and stop the watchdog from waking it again.
async function sleepWorker(request: Request, env: Env, auth: Auth, taskId: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const denied = capabilityDenied(auth, "manage", access.row);
  if (denied) return denied;
  const body = await parseBody(request);
  const projectId = String(access.row?.board_id);
  const context = await spawnSessionContext(env.DB, env, projectId, taskId);
  if (!context) return json({ error: "no active worker session for this task" }, 404);
  const note = String(body.message || "No further tasks are assigned. You may sleep now; you will be woken if new work arrives.").trim();
  const sent = await sendDevinSessionMessage(context.orgId, context.credential, context.sessionId, note);
  const timestamp = now();
  await env.DB.batch([
    // Mark the worker leader-slept so the watchdog stops waking it, and clear needs_human.
    env.DB.prepare("UPDATE agent SET metadata_json = json_set(metadata_json, '$.leader_sleep', 1), updated_at = ? WHERE id = ? AND project_id = ?")
      .bind(timestamp, context.agentId, projectId),
    env.DB.prepare("UPDATE task_item SET needs_human = 0, updated_at = ? WHERE id = ?").bind(timestamp, taskId),
    event(env.DB, taskId, "worker_slept", actor(auth), { project_id: projectId, agent_id: context.agentId, delivered: sent }),
  ]);
  return json({ ok: true, task_id: taskId, delivered: sent });
}

// M2: register (or re-link) a project's Cloud-Dev Leader session as a role=lead board agent.
async function leader(request: Request, env: Env, auth: Auth): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") return leaderDashboard(env, auth, url);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!isAdmin(auth)) return json({ error: "admin authorization required" }, 403);
  const body = await parseBody(request);
  const projectId = String(body.project_id || "").trim();
  if (!projectId) return json({ error: "project_id is required" }, 400);
  const project = await env.DB.prepare("SELECT id, leader_agent_id FROM project WHERE id = ?")
    .bind(projectId).first<{ id: string; leader_agent_id: string | null }>();
  if (!project) return json({ error: "project not found" }, 404);
  const sessionId = String(body.session_id || body.cloud_dev_session_id || "").trim();
  const name = String(body.name || "Leader").trim();
  const agentId = String(body.agent_id || `lead-${projectId}`).trim();
  const timestamp = now();
  const leaderMeta = {
    leader: true,
    cloud_dev: true,
    cloud_dev_session_id: sessionId || null,
    role_tag: "lead",
  };
  const existing = await env.DB.prepare("SELECT id, project_id, role FROM agent WHERE id = ?")
    .bind(agentId).first<{ id: string; project_id: string; role: string }>();
  if (existing && existing.project_id !== projectId) {
    return json({ error: "agent id already registered in another project" }, 409);
  }
  if (existing) {
    // Re-link an existing leader agent (e.g. a new Cloud-Dev session id). No new token is issued.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE agent SET role = 'lead', name = ?, metadata_json = ?, status = 'online', last_seen_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
      ).bind(name, JSON.stringify(leaderMeta), timestamp, timestamp, agentId, projectId),
      env.DB.prepare("UPDATE project SET leader_agent_id = ?, updated_at = ? WHERE id = ?").bind(agentId, timestamp, projectId),
      env.DB.prepare(
        "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, 'leader_relinked', ?, ?)",
      ).bind(id(), agentId, projectId, JSON.stringify({ cloud_dev_session_id: sessionId || null }), timestamp),
    ]);
    return json({
      id: agentId, project_id: projectId, name, role: "lead", relinked: true,
      cloud_dev_session_id: sessionId || null,
      briefing_markdown: briefingMarkdown("lead"),
      capabilities: briefingCapabilities("lead"),
    });
  }
  const token = randomToken();
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent(id, project_id, name, role, status, last_seen_at, metadata_json, token_hash, token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, 'lead', 'online', ?, ?, ?, ?, ?, ?)`,
    ).bind(agentId, projectId, name, timestamp, JSON.stringify(leaderMeta), await sha256(token), timestamp, timestamp, timestamp),
    env.DB.prepare("UPDATE project SET leader_agent_id = ?, updated_at = ? WHERE id = ?").bind(agentId, timestamp, projectId),
    env.DB.prepare(
      "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, 'leader_registered', ?, ?)",
    ).bind(id(), agentId, projectId, JSON.stringify({ cloud_dev_session_id: sessionId || null }), timestamp),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "leader registration failed" }, 409);
  return json({
    id: agentId, project_id: projectId, name, role: "lead",
    cloud_dev_session_id: sessionId || null,
    token,
    token_warning: "Store this token now; it will never be returned again.",
    briefing_markdown: briefingMarkdown("lead"),
    capabilities: briefingCapabilities("lead"),
  }, 201);
}

// Read-only leader/human dashboard: task/phase counts plus the blocked and needs-human worklists,
// and the live status of each spawned worker. No credentials are ever included.
async function leaderDashboard(env: Env, auth: Auth, url: URL): Promise<Response> {
  const projectId = (url.searchParams.get("project") || url.searchParams.get("project_id") || (isAdmin(auth) || isShare(auth) ? "" : auth.projectId)).trim();
  if (!projectId) return json({ error: "project is required" }, 400);
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  const project = await env.DB.prepare("SELECT id, name, leader_agent_id, spawn_budget_max FROM project WHERE id = ?")
    .bind(projectId).first<{ id: string; name: string; leader_agent_id: string | null; spawn_budget_max: number }>();
  if (!project) return json({ error: "project not found" }, 404);
  const phaseRows = await env.DB.prepare(
    "SELECT phase, COUNT(*) AS c FROM task_item WHERE board_id = ? AND deleted_at IS NULL GROUP BY phase",
  ).bind(projectId).all<{ phase: string; c: number }>();
  const phases: Record<string, number> = {};
  for (const row of phaseRows.results) phases[String(row.phase)] = Number(row.c);
  const blocked = await env.DB.prepare(
    "SELECT id, title, watchdog_status FROM task_item WHERE board_id = ? AND deleted_at IS NULL AND blocked = 1 ORDER BY updated_at DESC LIMIT 100",
  ).bind(projectId).all<Record<string, unknown>>();
  const needsHuman = await env.DB.prepare(
    "SELECT id, title, watchdog_status FROM task_item WHERE board_id = ? AND deleted_at IS NULL AND needs_human = 1 ORDER BY updated_at DESC LIMIT 100",
  ).bind(projectId).all<Record<string, unknown>>();
  const workers = await env.DB.prepare(
    "SELECT id, title, spawn_status, watchdog_status, blocked, needs_human, assignee_agent_id FROM task_item WHERE board_id = ? AND deleted_at IS NULL AND spawn_status IS NOT NULL ORDER BY updated_at DESC LIMIT 100",
  ).bind(projectId).all<Record<string, unknown>>();
  const usedRow = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM task_event WHERE event_type = 'spawn_created' AND json_extract(payload_json, '$.project_id') = ?",
  ).bind(projectId).first<{ c: number }>();
  return json({
    project: { id: project.id, name: project.name, leader_agent_id: project.leader_agent_id },
    budget: { max: Number(project.spawn_budget_max ?? 0), used: Number(usedRow?.c ?? 0) },
    task_phase_counts: phases,
    blocked: blocked.results,
    needs_human: needsHuman.results,
    workers: workers.results,
  });
}

// M0 remaining: seed a project, its worker profiles, and encrypted backup accounts in one atomic
// batch, optionally registering a leader. Idempotent; never returns plaintext credentials.
async function provision(request: Request, env: Env, auth: Auth): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!isAdmin(auth)) return json({ error: "admin authorization required" }, 403);
  const body = await parseBody(request);
  const projectInput = (body.project && typeof body.project === "object" ? body.project : null) as Json | null;
  if (!projectInput) return json({ error: "project is required" }, 400);
  const projectId = String(projectInput.id || "").trim();
  const projectName = String(projectInput.name || projectId).trim();
  if (!projectId || !projectName) return json({ error: "project.id and project.name are required" }, 400);
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, "provision", key);
  if (replay) return replay;
  const timestamp = now();
  const statements: D1PreparedStatement[] = [];
  statements.push(env.DB.prepare(
    `INSERT INTO project(id, name, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
  ).bind(projectId, projectName, JSON.stringify(projectInput.metadata || {}), timestamp, timestamp));
  if (projectInput.spawn_budget_max !== undefined) {
    const budget = Math.max(0, Math.floor(Number(projectInput.spawn_budget_max) || 0));
    statements.push(env.DB.prepare("UPDATE project SET spawn_budget_max = ?, updated_at = ? WHERE id = ?").bind(budget, timestamp, projectId));
  }
  const profileIds: string[] = [];
  const accountIds: string[] = [];
  try {
    const profiles = Array.isArray(body.worker_profiles) ? body.worker_profiles : [];
    for (const entry of profiles) {
      if (!entry || typeof entry !== "object") throw new Error("each worker profile must be an object");
      const built = buildWorkerProfileStatement(env.DB, projectId, entry as Json, timestamp);
      profileIds.push(built.id);
      statements.push(built.statement);
    }
    const accounts = Array.isArray(body.backup_accounts) ? body.backup_accounts : [];
    for (const entry of accounts) {
      if (!entry || typeof entry !== "object") throw new Error("each backup account must be an object");
      const built = await buildBackupAccountStatement(env, projectId, entry as Json, timestamp);
      accountIds.push(built.id);
      statements.push(built.statement);
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid provisioning payload" }, 400);
  }
  // Single atomic batch: project + profiles + accounts either all commit or none do.
  await env.DB.batch(statements);
  let leaderSummary: Json | null = null;
  const leaderInput = (body.leader && typeof body.leader === "object" ? body.leader : null) as Json | null;
  if (leaderInput) {
    const leaderReq = new Request(`${requestOrigin(request)}/api/board/leader`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...leaderInput, project_id: projectId }),
    });
    const leaderResp = await leader(leaderReq, env, auth);
    const parsed = await leaderResp.json().catch(() => null) as Json | null;
    // Surface only non-secret leader metadata; the token (first registration) is intentionally
    // included so the operator can capture it once, mirroring the agent-registration contract.
    leaderSummary = parsed;
  }
  const response = json({
    ok: true,
    project_id: projectId,
    worker_profile_ids: profileIds,
    backup_account_ids: accountIds,
    leader: leaderSummary,
  }, 201);
  return saveIdempotentResponse(env.DB, "provision", key, response);
}

function requestOrigin(request: Request): string {
  return new URL(request.url).origin;
}

// M4: per-profile spawn/session observability plus budget usage. Read-only, no credentials.
async function spawnStats(request: Request, env: Env, auth: Auth): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const url = new URL(request.url);
  const projectId = (url.searchParams.get("project") || url.searchParams.get("project_id") || (isAdmin(auth) || isShare(auth) ? "" : auth.projectId)).trim();
  if (!projectId) return json({ error: "project is required" }, 400);
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  const project = await env.DB.prepare("SELECT id, spawn_budget_max FROM project WHERE id = ?")
    .bind(projectId).first<{ id: string; spawn_budget_max: number }>();
  if (!project) return json({ error: "project not found" }, 404);
  const rows = await env.DB.prepare(
    `SELECT p.id AS profile_id, p.name AS name, p.role_tag AS role_tag, p.enabled AS enabled,
            SUM(CASE WHEN t.spawn_status = 'requested' THEN 1 ELSE 0 END) AS requested,
            SUM(CASE WHEN t.spawn_status = 'spawning' THEN 1 ELSE 0 END) AS spawning,
            SUM(CASE WHEN t.spawn_status = 'spawned' THEN 1 ELSE 0 END) AS spawned,
            SUM(CASE WHEN t.spawn_status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN t.spawn_status IN ('spawning','spawned') AND t.phase <> 'done' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN t.blocked = 1 THEN 1 ELSE 0 END) AS blocked,
            SUM(CASE WHEN t.needs_human = 1 THEN 1 ELSE 0 END) AS needs_human
     FROM worker_profile p
     LEFT JOIN task_item t ON t.worker_profile_id = p.id AND t.board_id = p.project_id AND t.deleted_at IS NULL
     WHERE p.project_id = ?
     GROUP BY p.id, p.name, p.role_tag, p.enabled
     ORDER BY p.name`,
  ).bind(projectId).all<Record<string, unknown>>();
  const usedRow = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM task_event WHERE event_type = 'spawn_created' AND json_extract(payload_json, '$.project_id') = ?",
  ).bind(projectId).first<{ c: number }>();
  const profiles = rows.results.map((row) => ({
    worker_profile_id: String(row.profile_id),
    name: String(row.name ?? ""),
    role_tag: String(row.role_tag ?? ""),
    enabled: Number(row.enabled ?? 0),
    requested: Number(row.requested ?? 0),
    spawning: Number(row.spawning ?? 0),
    spawned: Number(row.spawned ?? 0),
    failed: Number(row.failed ?? 0),
    active: Number(row.active ?? 0),
    blocked: Number(row.blocked ?? 0),
    needs_human: Number(row.needs_human ?? 0),
  }));
  return json({
    project_id: projectId,
    budget: { max: Number(project.spawn_budget_max ?? 0), used: Number(usedRow?.c ?? 0) },
    profiles,
  });
}

function boundedShareTtl(value: unknown): number {
  const parsed = Number(value ?? 3600);
  if (!Number.isFinite(parsed)) return 3600;
  return Math.min(24 * 60 * 60, Math.max(60, Math.floor(parsed)));
}

async function issueShareToken(request: Request, env: Env, auth: Auth): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await parseBody(request);
  const projectId = typeof body.project_id === "string" && body.project_id.trim()
    ? body.project_id.trim()
    : (isAdmin(auth) ? "" : auth.projectId);
  if (!projectId) return json({ error: "project_id is required" }, 400);
  if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id = ?").bind(projectId).first();
  if (!project) return json({ error: "project not found" }, 404);
  const token = randomToken();
  const timestamp = now();
  const expiresAt = new Date(Date.now() + boundedShareTtl(body.ttl_seconds) * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO share_token(token_hash, project_id, expires_at, scope, created_by, created_at) VALUES (?, ?, ?, 'read', ?, ?)",
  ).bind(await sha256(token), projectId, expiresAt, actor(auth), timestamp).run();
  return json({
    project_id: projectId,
    scope: "read",
    expires_at: expiresAt,
    token,
    token_warning: "Store this token now; it will never be returned again.",
  }, 201);
}

async function agents(request: Request, env: Env, auth: Auth): Promise<Response> {
  if (request.method === "GET") {
    const rows = isAdmin(auth)
      ? await env.DB.prepare("SELECT id, project_id, name, role, status, last_seen_at, metadata_json, created_at, updated_at FROM agent ORDER BY project_id, name").all()
      : isShare(auth)
        ? await env.DB.prepare("SELECT id, project_id, name, role, status, last_seen_at, metadata_json, created_at, updated_at FROM agent WHERE project_id = ? ORDER BY name, id").bind(auth.projectId).all()
        : await env.DB.prepare("SELECT id, project_id, name, role, status, last_seen_at, metadata_json, created_at, updated_at FROM agent WHERE id = ?").bind(auth.agentId).all();
    return json({ agents: rows.results });
  }
  if (!isAdmin(auth)) return json({ error: "admin authorization required" }, 403);
  const body = await parseBody(request);
  const agentId = String(body.id || "").trim();
  const projectId = String(body.project_id || "default").trim();
  if (!agentId || !body.name) return json({ error: "id and name are required" }, 400);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id = ?").bind(projectId).first();
  if (!project) return json({ error: "project not found" }, 422);
  const existing = await env.DB.prepare("SELECT id FROM agent WHERE id = ?").bind(agentId).first();
  if (existing) return json({ error: "agent already exists; tokens are issued only on first registration" }, 409);
  const token = randomToken();
  const timestamp = now();
  const tokenHash = await sha256(token);
  const result = await env.DB.prepare(
    `INSERT INTO agent(id, project_id, name, role, status, last_seen_at, metadata_json, token_hash, token_issued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?)`,
  ).bind(agentId, projectId, String(body.name), String(body.role || "worker"), timestamp, JSON.stringify(body.metadata || {}), tokenHash, timestamp, timestamp, timestamp).run();
  if ((result.meta.changes ?? 0) !== 1) return json({ error: "agent registration failed" }, 409);
  return json({
    id: agentId,
    project_id: projectId,
    name: body.name,
    role: String(body.role || "worker"),
    status: "online",
    last_seen_at: timestamp,
    token,
    token_warning: "Store this token now; it will never be returned again.",
  }, 201);
}

async function rotateAgentToken(request: Request, env: Env, auth: Auth, agentId: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const row = await env.DB.prepare("SELECT id, project_id, name, role FROM agent WHERE id = ?")
    .bind(agentId).first<{ id: string; project_id: string; name: string; role: string }>();
  if (!row) return json({ error: "agent not found" }, 404);
  if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
  if (!projectAllowed(auth, row.project_id)) return json({ error: "agent belongs to another project" }, 403);
  const token = randomToken();
  const timestamp = now();
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE agent SET token_hash = ?, token_issued_at = ?, token_revoked_at = NULL, updated_at = ? WHERE id = ? AND project_id = ?",
    ).bind(await sha256(token), timestamp, timestamp, agentId, row.project_id),
    env.DB.prepare(
      "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, 'agent_token_rotated', ?, ?)",
    ).bind(id(), agentId, row.project_id, JSON.stringify({ actor_agent_id: actor(auth) }), timestamp),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "agent token rotation failed" }, 409);
  return json({
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    role: row.role,
    token,
    token_issued_at: timestamp,
    token_warning: "Store this token now; it will never be returned again.",
  });
}

type BackupAccountMetadata = {
  id: string;
  project_id: string;
  role_tag: string;
  label: string;
  org_id: string;
  credential_type: "apikey" | "service_user";
  enabled: number;
  status: string;
  cooldown_until: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

function backupAccountMetadata(row: Record<string, unknown>): BackupAccountMetadata {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    role_tag: String(row.role_tag),
    label: String(row.label ?? ""),
    org_id: String(row.org_id),
    credential_type: String(row.credential_type) as "apikey" | "service_user",
    enabled: Number(row.enabled ?? 0),
    status: String(row.status),
    cooldown_until: row.cooldown_until ? String(row.cooldown_until) : null,
    last_used_at: row.last_used_at ? String(row.last_used_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function backupProjectId(request: Request, body: Json, auth: Auth): string {
  const url = new URL(request.url);
  const requested = typeof body.project_id === "string"
    ? body.project_id.trim()
    : (url.searchParams.get("project") || url.searchParams.get("project_id") || "").trim();
  return requested || (isAdmin(auth) ? "" : auth.projectId);
}

function jsonArrayText(value: unknown, fallback = "[]"): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? JSON.stringify(parsed) : fallback;
    } catch {
      return fallback;
    }
  }
  return Array.isArray(value) ? JSON.stringify(value) : fallback;
}

function jsonObjectText(value: unknown, fallback = "{}"): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? JSON.stringify(parsed) : fallback;
    } catch {
      return fallback;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : fallback;
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function workerProfileView(row: Record<string, unknown>) {
  const parseArray = (value: unknown): unknown[] => {
    try {
      const parsed = JSON.parse(String(value ?? "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const parseObject = (value: unknown): Json => {
    try {
      const parsed = JSON.parse(String(value ?? "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
    } catch {
      return {};
    }
  };
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    name: String(row.name ?? ""),
    role_tag: String(row.role_tag ?? "worker"),
    model: row.model ? String(row.model) : null,
    snapshot_id: row.snapshot_id ? String(row.snapshot_id) : null,
    system_prompt: row.system_prompt ? String(row.system_prompt) : null,
    prompt_template: row.prompt_template ? String(row.prompt_template) : null,
    playbook_refs: parseArray(row.playbook_refs_json),
    knowledge_refs: parseArray(row.knowledge_refs_json),
    mcp_tools: parseArray(row.mcp_tools_json),
    repo_config: parseObject(row.repo_config_json),
    enabled: Number(row.enabled ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

// Shared builder so single-profile POST and batch provisioning use identical, project-scoped
// upsert SQL (the ON CONFLICT project guard prevents cross-project profile hijacking).
function buildWorkerProfileStatement(
  db: D1Database,
  projectId: string,
  item: Json,
  timestamp: string,
): { statement: D1PreparedStatement; id: string } {
  const profileId = String(item.id || "").trim();
  const name = String(item.name || "").trim();
  const roleTag = String(item.role_tag || "").trim();
  if (!profileId || !name || !roleTag) throw new Error("id, name, and role_tag are required");
  const statement = db.prepare(
    `INSERT INTO worker_profile(
       id, project_id, name, role_tag, model, snapshot_id, system_prompt, prompt_template,
       playbook_refs_json, knowledge_refs_json, mcp_tools_json, repo_config_json, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, role_tag = excluded.role_tag,
       model = excluded.model, snapshot_id = excluded.snapshot_id, system_prompt = excluded.system_prompt,
       prompt_template = excluded.prompt_template, playbook_refs_json = excluded.playbook_refs_json,
       knowledge_refs_json = excluded.knowledge_refs_json, mcp_tools_json = excluded.mcp_tools_json,
       repo_config_json = excluded.repo_config_json, enabled = excluded.enabled, updated_at = excluded.updated_at
     WHERE worker_profile.project_id = excluded.project_id`,
  ).bind(
    profileId, projectId, name, roleTag, optionalText(item.model), optionalText(item.snapshot_id),
    optionalText(item.system_prompt), optionalText(item.prompt_template),
    jsonArrayText(item.playbook_refs), jsonArrayText(item.knowledge_refs), jsonArrayText(item.mcp_tools),
    jsonObjectText(item.repo_config), flag(item.enabled ?? true), timestamp, timestamp,
  );
  return { statement, id: profileId };
}

// Shared builder for backup accounts. Encrypts the credential before it ever touches the DB;
// plaintext never appears in responses, events, or logs.
async function buildBackupAccountStatement(
  env: Env,
  projectId: string,
  item: Json,
  timestamp: string,
): Promise<{ statement: D1PreparedStatement; id: string }> {
  const accountId = String(item.id || "").trim();
  const roleTag = String(item.role_tag || "").trim();
  const label = String(item.label || "").trim();
  const orgId = String(item.org_id || "").trim();
  const credential = String(item.credential || item.credential_value || "").trim();
  const credentialType = item.credential_type === "service_user"
    ? "service_user"
    : item.credential_type === "apikey" || item.credential_type === undefined
      ? "apikey"
      : "";
  if (!accountId || !roleTag || !orgId || !credential) {
    throw new Error("id, role_tag, org_id, and credential are required");
  }
  if (!credentialType) throw new Error("credential_type must be apikey or service_user");
  const encrypted = await encryptBackupCredential(env, credential);
  const statement = env.DB.prepare(
    `INSERT INTO backup_account(
       id, project_id, role_tag, label, org_id, credential_type, credential_ciphertext,
       credential_iv, key_version, enabled, status, cooldown_until, last_used_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id, role_tag = excluded.role_tag, label = excluded.label,
       org_id = excluded.org_id, credential_type = excluded.credential_type,
       credential_ciphertext = excluded.credential_ciphertext, credential_iv = excluded.credential_iv,
       key_version = excluded.key_version, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).bind(
    accountId, projectId, roleTag, label, orgId, credentialType, encrypted.ciphertext,
    encrypted.iv, BACKUP_ACCOUNT_KEY_VERSION, flag(item.enabled ?? true), timestamp, timestamp,
  );
  return { statement, id: accountId };
}

async function workerProfiles(request: Request, env: Env, auth: Auth): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const projectId = (url.searchParams.get("project") || url.searchParams.get("project_id") || "").trim();
    if (!projectId) return json({ error: "project is required" }, 400);
    if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
    if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
    const rows = await env.DB.prepare(
      "SELECT * FROM worker_profile WHERE project_id = ? ORDER BY role_tag, name, id",
    ).bind(projectId).all<Record<string, unknown>>();
    return json({ worker_profiles: rows.results.map(workerProfileView) });
  }
  if (request.method === "DELETE") {
    const profileId = url.pathname.split("/").pop() || "";
    if (!profileId) return json({ error: "worker profile id is required" }, 400);
    const row = await env.DB.prepare("SELECT project_id FROM worker_profile WHERE id = ?")
      .bind(profileId).first<{ project_id: string }>();
    if (!row) return json({ error: "worker profile not found" }, 404);
    if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
    if (!projectAllowed(auth, row.project_id)) return json({ error: "project access denied" }, 403);
    const result = await env.DB.prepare("DELETE FROM worker_profile WHERE id = ? AND project_id = ?")
      .bind(profileId, row.project_id).run();
    return (result.meta.changes ?? 0) === 1 ? json({ ok: true }) : json({ error: "worker profile not found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await parseBody(request);
  if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
  const projectId = backupProjectId(request, body, auth);
  if (!projectId) return json({ error: "project_id is required" }, 400);
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id = ?").bind(projectId).first();
  if (!project) return json({ error: "project not found" }, 404);
  const entries = Array.isArray(body.worker_profiles)
    ? body.worker_profiles
    : Array.isArray(body.profiles) ? body.profiles : [body];
  if (entries.length === 0) return json({ error: "at least one worker profile is required" }, 400);
  const timestamp = now();
  const statements: D1PreparedStatement[] = [];
  const ids: string[] = [];
  try {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") throw new Error("each worker profile must be an object");
      const built = buildWorkerProfileStatement(env.DB, projectId, entry as Json, timestamp);
      ids.push(built.id);
      statements.push(built.statement);
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid worker profile" }, 400);
  }
  if (statements.length > 0) await env.DB.batch(statements);
  const rows = await env.DB.prepare(
    `SELECT * FROM worker_profile WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
  ).bind(projectId, ...ids).all<Record<string, unknown>>();
  return json({ worker_profiles: rows.results.map(workerProfileView) });
}

async function backupAccounts(request: Request, env: Env, auth: Auth): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const projectId = (url.searchParams.get("project") || url.searchParams.get("project_id") || "").trim();
    if (!projectId) return json({ error: "project is required" }, 400);
    if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
    if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
    const rows = await env.DB.prepare(
      `SELECT id, project_id, role_tag, label, org_id, credential_type, enabled, status,
              cooldown_until, last_used_at, created_at, updated_at
       FROM backup_account WHERE project_id = ? ORDER BY role_tag, label, id`,
    ).bind(projectId).all<Record<string, unknown>>();
    return json({ backup_accounts: rows.results.map(backupAccountMetadata) });
  }
  if (request.method === "DELETE") {
    const accountId = url.pathname.split("/").pop() || "";
    if (!accountId) return json({ error: "backup account id is required" }, 400);
    const row = await env.DB.prepare("SELECT project_id FROM backup_account WHERE id = ?")
      .bind(accountId).first<{ project_id: string }>();
    if (!row) return json({ error: "backup account not found" }, 404);
    if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
    if (!projectAllowed(auth, row.project_id)) return json({ error: "project access denied" }, 403);
    const result = await env.DB.prepare("DELETE FROM backup_account WHERE id = ? AND project_id = ?")
      .bind(accountId, row.project_id).run();
    return (result.meta.changes ?? 0) === 1 ? json({ ok: true }) : json({ error: "backup account not found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await parseBody(request);
  if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
  const projectId = backupProjectId(request, body, auth);
  if (!projectId) return json({ error: "project_id is required" }, 400);
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id = ?").bind(projectId).first();
  if (!project) return json({ error: "project not found" }, 404);
  const entries = Array.isArray(body.accounts) ? body.accounts : [body];
  if (entries.length === 0) return json({ error: "at least one backup account is required" }, 400);
  const timestamp = now();
  const statements: D1PreparedStatement[] = [];
  const ids: string[] = [];
  try {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") throw new Error("each backup account must be an object");
      const built = await buildBackupAccountStatement(env, projectId, entry as Json, timestamp);
      ids.push(built.id);
      statements.push(built.statement);
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "invalid backup account" }, 400);
  }
  if (statements.length > 0) await env.DB.batch(statements);
  const rows = await env.DB.prepare(
    `SELECT id, project_id, role_tag, label, org_id, credential_type, enabled, status,
            cooldown_until, last_used_at, created_at, updated_at
     FROM backup_account WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
  ).bind(projectId, ...ids).all<Record<string, unknown>>();
  return json({ backup_accounts: rows.results.map(backupAccountMetadata) });
}

function boundedFailoverNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function accountClaimTtlSeconds(value: unknown): number {
  return boundedFailoverNumber(
    value,
    DEFAULT_ACCOUNT_CLAIM_TTL_SECONDS,
    MIN_ACCOUNT_CLAIM_TTL_SECONDS,
    MAX_ACCOUNT_CLAIM_TTL_SECONDS,
  );
}

async function claimAccount(
  db: D1Database,
  projectId: string,
  accountRef: string,
  roleTag: string,
  claimedBy: string,
  claimedAt: string,
  expiresAt: string,
): Promise<boolean> {
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO account_claim(
       project_id, account_ref, role_tag, claimed_by, status, claimed_at, expires_at
     ) VALUES (?, ?, ?, ?, 'claimed', ?, ?)`,
  ).bind(projectId, accountRef, roleTag, claimedBy, claimedAt, expiresAt).run();
  if ((inserted.meta.changes ?? 0) === 1) return true;
  const refreshed = await db.prepare(
    `UPDATE account_claim
     SET role_tag = ?, claimed_by = ?, status = 'claimed', claimed_at = ?, expires_at = ?
     WHERE project_id = ? AND account_ref = ?
       AND (status <> 'claimed' OR expires_at <= ? OR claimed_by = ?)`,
  ).bind(roleTag, claimedBy, claimedAt, expiresAt, projectId, accountRef, claimedAt, claimedBy).run();
  return (refreshed.meta.changes ?? 0) === 1;
}

async function accountClaims(request: Request, env: Env, auth: Auth): Promise<Response> {
  if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
  const url = new URL(request.url);
  const body = request.method === "POST" ? await parseBody(request) : {};
  const projectId = backupProjectId(request, body, auth);
  if (!projectId) return json({ error: "project_id is required" }, 400);
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id = ?").bind(projectId).first();
  if (!project) return json({ error: "project not found" }, 404);
  const timestamp = now();

  if (request.method === "GET") {
    await env.DB.prepare(
      "UPDATE account_claim SET status = 'released', expires_at = ? WHERE project_id = ? AND status = 'claimed' AND expires_at <= ?",
    ).bind(timestamp, projectId, timestamp).run();
    const rows = await env.DB.prepare(
      `SELECT account_ref, role_tag, claimed_by, claimed_at, expires_at
       FROM account_claim
       WHERE project_id = ? AND status = 'claimed' AND expires_at > ?
       ORDER BY account_ref`,
    ).bind(projectId, timestamp).all<Record<string, unknown>>();
    return json({
      project_id: projectId,
      claims: rows.results.map((row) => ({
        account_ref: String(row.account_ref),
        role_tag: String(row.role_tag),
        claimed_by: String(row.claimed_by),
        claimed_at: String(row.claimed_at),
        expires_at: String(row.expires_at),
      })),
    });
  }

  if (request.method === "POST" && url.pathname.endsWith("/release")) {
    const claimedBy = typeof body.claimed_by === "string" ? body.claimed_by.trim() : "";
    const accountRefs = Array.isArray(body.account_refs)
      ? [...new Set(body.account_refs.map(String).map((value) => value.trim()).filter(Boolean))]
      : [];
    if (!claimedBy) return json({ error: "claimed_by is required" }, 400);
    if (accountRefs.length > MAX_ACCOUNT_CLAIMS_PER_REQUEST) {
      return json({ error: `at most ${MAX_ACCOUNT_CLAIMS_PER_REQUEST} account claims may be released at once` }, 400);
    }
    const result = accountRefs.length === 0
      ? await env.DB.prepare(
        "UPDATE account_claim SET status = 'released', expires_at = ? WHERE project_id = ? AND claimed_by = ? AND status = 'claimed'",
      ).bind(timestamp, projectId, claimedBy).run()
      : await env.DB.prepare(
        `UPDATE account_claim SET status = 'released', expires_at = ?
         WHERE project_id = ? AND claimed_by = ? AND status = 'claimed'
           AND account_ref IN (${accountRefs.map(() => "?").join(",")})`,
      ).bind(timestamp, projectId, claimedBy, ...accountRefs).run();
    return json({ project_id: projectId, claimed_by: claimedBy, released: result.meta.changes ?? 0 });
  }

  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const claimedBy = typeof body.claimed_by === "string" ? body.claimed_by.trim() : "";
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  if (!claimedBy) return json({ error: "claimed_by is required" }, 400);
  if (!accounts.length) return json({ error: "accounts are required" }, 400);
  if (accounts.length > MAX_ACCOUNT_CLAIMS_PER_REQUEST) {
    return json({ error: `at most ${MAX_ACCOUNT_CLAIMS_PER_REQUEST} account claims may be requested at once` }, 400);
  }
  const ttlSeconds = accountClaimTtlSeconds(body.ttl_seconds);
  const expiresAt = new Date(Date.parse(timestamp) + ttlSeconds * 1000).toISOString();
  const seen = new Set<string>();
  const claims: Array<{ account_ref: string; role_tag: string; granted: boolean; expires_at: string | null }> = [];
  for (const entry of accounts) {
    if (!entry || typeof entry !== "object") return json({ error: "each account claim must be an object" }, 400);
    const item = entry as Json;
    const accountRef = typeof item.account_ref === "string" ? item.account_ref.trim() : "";
    const roleTag = typeof item.role_tag === "string" ? item.role_tag.trim() : "";
    if (!accountRef || !roleTag) return json({ error: "account_ref and role_tag are required" }, 400);
    if (accountRef.length > 256 || roleTag.length > 128) return json({ error: "account_ref or role_tag is too long" }, 400);
    if (seen.has(accountRef)) continue;
    seen.add(accountRef);
    const granted = await claimAccount(env.DB, projectId, accountRef, roleTag, claimedBy, timestamp, expiresAt);
    claims.push({ account_ref: accountRef, role_tag: roleTag, granted, expires_at: granted ? expiresAt : null });
  }
  return json({ project_id: projectId, claimed_by: claimedBy, ttl_seconds: ttlSeconds, claims });
}

async function failoverConfig(request: Request, env: Env, auth: Auth): Promise<Response> {
  const body = request.method === "POST" ? await parseBody(request) : {};
  const projectId = backupProjectId(request, body, auth);
  if (!projectId) return json({ error: "project_id is required" }, 400);
  if (!canManage(auth)) return json({ error: "manage authorization required" }, 403);
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  const project = await env.DB.prepare(
    "SELECT id, failover_enabled, failover_max_replacements, failover_cooldown_seconds, failover_stale_grace_seconds FROM project WHERE id = ?",
  ).bind(projectId).first<Record<string, unknown>>();
  if (!project) return json({ error: "project not found" }, 404);
  if (request.method === "GET") {
    return json({
      project_id: projectId,
      failover_enabled: Number(project.failover_enabled) === 1,
      max_replacements: Number(project.failover_max_replacements),
      cooldown_seconds: Number(project.failover_cooldown_seconds),
      stale_grace_seconds: Number(project.failover_stale_grace_seconds),
    });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const enabled = body.failover_enabled === undefined
    ? Number(project.failover_enabled) === 1
    : flag(body.failover_enabled);
  const maxReplacements = boundedFailoverNumber(
    body.max_replacements ?? body.failover_max_replacements,
    Number(project.failover_max_replacements) || DEFAULT_FAILOVER_MAX_REPLACEMENTS,
    1,
    100,
  );
  const cooldownSeconds = boundedFailoverNumber(
    body.cooldown_seconds ?? body.failover_cooldown_seconds,
    Number(project.failover_cooldown_seconds) || DEFAULT_FAILOVER_COOLDOWN_SECONDS,
    60,
    24 * 60 * 60,
  );
  const staleGraceSeconds = boundedFailoverNumber(
    body.stale_grace_seconds ?? body.failover_stale_grace_seconds,
    Number(project.failover_stale_grace_seconds) || DEFAULT_FAILOVER_STALE_GRACE_SECONDS,
    60,
    24 * 60 * 60,
  );
  const timestamp = now();
  await env.DB.prepare(
    `UPDATE project SET failover_enabled = ?, failover_max_replacements = ?,
       failover_cooldown_seconds = ?, failover_stale_grace_seconds = ?, updated_at = ? WHERE id = ?`,
  ).bind(enabled, maxReplacements, cooldownSeconds, staleGraceSeconds, timestamp, projectId).run();
  return json({
    project_id: projectId,
    failover_enabled: Boolean(enabled),
    max_replacements: maxReplacements,
    cooldown_seconds: cooldownSeconds,
    stale_grace_seconds: staleGraceSeconds,
  });
}

async function heartbeat(request: Request, env: Env, auth: Auth, agentId: string): Promise<Response> {
  if (!isAdmin(auth) && auth.agentId !== agentId) return json({ error: "agent access denied" }, 403);
  const row = await env.DB.prepare("SELECT project_id, last_seen_at FROM agent WHERE id = ?").bind(agentId).first<{ project_id: string; last_seen_at: string | null }>();
  if (!row) return json({ error: "agent not found" }, 404);
  const timestamp = now();
  if (!isAdmin(auth) && row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < 30_000) {
    return json({ error: "heartbeat interval must be at least 30 seconds" }, 429, { "retry-after": "30" });
  }
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE agent SET status = 'online', last_seen_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
    ).bind(timestamp, timestamp, agentId, row.project_id),
    env.DB.prepare(
      "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, 'agent_active', ?, ?)",
    ).bind(id(), agentId, row.project_id, JSON.stringify({ actor_agent_id: actor(auth), source: "heartbeat" }), timestamp),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "agent not found" }, 404);
  return json({ id: agentId, project_id: row.project_id, status: "online", last_seen_at: timestamp });
}

async function lifecycle(
  request: Request,
  env: Env,
  auth: Auth,
  ctx: ExecutionContext,
  agentId: string,
  transition: "active" | "idle" | "shutdown",
): Promise<Response> {
  const row = await env.DB.prepare("SELECT id, project_id, role, status FROM agent WHERE id = ?").bind(agentId)
    .first<{ id: string; project_id: string; role: string; status: string }>();
  if (!row) return json({ error: "agent not found" }, 404);
  const own = !isAdmin(auth) && auth.agentId === agentId;
  if (!own && !isAdmin(auth)) {
    const denied = capabilityDenied(auth, "manage", { board_id: row.project_id });
    if (denied) return denied;
  }
  if (!isAdmin(auth) && auth.kind === "agent" && auth.projectId !== row.project_id) {
    return json({ error: "agent belongs to another project" }, 403);
  }
  const body = transition === "shutdown" ? await parseBody(request) : {};
  const revokeToken = transition === "shutdown" && body.revoke_token === true;
  const timestamp = now();
  const tokenValues = revokeToken ? [timestamp] : [];
  const tokenClause = revokeToken ? ", token_revoked_at = ?" : "";
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent SET status = ?, last_seen_at = ?, updated_at = ?${tokenClause} WHERE id = ? AND project_id = ?`,
    ).bind(transition, timestamp, timestamp, ...tokenValues, agentId, row.project_id),
    env.DB.prepare(
      "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id(), agentId, row.project_id, `agent_${transition}`, JSON.stringify({ actor_agent_id: actor(auth), token_revoked: revokeToken }), timestamp),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "agent lifecycle transition failed" }, 409);
  const releasedProjects = transition === "shutdown" ? await releaseAgentLeases(env.DB, agentId) : [];
  if (transition === "shutdown") {
    dispatchHooks(ctx, env, row.project_id, "agent_shutdown", "post", { agent_id: agentId, actor_agent_id: actor(auth), released_leases: releasedProjects.length, token_revoked: revokeToken });
  }
  return json({ id: agentId, project_id: row.project_id, status: transition, released_leases: releasedProjects.length, token_revoked: revokeToken });
}

async function hooks(request: Request, env: Env, auth: Auth): Promise<Response> {
  const body = request.method === "POST" ? await parseBody(request) : {};
  const path = new URL(request.url).pathname;
  const hookId = path.startsWith("/api/board/hooks/") ? path.split("/").pop() || "" : "";
  const existingHook = hookId
    ? await env.DB.prepare("SELECT project_id FROM hook WHERE id = ?").bind(hookId).first<{ project_id: string }>()
    : null;
  const requestedProject = typeof body.project_id === "string"
    ? body.project_id
    : new URL(request.url).searchParams.get("project_id") || existingHook?.project_id;
  const projectId = requestedProject || (isAdmin(auth) ? null : auth.projectId);
  if (!projectId) return json({ error: "project_id is required" }, 400);
  const denied = capabilityDenied(auth, "manage", { board_id: projectId });
  if (denied) return denied;
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id, project_id, event_types_json, url, phase, active, created_at, updated_at FROM hook WHERE project_id = ? ORDER BY created_at").bind(projectId).all<Record<string, unknown>>();
    return json({ hooks: rows.results.map((row) => ({ ...row, event_types: hookEvents(JSON.parse(String(row.event_types_json))) })) });
  }
  if (request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM hook WHERE id = ? AND project_id = ?").bind(hookId, projectId).run();
    if ((result.meta.changes ?? 0) !== 1) return json({ error: "hook not found" }, 404);
    return json({ ok: true });
  }
  if (request.method !== "POST" || path !== "/api/board/hooks") return json({ error: "method not allowed" }, 405);
  const events = hookEvents(body.event_types ?? body.event_type);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const phase = body.phase === "failure" ? "failure" : "post";
  if (events.length === 0 || !url) return json({ error: "event_type(s) and url are required" }, 400);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
  } catch {
    return json({ error: "url must be http or https" }, 400);
  }
  const timestamp = now();
  const newHookId = id();
  await env.DB.prepare(
    "INSERT INTO hook(id, project_id, event_types_json, url, secret, phase, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
  ).bind(newHookId, projectId, JSON.stringify(events), url, typeof body.secret === "string" ? body.secret : null, phase, timestamp, timestamp).run();
  return json({ id: newHookId, project_id: projectId, event_types: events, url, phase, active: 1, created_at: timestamp }, 201);
}

async function hookDeliveries(request: Request, env: Env, auth: Auth): Promise<Response> {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project") || url.searchParams.get("project_id");
  if (!projectId) return json({ error: "project is required" }, 400);
  const denied = capabilityDenied(auth, "manage", { board_id: projectId });
  if (denied) return denied;
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  const status = url.searchParams.get("status");
  if (status && !["pending", "delivered", "dead"].includes(status)) {
    return json({ error: "invalid hook delivery status" }, 400);
  }
  const conditions = ["project_id = ?"];
  const values: unknown[] = [projectId];
  if (status) {
    conditions.push("status = ?");
    values.push(status);
  }
  const rows = await env.DB.prepare(
    `SELECT id, hook_id, project_id, event_type, phase, status, attempt_count, next_attempt_at, last_error, created_at, updated_at
     FROM hook_delivery WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 200`,
  ).bind(...values).all<Record<string, unknown>>();
  return json({ hook_deliveries: rows.results });
}

async function teamSnapshot(request: Request, env: Env, auth: Auth): Promise<Response> {
  const url = new URL(request.url);
  const requestedProject = url.searchParams.get("project") || url.searchParams.get("board") || url.searchParams.get("project_id");
  if (!isAdmin(auth) && requestedProject && requestedProject !== auth.projectId) {
    return json({ error: "project access denied" }, 403);
  }
  const projectId = requestedProject || (isAdmin(auth) ? null : auth.projectId);
  if (!projectId) return json({ error: "project selector is required for admin tokens" }, 400);
  const project = await env.DB.prepare("SELECT id, name FROM project WHERE id = ?").bind(projectId).first<{ id: string; name: string }>();
  if (!project) return json({ error: "project not found" }, 404);
  const [agentRows, taskRows, deadRows] = await Promise.all([
    env.DB.prepare(
      "SELECT id, project_id, name, role, status, last_seen_at, metadata_json, created_at, updated_at FROM agent WHERE project_id = ? ORDER BY name, id",
    ).bind(projectId).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT * FROM task_item WHERE board_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at",
    ).bind(projectId).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM message_delivery WHERE project_id = ? AND status = 'dead'",
    ).bind(projectId).first<{ count: number }>(),
  ]);
  const tasks = taskRows.results;
  const taskIds = tasks.map((task) => String(task.id));
  const gates = await selectByIdChunks<Record<string, unknown>>(
    env.DB,
    taskIds,
    (placeholders) => `SELECT task_id, gate_name, status, by_agent, note, created_at, updated_at
       FROM task_gate WHERE task_id IN (${placeholders}) ORDER BY gate_name`,
  );
  const gatesByTask = new Map<string, Record<string, unknown>[]>();
  for (const gate of gates) {
    const taskGates = gatesByTask.get(String(gate.task_id)) ?? [];
    taskGates.push(gate);
    gatesByTask.set(String(gate.task_id), taskGates);
  }
  const taskViews = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    phase: task.phase,
    blocked: task.blocked,
    assignee_agent_id: task.assignee_agent_id,
    lease_owner: task.lease_owner,
    lease_expires_at: task.lease_expires_at,
    plan_status: task.plan_status,
    acceptance_status: task.acceptance_status,
    required_gates: requiredGates(task),
    gates: gatesByTask.get(String(task.id)) ?? [],
    blocked_upstream_task_ids: [] as string[],
  }));
  const blockedTasks = taskViews.filter((task) => Number(task.blocked ?? 0) === 1);
  const blockedDependencyRows = await selectByIdChunks<{ task_id: string; depends_on_id: string }>(
    env.DB,
    taskIds,
    (placeholders) => `SELECT d.task_id, d.depends_on_id
       FROM task_dependency d
       JOIN task_item dependency ON dependency.id = d.depends_on_id
       WHERE d.task_id IN (${placeholders})
         AND dependency.blocked = 1 AND dependency.deleted_at IS NULL`,
  );
  const blockedUpstreamsByTask = new Map<string, string[]>();
  for (const row of blockedDependencyRows) {
    const upstreams = blockedUpstreamsByTask.get(row.task_id) ?? [];
    upstreams.push(row.depends_on_id);
    blockedUpstreamsByTask.set(row.task_id, upstreams);
  }
  for (const taskView of taskViews) {
    taskView.blocked_upstream_task_ids = blockedUpstreamsByTask.get(String(taskView.id)) ?? [];
  }
  const blockedDependencyTasks = taskViews.filter((taskView) => (
    (blockedUpstreamsByTask.get(String(taskView.id)) ?? []).length > 0
  ));
  const taskByLease = new Map<string, Record<string, unknown>>();
  for (const task of taskViews) {
    if (task.lease_owner) taskByLease.set(String(task.lease_owner), task);
  }
  const agents = agentRows.results.map((agent) => ({
    id: agent.id,
    project_id: agent.project_id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    last_seen_at: agent.last_seen_at,
    current_task: taskByLease.get(String(agent.id)) ?? null,
  }));
  return json({
    project: { id: project.id, name: project.name },
    agents,
    tasks: taskViews,
    dead_letter_count: Number(deadRows?.count ?? 0),
    blocked_task_count: blockedTasks.length,
    blocked_tasks: blockedTasks,
    blocked_dependency_count: blockedDependencyTasks.length,
    blocked_dependency_tasks: blockedDependencyTasks,
  });
}

function eventPayloadSummary(payloadJson: unknown): string {
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (depth > 2) return typeof value === "string" ? value.slice(0, 160) : String(value ?? "");
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitize(item, depth + 1));
    if (value && typeof value === "object") {
      const safeObject: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (/token|secret|credential|password|api[_-]?key|authorization/i.test(key)) continue;
        safeObject[key] = sanitize(nested, depth + 1);
        if (Object.keys(safeObject).length >= 8) break;
      }
      return safeObject;
    }
    return typeof value === "string" ? value.slice(0, 160) : value;
  };
  try {
    const payload = JSON.parse(String(payloadJson ?? "{}"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    return JSON.stringify(sanitize(payload));
  } catch {
    return "";
  }
}

async function projectEvents(request: Request, env: Env, auth: Auth): Promise<Response> {
  const url = new URL(request.url);
  const requestedProject = (url.searchParams.get("project") || url.searchParams.get("project_id") || "").trim();
  if (!isAdmin(auth) && requestedProject && requestedProject !== auth.projectId) {
    return json({ error: "project access denied" }, 403);
  }
  const projectId = requestedProject || (isAdmin(auth) ? "" : auth.projectId);
  if (!projectId) return json({ error: "project selector is required for admin tokens" }, 400);
  if (!isAdmin(auth) && !isShare(auth) && !roleCapabilities(auth.role).includes("manage")) {
    return json({ error: "capability denied", capability: "manage" }, 403);
  }
  if (!projectAllowed(auth, projectId)) return json({ error: "project access denied" }, 403);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id = ?").bind(projectId).first();
  if (!project) return json({ error: "project not found" }, 404);
  const parsedLimit = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isFinite(parsedLimit) ? Math.min(200, Math.max(1, Math.floor(parsedLimit))) : 50;
  const rows = await env.DB.prepare(
    `SELECT event_id, event_type, created_at, agent_id, task_id, payload_json
     FROM (
       SELECT 'agent:' || id AS event_id, event_type, created_at, agent_id, NULL AS task_id, payload_json
       FROM agent_event WHERE project_id = ?
       UNION ALL
       SELECT 'task:' || e.id AS event_id, e.event_type, e.created_at,
              e.actor_agent_id AS agent_id, e.task_id, e.payload_json
       FROM task_event e
       JOIN task_item t ON t.id = e.task_id
       WHERE t.board_id = ?
     )
     ORDER BY created_at DESC, event_id DESC
     LIMIT ?`,
  ).bind(projectId, projectId, limit).all<Record<string, unknown>>();
  return json({
    project_id: projectId,
    events: rows.results.map((row) => ({
      id: row.event_id,
      type: row.event_type,
      created_at: row.created_at,
      agent_id: row.agent_id ?? null,
      task_id: row.task_id ?? null,
      payload_summary: eventPayloadSummary(row.payload_json),
    })),
  });
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mission Control · Coord Board</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2d;--panel2:#18233a;--line:#293652;--text:#e7edf8;--muted:#8d9ab3;--blue:#63a4ff;--green:#43d19a;--amber:#f5bd55;--red:#ff6b7d;--purple:#b58cff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% -10%,#1e3154 0,#0b1020 42%);color:var(--text);font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;min-height:100vh}
button,input{font:inherit}button{cursor:pointer;border:1px solid var(--line);background:#1b2944;color:var(--text);border-radius:6px;padding:6px 10px}button:hover{border-color:var(--blue);background:#24385b}button.primary{background:#3479d2;border-color:#4b92ef}button.danger{color:#ffb4bd;border-color:#663444;background:#2a1a2b}button:disabled{cursor:not-allowed;opacity:.45}
input{background:#0d1527;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:7px 9px}a{color:var(--blue)}.muted{color:var(--muted)}.hidden{display:none!important}
.topbar{height:64px;position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:22px;padding:0 24px;background:rgba(11,16,32,.9);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:10px;font-weight:750;font-size:17px;letter-spacing:.2px}.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#62b1ff,#7c5cff);display:grid;place-items:center;color:#fff;font-weight:900}.stats{display:flex;gap:8px}.stat{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:4px 10px;color:var(--muted)}.stat b{color:var(--text)}.top-spacer{flex:1}.clock{font-variant-numeric:tabular-nums;color:#c8d4e9}.online{display:flex;align-items:center;gap:6px;color:var(--green)}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green)}.settings{position:absolute;right:18px;top:58px;width:310px;padding:14px;background:var(--panel);border:1px solid var(--line);border-radius:9px;box-shadow:0 15px 45px #0008}.settings label{display:block;margin:8px 0;color:var(--muted)}.settings input{width:100%;margin-top:4px}
.layout{display:grid;grid-template-columns:255px minmax(480px,1fr) 300px;gap:14px;padding:16px 18px;max-width:1800px;margin:auto}.panel{min-width:0;background:rgba(18,26,45,.78);border:1px solid var(--line);border-radius:10px;overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:#b5c1d8}.panel-body{padding:10px}.panel-toggle{border:0;background:transparent;color:var(--muted);padding:2px 5px}
.agent{display:grid;grid-template-columns:34px 1fr auto;gap:9px;align-items:center;padding:10px 5px;border-bottom:1px solid #25304a}.avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:750;color:#fff}.agent-name{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agent-meta{font-size:11px;color:var(--muted)}.status{font-size:10px;border-radius:99px;padding:2px 7px;border:1px solid currentColor}.status.online,.status.active{color:var(--green)}.status.idle{color:var(--amber)}.status.shutdown,.status.offline{color:var(--muted)}.agent-task{grid-column:2/-1;font-size:11px;color:#b9c7dd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agent-actions{grid-column:2/-1}
.board{display:flex;gap:10px;overflow-x:auto;padding:10px}.column{flex:1 0 180px;min-width:180px}.column-head{display:flex;justify-content:space-between;align-items:center;color:#bdc9dc;font-size:11px;letter-spacing:.1em;padding:5px 3px 9px}.count{color:var(--muted);background:#202e49;border-radius:99px;padding:2px 7px}.task{position:relative;background:var(--panel2);border:1px solid #2a3a59;border-radius:8px;margin-bottom:9px;padding:11px 10px 10px 14px;box-shadow:0 5px 13px #0002}.task:before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:3px;background:var(--blue)}.task.blocked:before{background:var(--red)}.task.done:before{background:var(--green)}.task-title{font-weight:650;margin-bottom:7px}.chips{display:flex;gap:4px;flex-wrap:wrap}.chip{font-size:10px;color:#c7d4ea;background:#263754;border-radius:4px;padding:2px 5px}.task-line{font-size:11px;color:var(--muted);margin-top:6px}.task-footer{display:flex;justify-content:space-between;gap:5px;align-items:end;margin-top:8px}.task-time{color:#9eabc1;font-size:10px}.task-actions{display:flex;gap:3px;flex-wrap:wrap}.task-actions button{font-size:10px;padding:3px 6px}.empty{padding:20px 5px;color:var(--muted);text-align:center;font-size:12px}
.feed-item{position:relative;padding:10px 3px 10px 23px;border-bottom:1px solid #25304a}.feed-item:before{content:"";position:absolute;left:5px;top:15px;width:8px;height:8px;border-radius:50%;background:var(--purple);box-shadow:0 0 8px #b58cff}.feed-type{font-weight:650;color:#d5def0}.feed-meta{font-size:10px;color:var(--muted);margin-top:3px}.feed-summary{font-size:11px;color:#aebbd0;word-break:break-word;margin-top:4px}.notice{margin:10px 18px 0;padding:8px 11px;border:1px solid #6b5130;background:#30271b;color:#f5cf88;border-radius:7px}.new-task{display:flex;gap:8px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line)}.new-task input{flex:1;max-width:520px}.footer-note{color:var(--muted);text-align:center;padding:14px;font-size:11px}
@media(max-width:1100px){.layout{grid-template-columns:220px minmax(440px,1fr)}.right{grid-column:1/-1}.right .panel-body{max-height:300px;overflow:auto}}@media(max-width:760px){.topbar{padding:0 12px;gap:10px}.stats{display:none}.layout{display:block;padding:10px}.panel{margin-bottom:10px}.board{overflow-x:auto}.clock{display:none}}
</style></head><body>
<header class="topbar"><div class="brand"><span class="logo">C</span><span>Coord Board</span></div><div class="stats"><span class="stat"><b id="agent-count">0</b> agents</span><span class="stat"><b id="task-count">0</b> tasks</span></div><div class="top-spacer"></div><span class="clock" id="clock">00:00:00</span><span class="online"><i class="dot"></i><span id="connection">Online</span></span><button class="primary" id="new-task-button">＋ New Task</button><button id="settings-button" title="Settings">⚙</button><div class="settings hidden" id="settings"><label>Bearer token<input id="token" type="password" autocomplete="off"></label><label>Agent ID<input id="agent" value="ui-agent" autocomplete="off"></label><button id="save-settings">Save &amp; refresh</button></div></header>
<div id="notice" class="notice hidden"></div><form class="new-task hidden" id="new-task-form"><input id="title" placeholder="Task title" required><button class="primary">Create task</button><button type="button" id="cancel-new">Cancel</button></form>
<main class="layout"><section class="panel left"><div class="panel-head"><span>Agents · Roster</span><span id="deadletters" class="muted">0 dead</span></div><div class="panel-body" id="agents"><div class="empty">Connect a project to view agents.</div></div></section>
<section class="panel center"><div class="panel-head"><span>Board · <span id="project-heading">default</span></span><button class="panel-toggle" id="pause-button">Pause refresh</button></div><div class="board" id="board"></div></section>
<section class="panel right"><div class="panel-head"><span>Live Feed</span><button class="panel-toggle" id="feed-toggle">Collapse</button></div><div class="panel-body" id="feed"><div class="empty">No events yet.</div></div></section></main><div class="footer-note">Mission Control refreshes every 5 seconds · Project is selected by URL</div>
<script>
const query=new URLSearchParams(location.search);const sharedParams=new URLSearchParams(location.hash.startsWith('#')?location.hash.slice(1):location.hash);const sharedToken=sharedParams.get('token')||sharedParams.get('tkn');if(sharedToken)sessionStorage.setItem('coord-board-token',sharedToken);if(location.hash)history.replaceState(null,document.title,location.pathname+location.search);const project=query.get('project')||query.get('board')||sessionStorage.getItem('coord-board-project')||'default';let readOnly=false,paused=false,feedCollapsed=false;const token=document.querySelector('#token');const agent=document.querySelector('#agent');token.value=sessionStorage.getItem('coord-board-token')||'';agent.value=sessionStorage.getItem('coord-board-agent')||'ui-agent';document.querySelector('#project-heading').textContent=project;
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function api(p,o={}){const headers={Authorization:'Bearer '+token.value,'Content-Type':'application/json',...(o.headers||{})};return fetch('/api/board'+p,{...o,headers}).then(async r=>{let data={};try{data=await r.json()}catch{}if(r.status===403&&o.method&&o.method!=='GET'){readOnly=true;document.querySelector('#notice').textContent='Read-only share mode: write controls are disabled.';document.querySelector('#notice').classList.remove('hidden');renderReadOnly();}return{status:r.status,data}})}
function relative(value){if(!value)return'—';const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(value))/1000));if(seconds<10)return'now';if(seconds<60)return seconds+'s';if(seconds<3600)return Math.floor(seconds/60)+'m';if(seconds<86400)return Math.floor(seconds/3600)+'h';return Math.floor(seconds/86400)+'d'}
function color(id){let n=0;for(const c of String(id||'x'))n=(n*31+c.charCodeAt(0))>>>0;return'hsl('+(n%360)+' 58% 48%)'}function initial(a){return(String(a.name||a.id||'?').trim()[0]||'?').toUpperCase()}
function phaseBucket(t){if(Number(t.blocked)===1)return'blocked';if(t.phase==='done')return'done';if(t.acceptance_status&&t.acceptance_status!=='pending'&&t.acceptance_status!=='approved')return'review';if(t.plan_status&&t.plan_status!=='pending'&&t.phase!=='in_progress')return'review';if(t.phase==='in_progress'||t.lease_owner)return'assigned';return'inbox'}
function setText(id,value){document.querySelector(id).textContent=value}
function renderReadOnly(){document.querySelectorAll('.task-actions button,.agent-actions button,#new-task-button,#save-settings').forEach(b=>{if(b.dataset.write)b.disabled=readOnly});if(readOnly)document.querySelector('#new-task-button').disabled=true}
function taskCard(t){const gates=(t.gates||[]).map(g=>esc(g.gate_name+':'+g.status)).join(', ')||'none';const tags=(t.tags||t.labels||[]).map(x=>'<span class="chip">'+esc(x)+'</span>').join('');const actions='<div class="task-actions">'+(t.phase!=='done'&&phaseBucket(t)!=='blocked'?'<button data-write="1" data-action="claim" data-id="'+esc(t.id)+'">Claim</button><button data-write="1" data-action="complete" data-id="'+esc(t.id)+'">Complete</button>':'')+'<button data-write="1" data-action="reassign" data-id="'+esc(t.id)+'">Reassign</button>'+(t.lease_owner?'<button data-write="1" data-action="release" data-id="'+esc(t.id)+'" data-agent="'+esc(t.lease_owner)+'">Force release</button>':'')+'</div>';return'<article class="task '+(phaseBucket(t)==='blocked'?'blocked ':'')+(t.phase==='done'?'done':'')+'"><div class="task-title">'+esc(t.title)+'</div><div class="chips">'+(tags||'<span class="chip">'+esc(t.phase)+'</span>')+'</div><div class="task-line">Assignee: '+esc(t.assignee_agent_id||'unassigned')+' · Lease: '+esc(t.lease_owner?'active':'open')+(t.lease_expires_at?' until '+esc(relative(t.lease_expires_at)):'')+'</div><div class="task-line">Plan: '+esc(t.plan_status||'—')+' · Acceptance: '+esc(t.acceptance_status||'—')+' · Gates: '+gates+'</div><div class="task-footer"><span class="task-time">'+esc(relative(t.updated_at||t.created_at))+'</span>'+actions+'</div></article>'}
function renderAgents(agents){document.querySelector('#agents').innerHTML=agents.length?agents.map(a=>'<article class="agent"><span class="avatar" style="background:'+color(a.id)+'">'+esc(initial(a))+'</span><div><div class="agent-name">'+esc(a.name||a.id)+'</div><div class="agent-meta">'+esc(a.role||'worker')+' · '+esc(relative(a.last_seen_at))+'</div></div><span class="status '+esc(a.status||'offline')+'">'+esc(a.status||'offline')+'</span>'+(a.current_task?'<div class="agent-task">↳ '+esc(a.current_task.title)+'</div>':'<div class="agent-task muted">No active task</div>')+'<div class="agent-actions"><button class="danger" data-write="1" data-action="shutdown" data-id="'+esc(a.id)+'">Force shutdown</button></div></article>').join(''):'<div class="empty">No agents in this project.</div>';renderReadOnly()}
function renderBoard(tasks){const groups={inbox:[],assigned:[],review:[],done:[],blocked:[]};tasks.forEach(t=>groups[phaseBucket(t)].push(t));const columns=[['inbox','INBOX'],['assigned','ASSIGNED'],['review','REVIEW / ACCEPTANCE'],['done','DONE'],['blocked','BLOCKED']];document.querySelector('#board').innerHTML=columns.map(([key,label])=>'<div class="column"><div class="column-head"><span>'+label+'</span><span class="count">'+groups[key].length+'</span></div>'+(groups[key].map(taskCard).join('')||'<div class="empty">Clear</div>')+'</div>').join('');renderReadOnly()}
function renderFeed(events){document.querySelector('#feed').innerHTML=events.length?events.map(e=>'<div class="feed-item"><div class="feed-type">◈ '+esc(e.type||'event')+'</div><div class="feed-meta">'+esc(relative(e.created_at))+' · '+esc(e.agent_id||'system')+(e.task_id?' · task '+esc(e.task_id):'')+'</div>'+(e.payload_summary?'<div class="feed-summary">'+esc(e.payload_summary)+'</div>':'')+'</div>').join(''):'<div class="empty">No events yet.</div>'}
async function load(){if(paused)return;const [team,events]=await Promise.all([api('/team?project='+encodeURIComponent(project)),api('/events?project='+encodeURIComponent(project)+'&limit=50')]);if(team.status>=400){setText('#connection','Offline');document.querySelector('#notice').textContent=team.data.error||'Unable to load project';document.querySelector('#notice').classList.remove('hidden');return}setText('#connection','Online');document.querySelector('#notice').classList.add('hidden');const d=team.data;setText('#agent-count',(d.agents||[]).length);setText('#task-count',(d.tasks||[]).length);setText('#deadletters',(d.dead_letter_count||0)+' dead');renderAgents(d.agents||[]);renderBoard(d.tasks||[]);if(events.status<400)renderFeed(events.data.events||[])}
async function write(path,body){const r=await api(path,{method:'POST',body:JSON.stringify(body||{})});if(r.status<400)load();else alert(r.data.error||'Request failed')}
document.querySelector('#board').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b||readOnly)return;const id=b.dataset.id;const action=b.dataset.action;if(action==='claim'||action==='complete')write('/tasks/'+encodeURIComponent(id)+'/'+action,{agent_id:agent.value});else if(action==='release')write('/tasks/'+encodeURIComponent(id)+'/release',{agent_id:b.dataset.agent});else if(action==='shutdown')write('/agents/'+encodeURIComponent(id)+'/shutdown',{});else if(action==='reassign'){const value=prompt('Assignee agent id (blank to clear):','');if(value!==null)write('/tasks/'+encodeURIComponent(id)+'/reassign',{assignee_agent_id:value||null})}});
document.querySelector('#agents').addEventListener('click',e=>{const b=e.target.closest('button[data-action="shutdown"]');if(b&&!readOnly)write('/agents/'+encodeURIComponent(b.dataset.id)+'/shutdown',{})});document.querySelector('#new-task-button').onclick=()=>{if(!readOnly)document.querySelector('#new-task-form').classList.toggle('hidden')};document.querySelector('#cancel-new').onclick=()=>document.querySelector('#new-task-form').classList.add('hidden');document.querySelector('#new-task-form').onsubmit=e=>{e.preventDefault();write('/tasks',{title:document.querySelector('#title').value,board_id:project});e.target.reset();e.target.classList.add('hidden')};document.querySelector('#settings-button').onclick=()=>document.querySelector('#settings').classList.toggle('hidden');document.querySelector('#save-settings').onclick=()=>{sessionStorage.setItem('coord-board-token',token.value);sessionStorage.setItem('coord-board-agent',agent.value);document.querySelector('#settings').classList.add('hidden');load()};document.querySelector('#pause-button').onclick=()=>{paused=!paused;document.querySelector('#pause-button').textContent=paused?'Resume refresh':'Pause refresh';if(!paused)load()};document.querySelector('#feed-toggle').onclick=()=>{feedCollapsed=!feedCollapsed;document.querySelector('#feed').classList.toggle('hidden',feedCollapsed);document.querySelector('#feed-toggle').textContent=feedCollapsed?'Expand':'Collapse'};setInterval(()=>{document.querySelector('#clock').textContent=new Date().toLocaleTimeString('en-GB',{hour12:false});document.querySelectorAll('.task-time,.agent-meta,.feed-meta').forEach(()=>{});},1000);setInterval(load,5000);document.querySelector('#clock').textContent=new Date().toLocaleTimeString('en-GB',{hour12:false});load()
</script></body></html>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    try {
      return withCors(await route(request, env, ctx));
    } catch (error) {
      return withCors(json({ error: error instanceof Error ? error.message : "internal error" }, 500));
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await deliverHookOutbox(env.DB);
    await sweepLeases(env.DB, env);
    await runWorkerSpawn(env.DB, env, now());
    await runWatchdog(env.DB, env, now());
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return json({ ok: true, service: "coord-board" });
    }
    const auth = await authenticate(request, env);
    if (!auth) {
      if (request.method === "GET" && url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      return json({ error: "unauthorized" }, 401);
    }
    if (isShare(auth) && request.method !== "GET") {
      return json({ error: "share tokens are read-only" }, 403);
    }
    if (url.pathname.startsWith("/api/mailbox/")) return mailbox(request, env, auth, ctx);
    const taskMatch = url.pathname.match(/^\/api\/board\/tasks(?:\/([^/]+)(?:\/(claim|renew|release|complete|review|verify|plan|plan-review|acceptance|gate|reassign|dependencies|events|answer|sleep))?)?$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      const action = taskMatch[2];
      if (action === "claim" && taskId) return claimTask(request, env, auth, ctx, taskId);
      if (action === "renew" && taskId && request.method === "POST") return renewTask(request, env, auth, ctx, taskId);
      if (action === "release" && taskId) return releaseTask(request, env, auth, taskId);
      if (action === "reassign" && taskId && request.method === "POST") return reassignTask(request, env, auth, taskId);
      if (action === "complete" && taskId) return completeTask(request, env, auth, ctx, taskId);
      if (action === "review" && taskId && request.method === "POST") return assessTask(request, env, auth, taskId, "review");
      if (action === "verify" && taskId && request.method === "POST") return assessTask(request, env, auth, taskId, "verify");
      if (action === "plan" && taskId && request.method === "POST") return submitPlan(request, env, auth, ctx, taskId);
      if (action === "plan-review" && taskId && request.method === "POST") return reviewPlan(request, env, auth, ctx, taskId);
      if (action === "acceptance" && taskId && request.method === "POST") return acceptance(request, env, auth, ctx, taskId);
      if (action === "gate" && taskId && request.method === "POST") return recordGate(request, env, auth, ctx, taskId);
      if (action === "dependencies" && taskId && request.method === "PUT") return dependencies(request, env, auth, taskId);
      if (action === "answer" && taskId && request.method === "POST") return answerWorker(request, env, auth, taskId);
      if (action === "sleep" && taskId && request.method === "POST") return sleepWorker(request, env, auth, taskId);
      if (action === "events" && taskId && request.method === "GET") {
        const access = await authorizeTask(env.DB, auth, taskId);
        if (access.error) return access.error;
        return json({ events: (await env.DB.prepare("SELECT * FROM task_event WHERE task_id = ? ORDER BY created_at").bind(taskId).all()).results });
      }
      return handleTask(request, env, auth, taskId);
    }
    if (url.pathname === "/api/board/projects") return projects(request, env, auth);
    if (url.pathname === "/api/board/briefing") return briefing(request, env, auth);
    if (url.pathname === "/api/board/leader") return leader(request, env, auth);
    if (url.pathname === "/api/board/provision") return provision(request, env, auth);
    if (url.pathname === "/api/board/spawn-stats" && request.method === "GET") return spawnStats(request, env, auth);
    if (url.pathname === "/api/board/share-token") return issueShareToken(request, env, auth);
    if (url.pathname === "/api/board/backup-accounts" || url.pathname.startsWith("/api/board/backup-accounts/")) {
      return backupAccounts(request, env, auth);
    }
    if (url.pathname === "/api/board/worker-profiles" || url.pathname.startsWith("/api/board/worker-profiles/")) {
      return workerProfiles(request, env, auth);
    }
    if (url.pathname === "/api/board/account-claims" || url.pathname === "/api/board/account-claims/release") {
      return accountClaims(request, env, auth);
    }
    if (url.pathname === "/api/board/failover-config") return failoverConfig(request, env, auth);
    if (url.pathname === "/api/board/team" && request.method === "GET") return teamSnapshot(request, env, auth);
    if (url.pathname === "/api/board/events" && request.method === "GET") return projectEvents(request, env, auth);
    const agentMatch = url.pathname.match(/^\/api\/board\/agents(?:\/([^/]+)\/(heartbeat|join|idle|shutdown|rotate-token))?$/);
    if (agentMatch) {
      return agentMatch[1] && url.pathname.endsWith("/heartbeat")
        ? heartbeat(request, env, auth, agentMatch[1])
        : agentMatch[1] && url.pathname.endsWith("/join")
          ? lifecycle(request, env, auth, ctx, agentMatch[1], "active")
          : agentMatch[1] && url.pathname.endsWith("/idle")
            ? lifecycle(request, env, auth, ctx, agentMatch[1], "idle")
            : agentMatch[1] && url.pathname.endsWith("/shutdown")
              ? lifecycle(request, env, auth, ctx, agentMatch[1], "shutdown")
              : agentMatch[1] && url.pathname.endsWith("/rotate-token")
                ? rotateAgentToken(request, env, auth, agentMatch[1])
        : agents(request, env, auth);
    }
    if (url.pathname === "/api/board/hooks" || url.pathname.startsWith("/api/board/hooks/")) {
      return hooks(request, env, auth);
    }
    if (url.pathname === "/api/board/hook-deliveries" && request.method === "GET") {
      return hookDeliveries(request, env, auth);
    }
    return json({ error: "not found" }, 404);
}
