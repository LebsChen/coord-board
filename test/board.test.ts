import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const request = (path: string, init: RequestInit = {}, token = "test-token") =>
  new Request(`https://coord-board.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
const call = (path: string, init: RequestInit = {}, token = "test-token") => {
  return SELF.fetch(request(path, init, token)).then(async (response) => ({
    response,
    body: await response.json() as Record<string, any>,
  }));
};

describe("coord board", () => {
  beforeAll(async () => {
    for (const id of ["a", "b", "lead", "worker", "dead", "new"]) {
      const result = await call("/api/board/agents", { method: "POST", body: JSON.stringify({ id, name: id }) });
      expect(result.response.status).toBe(201);
    }
  });

  it("atomically permits one claimant", async () => {
    const created = await call("/api/board/tasks", { method: "POST", body: JSON.stringify({ title: "race" }) });
    const id = created.body.id;
    const [a, b] = await Promise.all([
      call(`/api/board/tasks/${id}/claim`, { method: "POST", headers: { "x-agent-id": "a" }, body: "{}" }),
      call(`/api/board/tasks/${id}/claim`, { method: "POST", headers: { "x-agent-id": "b" }, body: "{}" }),
    ]);
    expect([a.response.status, b.response.status].sort()).toEqual([200, 409]);
  });

  it("gates dependencies and unblocks after completion", async () => {
    const parent = await call("/api/board/tasks", { method: "POST", body: JSON.stringify({ title: "parent" }) });
    const child = await call("/api/board/tasks", { method: "POST", body: JSON.stringify({ title: "child" }) });
    await call(`/api/board/tasks/${child.body.id}/dependencies`, { method: "PUT", body: JSON.stringify({ depends_on: [parent.body.id] }) });
    const blocked = await call(`/api/board/tasks/${child.body.id}/claim`, { method: "POST", body: JSON.stringify({ agent_id: "worker" }) });
    expect(blocked.response.status).toBe(422);
    await call(`/api/board/tasks/${parent.body.id}/complete`, { method: "POST", body: JSON.stringify({ agent_id: "lead" }) });
    const ready = await call(`/api/board/tasks/${child.body.id}/claim`, { method: "POST", body: JSON.stringify({ agent_id: "worker" }) });
    expect(ready.response.status).toBe(200);
  });

  it("replays idempotent creates", async () => {
    const init = { method: "POST", headers: { "idempotency-key": "same-create" }, body: JSON.stringify({ title: "once" }) };
    const first = await call("/api/board/tasks", init);
    const second = await call("/api/board/tasks", init);
    expect(first.body.id).toBe(second.body.id);
  });

  it("reclaims expired leases", async () => {
    const created = await call("/api/board/tasks", { method: "POST", body: JSON.stringify({ title: "lease" }) });
    const first = await call(`/api/board/tasks/${created.body.id}/claim`, { method: "POST", body: JSON.stringify({ agent_id: "dead", lease_seconds: 10 }) });
    expect(first.response.status).toBe(200);
    await env.DB.prepare("UPDATE task_item SET lease_expires_at = ? WHERE id = ?").bind("2000-01-01T00:00:00.000Z", created.body.id).run();
    const second = await call(`/api/board/tasks/${created.body.id}/claim`, { method: "POST", body: JSON.stringify({ agent_id: "new" }) });
    expect(second.response.status).toBe(200);
    expect(second.body.lease_owner).toBe("new");
  });

  it("isolates projects and issues hashed one-time agent tokens", async () => {
    const projectA = await call("/api/board/projects", {
      method: "POST",
      headers: { "idempotency-key": "project-a" },
      body: JSON.stringify({ id: "project-a", name: "Project A" }),
    });
    const projectB = await call("/api/board/projects", {
      method: "POST",
      headers: { "idempotency-key": "project-b" },
      body: JSON.stringify({ id: "project-b", name: "Project B" }),
    });
    expect(projectA.response.status).toBe(201);
    expect(projectB.response.status).toBe(201);

    const registeredA = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "project-agent-a", project_id: "project-a", name: "Agent A", role: "开发" }),
    });
    const registeredB = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "project-agent-b", project_id: "project-b", name: "Agent B", role: "测试" }),
    });
    expect(registeredA.response.status).toBe(201);
    expect(registeredB.response.status).toBe(201);
    const tokenA = String(registeredA.body.token);
    const tokenB = String(registeredB.body.token);
    expect(tokenA).not.toBe(tokenB);
    expect(registeredA.body.project_id).toBe("project-a");
    const stored = await env.DB.prepare("SELECT token_hash FROM agent WHERE id = ?").bind("project-agent-a").first<{ token_hash: string }>();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenA));
    const expectedHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(stored?.token_hash).toBe(expectedHash);
    expect(stored?.token_hash).not.toBe(tokenA);

    const taskA = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "project-a", title: "A task" }),
    });
    const taskB = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "project-b", title: "B task" }),
    });
    const before = await call(`/api/board/tasks/${taskB.body.id}`);
    const denied = await call(`/api/board/tasks/${taskB.body.id}/claim`, {
      method: "POST",
      body: JSON.stringify({ agent_id: "project-agent-a" }),
    }, tokenA);
    expect(denied.response.status).toBe(403);
    const after = await call(`/api/board/tasks/${taskB.body.id}`);
    expect(after.body.lease_owner).toBe(before.body.lease_owner);
    expect(after.body.phase).toBe(before.body.phase);

    const own = await call(`/api/board/tasks/${taskA.body.id}/claim`, {
      method: "POST",
    }, tokenA);
    expect(own.response.status).toBe(200);
    expect(own.body.lease_owner).toBe("project-agent-a");

    const visibleA = await call("/api/board/tasks", {}, tokenA);
    expect(visibleA.body.tasks.every((task: { board_id: string }) => task.board_id === "project-a")).toBe(true);
    expect(visibleA.body.tasks.some((task: { id: string }) => task.id === taskA.body.id)).toBe(true);
    expect(visibleA.body.tasks.some((task: { id: string }) => task.id === taskB.body.id)).toBe(false);
    const visibleB = await call("/api/board/tasks", {}, tokenB);
    expect(visibleB.body.tasks.map((task: { id: string }) => task.id)).toContain(taskB.body.id);
    const projectFiltered = await call("/api/board/tasks?project=project-a");
    expect(projectFiltered.body.tasks.every((task: { board_id: string }) => task.board_id === "project-a")).toBe(true);
    expect(projectFiltered.body.tasks.some((task: { id: string }) => task.id === taskB.body.id)).toBe(false);

    const adminVisible = await call("/api/board/tasks");
    expect(adminVisible.body.tasks.map((task: { id: string }) => task.id)).toEqual(expect.arrayContaining([taskA.body.id, taskB.body.id]));
    const agentProjects = await call("/api/board/projects", {}, tokenA);
    expect(agentProjects.body.projects.map((project: { id: string }) => project.id)).toEqual(["project-a"]);
    const fastHeartbeat = await call("/api/board/agents/project-agent-a/heartbeat", { method: "POST" }, tokenA);
    expect(fastHeartbeat.response.status).toBe(429);
    const forbiddenProjectCreate = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "agent-project", name: "Nope" }),
    }, tokenA);
    expect(forbiddenProjectCreate.response.status).toBe(403);
  });

  it("supports many agents work-stealing distinct items in one project", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "project-a", name: "Project A" }),
    });
    expect(project.response.status).toBe(201);
    const registeredA2 = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "project-agent-a2", project_id: "project-a", name: "Agent A2", role: "worker" }),
    });
    const registeredA3 = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "project-agent-a3", project_id: "project-a", name: "Agent A3", role: "worker" }),
    });
    expect(registeredA2.response.status).toBe(201);
    expect(registeredA3.response.status).toBe(201);
    const tokenA2 = String(registeredA2.body.token);
    const tokenA3 = String(registeredA3.body.token);

    const queue = await Promise.all([
      call("/api/board/tasks", { method: "POST", body: JSON.stringify({ board_id: "project-a", title: "Queue 1", priority: 1, sort_order: 1 }) }),
      call("/api/board/tasks", { method: "POST", body: JSON.stringify({ board_id: "project-a", title: "Queue 2", priority: 2, sort_order: 2 }) }),
      call("/api/board/tasks", { method: "POST", body: JSON.stringify({ board_id: "project-a", title: "Queue 3", priority: 3, sort_order: 3 }) }),
    ]);
    const queueIds = queue.map((result) => result.body.id);
    const listed = await call("/api/board/tasks?board_id=project-a", {}, tokenA2);
    const listedQueueIds = listed.body.tasks
      .filter((task: { id: string }) => queueIds.includes(task.id))
      .map((task: { id: string }) => task.id);
    expect(listedQueueIds).toEqual(queueIds);

    const [claimA2, claimA3] = await Promise.all([
      call(`/api/board/tasks/${queueIds[0]}/claim`, { method: "POST" }, tokenA2),
      call(`/api/board/tasks/${queueIds[1]}/claim`, { method: "POST" }, tokenA3),
    ]);
    expect(claimA2.response.status).toBe(200);
    expect(claimA3.response.status).toBe(200);
    expect(claimA2.body.id).not.toBe(claimA3.body.id);
    expect(claimA2.body.lease_owner).toBe("project-agent-a2");
    expect(claimA3.body.lease_owner).toBe("project-agent-a3");

    const completed = await call(`/api/board/tasks/${queueIds[0]}/complete`, { method: "POST" }, tokenA2);
    expect(completed.response.status).toBe(200);
    const next = await call(`/api/board/tasks/${queueIds[2]}/claim`, { method: "POST" }, tokenA2);
    expect(next.response.status).toBe(200);
    expect(next.body.id).toBe(queueIds[2]);
    expect(next.body.lease_owner).toBe("project-agent-a2");
  });

  it("restricts task management to admins and lead-role agents", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "management-project", name: "Management Project" }),
    });
    expect(project.response.status).toBe(201);
    const worker = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "management-worker", project_id: "management-project", name: "Worker", role: "开发" }),
    });
    const lead = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "management-lead", project_id: "management-project", name: "Lead", role: "编排" }),
    });
    expect(worker.response.status).toBe(201);
    expect(lead.response.status).toBe(201);
    const workerToken = String(worker.body.token);
    const leadToken = String(lead.body.token);

    const adminCreated = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "management-project", title: "Admin task" }),
    });
    expect(adminCreated.response.status).toBe(201);
    const taskId = String(adminCreated.body.id);
    const before = await call(`/api/board/tasks/${taskId}`, {}, workerToken);

    const workerCreate = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "management-project", title: "Forbidden task" }),
    }, workerToken);
    const workerPatch = await call(`/api/board/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Changed by worker" }),
    }, workerToken);
    const workerDependencies = await call(`/api/board/tasks/${taskId}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [] }),
    }, workerToken);
    const workerDelete = await call(`/api/board/tasks/${taskId}`, { method: "DELETE" }, workerToken);
    expect(workerCreate.response.status).toBe(403);
    expect(workerPatch.response.status).toBe(403);
    expect(workerDependencies.response.status).toBe(403);
    expect(workerDelete.response.status).toBe(403);
    const after = await call(`/api/board/tasks/${taskId}`, {}, workerToken);
    expect(after.body.title).toBe(before.body.title);
    expect(after.body.deleted_at).toBe(before.body.deleted_at);
    expect(after.body.dependencies).toEqual(before.body.dependencies);

    const leadCreated = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "management-project", title: "Lead task" }),
    }, leadToken);
    expect(leadCreated.response.status).toBe(201);
    const leadTaskId = String(leadCreated.body.id);
    const leadPatched = await call(`/api/board/tasks/${leadTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Lead updated" }),
    }, leadToken);
    expect(leadPatched.response.status).toBe(200);
    const leadDependencies = await call(`/api/board/tasks/${leadTaskId}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [taskId] }),
    }, leadToken);
    expect(leadDependencies.response.status).toBe(200);
    const adminUpdated = await call(`/api/board/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Admin update" }),
    });
    expect(adminUpdated.response.status).toBe(200);

    const workerClaim = await call(`/api/board/tasks/${taskId}/claim`, { method: "POST" }, workerToken);
    expect(workerClaim.response.status).toBe(200);
    const workerComplete = await call(`/api/board/tasks/${taskId}/complete`, { method: "POST" }, workerToken);
    expect(workerComplete.response.status).toBe(200);
  });
});
