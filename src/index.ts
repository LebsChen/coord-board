export interface Env {
  DB: D1Database;
  BOARD_TOKEN: string;
}

type Phase = "pending" | "ready" | "in_progress" | "done";
type Json = Record<string, unknown>;
type Auth =
  | { kind: "admin"; agentId: string | null }
  | { kind: "agent"; agentId: string; projectId: string; role: string };

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

async function sweepLeases(db: D1Database): Promise<void> {
  const timestamp = now();
  await db.prepare(
    "UPDATE task_item SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND phase = 'in_progress'",
  ).bind(timestamp, timestamp).run();
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

async function taskView(db: D1Database, row: Record<string, unknown>) {
  return { ...row, dependencies: await listDependencies(db, String(row.id)) };
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
    const requestedBoard = url.searchParams.get("board_id");
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
    const responseBody = {
      id: taskIdNew,
      board_id: boardId,
      title: String(body.title || "").trim(),
      description: String(body.description || ""),
      phase,
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
        "INSERT INTO task_item(id, board_id, title, description, phase, priority, assignee_agent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(taskIdNew, responseBody.board_id, responseBody.title, responseBody.description, phase, responseBody.priority, responseBody.assignee_agent_id, responseBody.sort_order, timestamp, timestamp),
      event(db, taskIdNew, "created", actor(auth), { title: responseBody.title }),
    ]);
    return saveIdempotentResponse(db, `task:create:${boardId}`, key, json(responseBody, 201));
  }
  if (!taskId) return json({ error: "not found" }, 404);
  const access = await authorizeTask(db, auth, taskId);
  if (access.error) return access.error;
  const current = access.row as Record<string, unknown>;
  if (method === "GET") return json(await taskView(db, current));
  const body = await parseBody(request);
  const identityError = checkAgentIdentity(body, auth);
  if (identityError) return identityError;
  if (method === "PATCH") {
    const key = idempotencyKey(request, body);
    const replay = await replayOrReserve(db, `task:update:${taskId}`, key);
    if (replay) return replay;
    const title = body.title === undefined ? current.title : String(body.title).trim();
    const description = body.description === undefined ? current.description : String(body.description);
    const priority = body.priority === undefined ? current.priority : Number(body.priority);
    const phase = body.phase === undefined ? current.phase : String(body.phase);
    if (!["pending", "ready", "in_progress", "done"].includes(String(phase))) {
      return json({ error: "invalid phase" }, 422);
    }
    const timestamp = now();
    const responseBody = { ...current, title, description, priority, phase, updated_at: timestamp };
    await db.batch([
      db.prepare(
        "UPDATE task_item SET title = ?, description = ?, priority = ?, phase = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND board_id = ?",
      ).bind(title, description, priority, phase, timestamp, taskId, String(current.board_id)),
      event(db, taskId, "updated", actor(auth), { phase }),
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

async function claimTask(request: Request, env: Env, auth: Auth, taskId: string): Promise<Response> {
  await sweepLeases(env.DB);
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const body = await parseBody(request);
  const identityError = checkAgentIdentity(body, auth);
  if (identityError) return identityError;
  const owner = bodyAgent(body, auth);
  if (!owner) return json({ error: "agent_id or x-agent-id is required" }, 400);
  const projectId = String(access.row?.board_id);
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, `task:claim:${taskId}`, key);
  if (replay) return replay;
  const leaseSeconds = Math.max(10, Number(body.lease_seconds ?? 300));
  const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
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
  const response = json(await taskView(env.DB, claimed as Record<string, unknown>), 200);
  return saveIdempotentResponse(env.DB, `task:claim:${taskId}`, key, response);
}

async function releaseTask(request: Request, env: Env, auth: Auth, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const body = await parseBody(request);
  const identityError = checkAgentIdentity(body, auth);
  if (identityError) return identityError;
  const owner = bodyAgent(body, auth);
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, `task:release:${taskId}`, key);
  if (replay) return replay;
  const timestamp = now();
  const projectId = String(access.row?.board_id);
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE task_item SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND board_id = ? AND lease_owner = ? AND deleted_at IS NULL",
    ).bind(timestamp, taskId, projectId, owner),
    conditionalEvent(env.DB, taskId, "released", owner, { project_id: projectId }, "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND lease_owner IS NULL AND updated_at = ?)", [taskId, projectId, timestamp]),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "lease not owned" }, 409);
  return saveIdempotentResponse(env.DB, `task:release:${taskId}`, key, json({ ok: true }));
}

async function completeTask(request: Request, env: Env, auth: Auth, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const body = await parseBody(request);
  const identityError = checkAgentIdentity(body, auth);
  if (identityError) return identityError;
  const owner = bodyAgent(body, auth);
  const key = idempotencyKey(request, body);
  const replay = await replayOrReserve(env.DB, `task:complete:${taskId}`, key);
  if (replay) return replay;
  const timestamp = now();
  const projectId = String(access.row?.board_id);
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE task_item SET phase = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND board_id = ? AND deleted_at IS NULL AND (lease_owner = ? OR lease_owner IS NULL)",
    ).bind(timestamp, taskId, projectId, owner),
    conditionalEvent(env.DB, taskId, "completed", owner, { result: body.result ?? null, project_id: projectId }, "EXISTS (SELECT 1 FROM task_item WHERE id = ? AND board_id = ? AND phase = 'done' AND updated_at = ?)", [taskId, projectId, timestamp]),
  ]);
  if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "task not found or lease not owned" }, 409);
  const completed = await task(env.DB, taskId);
  return saveIdempotentResponse(env.DB, `task:complete:${taskId}`, key, json(await taskView(env.DB, completed as Record<string, unknown>)));
}

async function dependencies(request: Request, env: Env, auth: Auth, taskId: string): Promise<Response> {
  const access = await authorizeTask(env.DB, auth, taskId);
  if (access.error) return access.error;
  const body = await parseBody(request);
  const ids = Array.isArray(body.depends_on) ? body.depends_on.map(String) : [];
  if (ids.includes(taskId)) return json({ error: "dependency cycle" }, 422);
  const placeholders = ids.map(() => "?").join(",") || "NULL";
  const existing = ids.length
    ? await env.DB.prepare(`SELECT id, board_id FROM task_item WHERE id IN (${placeholders}) AND deleted_at IS NULL`).bind(...ids).all<{ id: string; board_id: string }>()
    : { results: [] };
  if (existing.results.length !== ids.length) return json({ error: "dependency task not found" }, 422);
  if (!isAdmin(auth) && existing.results.some((row) => row.board_id !== auth.projectId)) {
    return json({ error: "dependency belongs to another project" }, 403);
  }
  const timestamp = now();
  const projectId = String(access.row?.board_id);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM task_dependency WHERE task_id = ?").bind(taskId),
    ...ids.map((dependencyId) => env.DB.prepare("INSERT INTO task_dependency(task_id, depends_on_id) VALUES (?, ?)").bind(taskId, dependencyId)),
    event(env.DB, taskId, "dependencies_updated", actor(auth), { depends_on: ids, project_id: projectId }),
  ];
  await env.DB.batch(statements);
  return json({ task_id: taskId, depends_on: ids, updated_at: timestamp });
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
  const result = await env.DB.prepare(
    "UPDATE agent SET status = 'online', last_seen_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
  ).bind(timestamp, timestamp, agentId, row.project_id).run();
  if ((result.meta.changes ?? 0) !== 1) return json({ error: "agent not found" }, 404);
  return json({ id: agentId, project_id: row.project_id, status: "online", last_seen_at: timestamp });
}

const html = `<!doctype html><meta charset="utf-8"><title>Coord Board</title>
<style>body{font:14px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}input,textarea,button{padding:.5rem;margin:.2rem}textarea{width:100%}.task{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:.5rem 0}.blocked{opacity:.55}</style>
<h1>Coord Board</h1><label>Bearer token <input id="token" type="password" size="50"></label><label>Agent ID <input id="agent" value="ui-agent"></label><button onclick="saveAndLoad()">Load</button>
<form onsubmit="add(event)"><input id="title" placeholder="Task title" required><input id="board" value="default" placeholder="project"><button>Add</button></form><main id="tasks"></main>
<script>
const token=document.querySelector('#token'); token.value=sessionStorage.getItem('coord-board-token')||''; const api=(p,o={})=>fetch('/api/board'+p,{...o,headers:{Authorization:'Bearer '+token.value,'Content-Type':'application/json',...(o.headers||{})}}).then(r=>r.json());
function saveAndLoad(){sessionStorage.setItem('coord-board-token',token.value);load()}
async function load(){const d=await api('/tasks');document.querySelector('#tasks').innerHTML=(d.tasks||[]).map(t=>'<article class="task '+(t.dependencies.length?'blocked':'')+'"><b>'+esc(t.title)+'</b> <small>'+t.phase+' / '+(t.lease_owner||'unassigned')+'</small><p>'+esc(t.description||'')+'</p><button onclick="claim(\\''+t.id+'\\')">Claim</button><button onclick="complete(\\''+t.id+'\\')">Complete</button></article>').join('')}
async function add(e){e.preventDefault();await api('/tasks',{method:'POST',body:JSON.stringify({title:document.querySelector('#title').value,board_id:document.querySelector('#board').value})});e.target.reset();load()}
async function claim(id){const agent=document.querySelector('#agent').value;await api('/tasks/'+id+'/claim',{method:'POST',body:JSON.stringify({agent_id:agent})});load()} async function complete(id){await api('/tasks/'+id+'/complete',{method:'POST',body:JSON.stringify({agent_id:document.querySelector('#agent').value})});load()} function esc(s){return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
</script>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "coord-board" });
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
    const taskMatch = url.pathname.match(/^\/api\/board\/tasks(?:\/([^/]+)(?:\/(claim|release|complete|dependencies|events))?)?$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      const action = taskMatch[2];
      if (action === "claim" && taskId) return claimTask(request, env, auth, taskId);
      if (action === "release" && taskId) return releaseTask(request, env, auth, taskId);
      if (action === "complete" && taskId) return completeTask(request, env, auth, taskId);
      if (action === "dependencies" && taskId && request.method === "PUT") return dependencies(request, env, auth, taskId);
      if (action === "events" && taskId && request.method === "GET") {
        const access = await authorizeTask(env.DB, auth, taskId);
        if (access.error) return access.error;
        return json({ events: (await env.DB.prepare("SELECT * FROM task_event WHERE task_id = ? ORDER BY created_at").bind(taskId).all()).results });
      }
      return handleTask(request, env, auth, taskId);
    }
    if (url.pathname === "/api/board/projects") return projects(request, env, auth);
    const agentMatch = url.pathname.match(/^\/api\/board\/agents(?:\/([^/]+)\/heartbeat)?$/);
    if (agentMatch) {
      return agentMatch[1] && url.pathname.endsWith("/heartbeat")
        ? heartbeat(request, env, auth, agentMatch[1])
        : agents(request, env, auth);
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await sweepLeases(env.DB);
  },
};
