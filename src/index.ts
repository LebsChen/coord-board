export interface Env {
  DB: D1Database;
  BOARD_TOKEN: string;
}

type Phase = "pending" | "ready" | "in_progress" | "done";
type Json = Record<string, unknown>;
type Capability = "manage" | "claim" | "release" | "complete" | "review" | "verify" | "plan_submit" | "plan_review" | "accept" | "gate";
type Decision = "allow" | "ask" | "deny";
type TaskRow = Record<string, unknown>;
type MailboxStatus = "unread" | "seen" | "acked" | "nacked" | "dead";
type Auth =
  | { kind: "admin"; agentId: string | null }
  | { kind: "agent"; agentId: string; projectId: string; role: string };

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
  return agent
    ? { kind: "agent", agentId: agent.id, projectId: agent.project_id, role: agent.role }
    : null;
}

function isAdmin(auth: Auth): auth is Extract<Auth, { kind: "admin" }> {
  return auth.kind === "admin";
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

async function sweepLeases(db: D1Database): Promise<void> {
  const timestamp = now();
  const staleIdempotencyBefore = new Date(Date.now() - IDEMPOTENCY_IN_PROGRESS_TTL_MS).toISOString();
  await db.prepare(
    "DELETE FROM idempotency_key WHERE response_status IS NULL AND created_at <= ?",
  ).bind(staleIdempotencyBefore).run();
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
  const leaseOverride = isAdmin(auth) || roleCapabilities(auth.role).includes("manage");
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

async function agents(request: Request, env: Env, auth: Auth): Promise<Response> {
  if (request.method === "GET") {
    const rows = isAdmin(auth)
      ? await env.DB.prepare("SELECT id, project_id, name, role, status, last_seen_at, metadata_json, created_at, updated_at FROM agent ORDER BY project_id, name").all()
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
  const timestamp = now();
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE agent SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
    ).bind(transition, timestamp, timestamp, agentId, row.project_id),
    env.DB.prepare(
      "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id(), agentId, row.project_id, `agent_${transition}`, JSON.stringify({ actor_agent_id: actor(auth) }), timestamp),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "agent lifecycle transition failed" }, 409);
  const releasedProjects = transition === "shutdown" ? await releaseAgentLeases(env.DB, agentId) : [];
  if (transition === "shutdown") {
    dispatchHooks(ctx, env, row.project_id, "agent_shutdown", "post", { agent_id: agentId, actor_agent_id: actor(auth), released_leases: releasedProjects.length });
  }
  return json({ id: agentId, project_id: row.project_id, status: transition, released_leases: releasedProjects.length });
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
    if (url.pathname === "/api/board/team" && request.method === "GET") return teamSnapshot(request, env, auth);
    const agentMatch = url.pathname.match(/^\/api\/board\/agents(?:\/([^/]+)\/(heartbeat|join|idle|shutdown))?$/);
    if (agentMatch) {
      return agentMatch[1] && url.pathname.endsWith("/heartbeat")
        ? heartbeat(request, env, auth, agentMatch[1])
        : agentMatch[1] && url.pathname.endsWith("/join")
          ? lifecycle(request, env, auth, ctx, agentMatch[1], "active")
          : agentMatch[1] && url.pathname.endsWith("/idle")
            ? lifecycle(request, env, auth, ctx, agentMatch[1], "idle")
            : agentMatch[1] && url.pathname.endsWith("/shutdown")
              ? lifecycle(request, env, auth, ctx, agentMatch[1], "shutdown")
        : agents(request, env, auth);
    }
    if (url.pathname === "/api/board/hooks" || url.pathname.startsWith("/api/board/hooks/")) {
      return hooks(request, env, auth);
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await sweepLeases(env.DB);
  },
};
