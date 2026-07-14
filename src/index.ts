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
const IDEMPOTENCY_IN_PROGRESS_TTL_MS = 60 * 1000;
const BACKUP_ACCOUNT_KEY_VERSION = "v1";
const DEFAULT_FAILOVER_MAX_REPLACEMENTS = 4;
const DEFAULT_FAILOVER_COOLDOWN_SECONDS = 15 * 60;
const DEFAULT_FAILOVER_STALE_GRACE_SECONDS = 10 * 60;
const DEFAULT_ACCOUNT_CLAIM_TTL_SECONDS = 5 * 60;
const MIN_ACCOUNT_CLAIM_TTL_SECONDS = 30;
const MAX_ACCOUNT_CLAIM_TTL_SECONDS = 60 * 60;
const MAX_ACCOUNT_CLAIMS_PER_REQUEST = 100;

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

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

function dispatchHooks(
  ctx: ExecutionContext,
  env: Env,
  projectId: string,
  eventType: string,
  phase: "post" | "failure",
  payload: Json,
): void {
  ctx.waitUntil((async () => {
    const rows = await env.DB.prepare(
      "SELECT id, event_types_json, url, secret FROM hook WHERE project_id = ? AND phase = ? AND active = 1",
    ).bind(projectId, phase).all<{ id: string; event_types_json: string; url: string; secret: string | null }>();
    const body = JSON.stringify({ event_type: eventType, phase, project_id: projectId, payload });
    await Promise.all(rows.results.filter((hook) => {
      try {
        return hookEvents(JSON.parse(hook.event_types_json)).includes(eventType);
      } catch {
        return false;
      }
    }).map(async (hook) => {
      try {
        const headers: HeadersInit = { "content-type": "application/json" };
        if (hook.secret) headers["x-coord-board-signature"] = `sha256=${await hmacSha256(hook.secret, body)}`;
        await fetch(hook.url, { method: "POST", headers, body });
      } catch {
        // Hook failures are intentionally isolated from the main request.
      }
    }));
  })().catch(() => {
    // Hook lookup and dispatch are best effort.
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
    "UPDATE idempotency_key SET response_status = ?, response_body = ? WHERE scope = ? AND key = ?",
  ).bind(response.status, body, scope, key).run();
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
  const response = await fetch(
    `https://api.devin.ai/v3/organizations/${encodeURIComponent(String(backup.org_id))}/sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt }),
    },
  );
  if (!response.ok) throw new Error(`Devin session creation failed (${response.status})`);
  const data = await response.json() as { session_id?: string; devin_id?: string };
  const sessionId = data.session_id || data.devin_id;
  if (!sessionId) throw new Error("Devin session creation returned no session id");
  return sessionId;
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
      `SELECT t.id AS task_id, t.board_id AS project_id, t.lease_owner,
              t.assignee_agent_id, t.lease_generation, a.id AS agent_id, a.role
       FROM task_item t
       JOIN agent a ON a.id = COALESCE(t.lease_owner, t.assignee_agent_id)
       WHERE t.board_id = ? AND t.phase = 'in_progress' AND t.deleted_at IS NULL
         AND a.project_id = ? AND a.last_seen_at IS NOT NULL AND a.last_seen_at <= ?
         AND a.status NOT IN ('shutdown')`,
    ).bind(project.id, project.id, staleBefore).all<StaleFailoverCandidate>();
    const seenAgents = new Set<string>();
    let replacements = 0;
    for (const candidate of candidates.results) {
      if (replacements >= (Number(project.failover_max_replacements) || DEFAULT_FAILOVER_MAX_REPLACEMENTS)) break;
      if (seenAgents.has(candidate.agent_id)) continue;
      seenAgents.add(candidate.agent_id);
      const backup = await reserveBackupAccount(db, project.id, candidate.role, timestamp);
      if (!backup) continue;
      let replacement: { id: string; token: string } | null = null;
      try {
        replacement = await registerFailoverAgent(db, candidate, backup);
        const sessionId = await createFailoverSession(env, candidate, backup, replacement);
        await db.prepare(
          "UPDATE agent SET metadata_json = json_set(metadata_json, '$.session_id', ?), updated_at = ? WHERE id = ? AND project_id = ?",
        ).bind(sessionId, timestamp, replacement.id, project.id).run();
        const generation = Number(candidate.lease_generation) + 1;
        const leaseUpdate = await db.prepare(
          `UPDATE task_item SET lease_owner = NULL, lease_expires_at = NULL, lease_generation = ?,
             updated_at = ? WHERE id = ? AND board_id = ? AND phase = 'in_progress'
             AND (lease_owner = ? OR (lease_owner IS NULL AND assignee_agent_id = ?))`,
        ).bind(generation, timestamp, candidate.task_id, project.id, candidate.agent_id, candidate.agent_id).run();
        if ((leaseUpdate.meta.changes ?? 0) !== 1) throw new Error("stale task lease changed before failover");
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
        replacements += 1;
      } catch (error) {
        if (replacement) {
          await db.prepare("DELETE FROM agent WHERE id = ? AND project_id = ?").bind(replacement.id, project.id).run();
        }
        await db.batch([
          db.prepare(
            "UPDATE backup_account SET status = 'idle', cooldown_until = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND status = 'reserved'",
          ).bind(timestamp, backup.id, project.id),
          event(db, candidate.task_id, "agent_failover_failed", candidate.agent_id, {
            project_id: project.id,
            failed_agent_id: candidate.agent_id,
            backup_account_id: String(backup.id),
            reason: error instanceof Error ? error.message : "session creation failed",
          }),
        ]);
      }
    }
  }
}

async function sweepLeases(db: D1Database, env?: Env): Promise<void> {
  const timestamp = now();
  const staleIdempotencyBefore = new Date(Date.now() - IDEMPOTENCY_IN_PROGRESS_TTL_MS).toISOString();
  await db.prepare(
    "DELETE FROM idempotency_key WHERE response_status IS NULL AND created_at <= ?",
  ).bind(staleIdempotencyBefore).run();
  await db.prepare(
    "UPDATE backup_account SET status = 'idle', cooldown_until = NULL, updated_at = ? WHERE status = 'reserved' AND updated_at <= ?",
  ).bind(timestamp, new Date(Date.now() - 10 * 60 * 1000).toISOString()).run().catch(() => undefined);
  await db.prepare(
    "UPDATE account_claim SET status = 'released', expires_at = ? WHERE status = 'claimed' AND expires_at <= ?",
  ).bind(timestamp, timestamp).run().catch(() => undefined);
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
          assignee_agent_id, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        taskIdNew, responseBody.board_id, responseBody.title, responseBody.description, phase,
        requirePlan, requireAcceptance, responseBody.required_gates, responseBody.priority, responseBody.assignee_agent_id,
        responseBody.sort_order, timestamp, timestamp,
      ),
      event(db, taskIdNew, "created", actor(auth), { title: responseBody.title }),
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
    if (phase === "done" && (
      !(await qualityGatesSatisfied(db, current)) ||
      !(await qualityGatesSatisfied(db, nextRow))
    )) {
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
      updated_at: timestamp,
    };
    await db.batch([
      db.prepare(
        `UPDATE task_item
         SET title = ?, description = ?, priority = ?, phase = ?, require_plan = ?, require_acceptance = ?, required_gates = ?, assignee_agent_id = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL AND board_id = ?`,
      ).bind(title, description, priority, phase, requirePlan, requireAcceptance, responseBody.required_gates, assignee, timestamp, taskId, String(current.board_id)),
      event(db, taskId, "updated", actor(auth), { phase, assignee_agent_id: assignee }),
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

async function claimTask(request: Request, env: Env, auth: Auth, ctx: ExecutionContext, taskId: string): Promise<Response> {
  await sweepLeases(env.DB);
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
  const requestedLeaseSeconds = leaseSeconds(body.lease_seconds);
  const expires = new Date(Date.now() + requestedLeaseSeconds * 1000).toISOString();
  const generation = Number(body.lease_generation ?? 0);
  const timestamp = now();
  const update = env.DB.prepare(
    `UPDATE task_item
     SET phase = 'in_progress', lease_owner = ?, lease_expires_at = ?, lease_generation = lease_generation + 1,
         attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = ? AND board_id = ? AND deleted_at IS NULL
       AND (phase IN ('pending', 'ready') OR (phase = 'in_progress' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND (assignee_agent_id IS NULL OR assignee_agent_id = ?)
       AND NOT EXISTS (
         SELECT 1 FROM task_dependency d
         JOIN task_item dependency ON dependency.id = d.depends_on_id
         WHERE d.task_id = task_item.id AND (dependency.deleted_at IS NOT NULL OR dependency.phase <> 'done')
       )
       AND (? = 0 OR lease_generation = ?)`
  ).bind(owner, expires, timestamp, taskId, projectId, timestamp, timestamp, owner, generation, generation);
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
           acceptance_at = ?, updated_at = ?
       WHERE id = ? AND board_id = ? AND deleted_at IS NULL
         AND require_acceptance = 1 AND acceptance_status = 'submitted' AND phase = 'in_progress'`,
    ).bind(accepted ? "done" : "in_progress", accepted ? "accepted" : "rejected", actor(auth), note, timestamp, timestamp, taskId, projectId),
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
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO message(id, project_id, sender_agent_id, kind, subject, payload_json, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(message.id, message.project_id, message.sender_agent_id, message.kind, message.subject, message.payload_json, message.reply_to, message.created_at),
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
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = sent
    ? `SELECT m.* FROM message m ${where} ORDER BY m.created_at DESC`
    : `SELECT d.*, m.sender_agent_id, m.kind, m.subject, m.payload_json, m.reply_to, m.created_at AS message_created_at
       FROM message_delivery d JOIN message m ON m.id = d.message_id ${where} ORDER BY d.updated_at DESC`;
  const rows = await env.DB.prepare(query).bind(...values).all<Record<string, unknown>>();
  return json({
    messages: sent ? rows.results.map(mailboxMessageView) : [],
    deliveries: sent ? [] : rows.results.map((row) => ({ ...row, payload: mailboxPayload(row) })),
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
      const item = entry as Json;
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
      ids.push(accountId);
      statements.push(env.DB.prepare(
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
      ));
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
  const gates = taskIds.length
    ? await env.DB.prepare(
      `SELECT task_id, gate_name, status, by_agent, note, created_at, updated_at
       FROM task_gate WHERE task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY gate_name`,
    ).bind(...taskIds).all<Record<string, unknown>>()
    : { results: [] as Record<string, unknown>[] };
  const gatesByTask = new Map<string, Record<string, unknown>[]>();
  for (const gate of gates.results) {
    const taskGates = gatesByTask.get(String(gate.task_id)) ?? [];
    taskGates.push(gate);
    gatesByTask.set(String(gate.task_id), taskGates);
  }
  const taskViews = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    phase: task.phase,
    assignee_agent_id: task.assignee_agent_id,
    lease_owner: task.lease_owner,
    lease_expires_at: task.lease_expires_at,
    plan_status: task.plan_status,
    acceptance_status: task.acceptance_status,
    required_gates: requiredGates(task),
    gates: gatesByTask.get(String(task.id)) ?? [],
  }));
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
  });
}

const html = `<!doctype html><meta charset="utf-8"><title>Coord Board</title>
<style>body{font:14px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}input,textarea,button{padding:.5rem;margin:.2rem}section{margin:1.5rem 0}.task,.agent{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:.5rem 0}.muted{color:#666}.blocked{opacity:.55}.pill{display:inline-block;background:#eee;border-radius:999px;padding:.15rem .5rem;margin-left:.3rem}button{cursor:pointer}</style>
<h1>Coord Board</h1><h2 id="project-heading"></h2><label>Bearer token <input id="token" type="password" size="50"></label><label>Agent ID <input id="agent" value="ui-agent"></label><button onclick="saveAndLoad()">Load dashboard</button>
<form onsubmit="add(event)"><input id="title" placeholder="Task title" required><input id="board" value="default" placeholder="project"><button>Add task</button></form>
<section><h3>Agents</h3><div id="agents" class="muted">Load a project to view the team.</div></section>
<section><h3>Tasks</h3><main id="tasks" class="muted">Load a project to view tasks.</main></section>
<section><h3>Dead letters</h3><div id="deadletters" class="muted">—</div></section>
<script>
const query=new URLSearchParams(location.search); const sharedParams=new URLSearchParams(location.hash.startsWith('#')?location.hash.slice(1):location.hash); const sharedToken=sharedParams.get('token')||sharedParams.get('tkn'); if(sharedToken) sessionStorage.setItem('coord-board-token',sharedToken); if(location.hash) history.replaceState(null,document.title,location.pathname+location.search); const project=query.get('project')||query.get('board')||sessionStorage.getItem('coord-board-project')||'default'; const token=document.querySelector('#token'); token.value=sessionStorage.getItem('coord-board-token')||''; document.querySelector('#project-heading').textContent='Project: '+project; document.querySelector('#board').value=project; document.querySelector('#board').readOnly=Boolean(query.get('project')||query.get('board')); const api=(p,o={})=>fetch('/api/board'+p,{...o,headers:{Authorization:'Bearer '+token.value,'Content-Type':'application/json',...(o.headers||{})}}).then(async r=>({status:r.status,data:await r.json()}));
function saveAndLoad(){sessionStorage.setItem('coord-board-token',token.value);sessionStorage.setItem('coord-board-project',project);load()}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function result(r){if(r.status>=400) alert(r.data.error||'Request failed');return r}
async function load(){const r=await api('/team?project='+encodeURIComponent(project));if(r.status>=400){document.querySelector('#agents').textContent=r.data.error||'Unable to load team';return}const d=r.data;document.querySelector('#agents').innerHTML=(d.agents||[]).map(a=>'<article class="agent"><b>'+esc(a.name||a.id)+'</b> <span class="pill">'+esc(a.status)+'</span> <span class="muted">'+esc(a.role||'worker')+' · last seen '+esc(a.last_seen_at||'never')+'</span>'+(a.current_task?'<div>Current task: '+esc(a.current_task.title)+' ('+esc(a.current_task.phase)+')</div>':'<div class="muted">No leased task</div>')+'<button onclick="shutdown(\\''+esc(a.id)+'\\')">Force shutdown</button></article>').join('')||'<span class="muted">No agents</span>';document.querySelector('#tasks').innerHTML=(d.tasks||[]).map(t=>'<article class="task"><b>'+esc(t.title)+'</b> <span class="pill">'+esc(t.phase)+'</span><div>Assignee: '+esc(t.assignee_agent_id||'unassigned')+' · Lease: '+esc(t.lease_owner||'none')+(t.lease_expires_at?' until '+esc(t.lease_expires_at):'')+'</div><div>Plan: '+esc(t.plan_status||'none')+' · Acceptance: '+esc(t.acceptance_status||'none')+' · Gates: '+esc((t.gates||[]).map(g=>g.gate_name+':'+g.status).join(', ')||'none')+'</div><button onclick="claim(\\''+esc(t.id)+'\\')">Claim</button><button onclick="complete(\\''+esc(t.id)+'\\')">Complete</button><button onclick="reassign(\\''+esc(t.id)+'\\')">Reassign</button>'+(t.lease_owner?'<button onclick="release(\\''+esc(t.id)+'\\',\\''+esc(t.lease_owner)+'\\')">Force release</button>':'')+'</article>').join('')||'<span class="muted">No tasks</span>';document.querySelector('#deadletters').textContent=String(d.dead_letter_count??0)}
async function add(e){e.preventDefault();result(await api('/tasks',{method:'POST',body:JSON.stringify({title:document.querySelector('#title').value,board_id:project})}));e.target.reset();load()}
async function claim(id){result(await api('/tasks/'+id+'/claim',{method:'POST',body:JSON.stringify({agent_id:document.querySelector('#agent').value})}));load()} async function complete(id){result(await api('/tasks/'+id+'/complete',{method:'POST',body:JSON.stringify({agent_id:document.querySelector('#agent').value})}));load()} async function shutdown(id){result(await api('/agents/'+id+'/shutdown',{method:'POST',body:'{}'}));load()} async function release(id,agent){result(await api('/tasks/'+id+'/release',{method:'POST',body:JSON.stringify({agent_id:agent})}));load()} async function reassign(id){const agent=prompt('Assignee agent id (blank to clear):','');if(agent===null)return;result(await api('/tasks/'+id+'/reassign',{method:'POST',body:JSON.stringify({assignee_agent_id:agent||null})}));load()} load()
</script>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return json({ ok: true, service: "coord-board" });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization,content-type,idempotency-key,x-agent-id",
        },
      });
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
    const taskMatch = url.pathname.match(/^\/api\/board\/tasks(?:\/([^/]+)(?:\/(claim|renew|release|complete|review|verify|plan|plan-review|acceptance|gate|reassign|dependencies|events))?)?$/);
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
      if (action === "events" && taskId && request.method === "GET") {
        const access = await authorizeTask(env.DB, auth, taskId);
        if (access.error) return access.error;
        return json({ events: (await env.DB.prepare("SELECT * FROM task_event WHERE task_id = ? ORDER BY created_at").bind(taskId).all()).results });
      }
      return handleTask(request, env, auth, taskId);
    }
    if (url.pathname === "/api/board/projects") return projects(request, env, auth);
    if (url.pathname === "/api/board/briefing") return briefing(request, env, auth);
    if (url.pathname === "/api/board/share-token") return issueShareToken(request, env, auth);
    if (url.pathname === "/api/board/backup-accounts" || url.pathname.startsWith("/api/board/backup-accounts/")) {
      return backupAccounts(request, env, auth);
    }
    if (url.pathname === "/api/board/account-claims" || url.pathname === "/api/board/account-claims/release") {
      return accountClaims(request, env, auth);
    }
    if (url.pathname === "/api/board/failover-config") return failoverConfig(request, env, auth);
    if (url.pathname === "/api/board/team" && request.method === "GET") return teamSnapshot(request, env, auth);
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
    return json({ error: "not found" }, 404);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await sweepLeases(env.DB, env);
  },
};
