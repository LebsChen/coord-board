import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

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
const sha256ForTest = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const nowForTest = () => new Date().toISOString();

describe("coord board", () => {
  beforeAll(async () => {
    for (const id of ["a", "b", "lead", "worker", "dead", "new"]) {
      const result = await call("/api/board/agents", { method: "POST", body: JSON.stringify({ id, name: id }) });
      expect(result.response.status).toBe(201);
    }
  });

  it("returns CORS headers on OPTIONS and on error responses", async () => {
    const preflight = await SELF.fetch(new Request("https://coord-board.test/api/board/projects", { method: "OPTIONS" }));
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const unauthorized = await SELF.fetch(new Request("https://coord-board.test/api/board/projects"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBe("*");
    const notFound = await SELF.fetch(request("/api/board/does-not-exist"));
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("encrypts backup credentials and exposes metadata only", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "backup-project", name: "Backup Project" }),
    });
    expect([201, 409]).toContain(project.response.status);
    const stored = await call("/api/board/backup-accounts", {
      method: "POST",
      body: JSON.stringify({
        project_id: "backup-project",
        id: "backup-a",
        role_tag: "开发",
        label: "Backup A",
        org_id: "org-backup",
        credential_type: "service_user",
        credential: "cog_secret_for_test",
      }),
    });
    expect(stored.response.status).toBe(200);
    expect(JSON.stringify(stored.body)).not.toContain("cog_secret_for_test");
    const row = await env.DB.prepare(
      "SELECT credential_ciphertext, credential_iv FROM backup_account WHERE id = ?",
    ).bind("backup-a").first<{ credential_ciphertext: string; credential_iv: string }>();
    expect(row?.credential_ciphertext).toBeTruthy();
    expect(row?.credential_ciphertext).not.toBe("cog_secret_for_test");
    const rawKey = new Uint8Array(32);
    const key = await crypto.subtle.importKey("raw", rawKey.buffer, { name: "AES-GCM" }, false, ["decrypt"]);
    const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(row!.credential_iv).buffer },
      key,
      decode(row!.credential_ciphertext).buffer,
    );
    expect(new TextDecoder().decode(plaintext)).toBe("cog_secret_for_test");
    const listed = await call("/api/board/backup-accounts?project=backup-project");
    expect(listed.response.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("cog_secret_for_test");
    expect(listed.body.backup_accounts[0]).toMatchObject({
      id: "backup-a",
      role_tag: "开发",
      org_id: "org-backup",
    });
  });

  it("reserves a backup account atomically for one concurrent failover", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "reservation-project", name: "Reservation Project" }),
    });
    expect([201, 409]).toContain(project.response.status);
    await call("/api/board/backup-accounts", {
      method: "POST",
      body: JSON.stringify({
        project_id: "reservation-project",
        id: "reservation-a",
        role_tag: "worker",
        org_id: "org-reservation",
        credential: "api-secret-reservation",
      }),
    });
    await call("/api/board/failover-config", {
      method: "POST",
      body: JSON.stringify({ project_id: "reservation-project", failover_enabled: true }),
    });
    const agent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "reservation-agent", project_id: "reservation-project", name: "Reservation Agent", role: "worker" }),
    });
    expect(agent.response.status).toBe(201);
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "reservation-project", title: "Reservation Task", assignee_agent_id: "reservation-agent" }),
    });
    await env.DB.prepare(
      "UPDATE task_item SET phase = 'in_progress', lease_owner = ?, lease_expires_at = ?, lease_generation = 2 WHERE id = ?",
    ).bind("reservation-agent", "2099-01-01T00:00:00.000Z", task.body.id).run();
    await env.DB.prepare("UPDATE agent SET last_seen_at = ?, status = 'online' WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "reservation-agent").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ session_id: "devin-reservation" }), { status: 200 }),
    );
    await Promise.all([
      worker.scheduled({} as ScheduledEvent, env),
      worker.scheduled({} as ScheduledEvent, env),
    ]);
    fetchMock.mockRestore();
    const accounts = await env.DB.prepare("SELECT status FROM backup_account WHERE id = ?")
      .bind("reservation-a").first<{ status: string }>();
    const replacements = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM agent WHERE project_id = ? AND id <> ?",
    ).bind("reservation-project", "reservation-agent").first<{ count: number }>();
    expect(accounts?.status).toBe("active");
    expect(Number(replacements?.count)).toBe(1);
    expect(Number((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM failover_replacement WHERE project_id = ? AND status = 'created'",
    ).bind("reservation-project").first<{ count: number }>())?.count)).toBe(1);
  });

  it("does not create a second Devin session when concurrent failover loses the lease CAS", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "failover-cas-project", name: "Failover CAS" }),
    });
    expect(project.response.status).toBe(201);
    for (const id of ["failover-cas-a", "failover-cas-b"]) {
      await call("/api/board/backup-accounts", {
        method: "POST",
        body: JSON.stringify({
          project_id: "failover-cas-project",
          id,
          role_tag: "worker",
          org_id: "org-failover-cas",
          credential: `api-secret-${id}`,
        }),
      });
    }
    await call("/api/board/failover-config", {
      method: "POST",
      body: JSON.stringify({ project_id: "failover-cas-project", failover_enabled: true }),
    });
    const agent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "cas-agent", project_id: "failover-cas-project", name: "Failover Agent", role: "worker" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "failover-cas-project", title: "CAS task", assignee_agent_id: "cas-agent" }),
    });
    await env.DB.prepare(
      "UPDATE task_item SET phase = 'in_progress', lease_owner = ?, lease_expires_at = ?, lease_generation = 2 WHERE id = ?",
    ).bind("cas-agent", "2099-01-01T00:00:00.000Z", task.body.id).run();
    await env.DB.prepare("UPDATE agent SET last_seen_at = ?, status = 'online' WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "cas-agent").run();
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
    const methods: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      methods.push(String(init?.method ?? "GET"));
      await sessionGate;
      return new Response(JSON.stringify({ session_id: "devin-cas" }), { status: 200 });
    });
    const first = worker.scheduled({} as ScheduledEvent, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = worker.scheduled({} as ScheduledEvent, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSession();
    await Promise.all([first, second]);
    expect(methods.filter((method) => method === "POST")).toHaveLength(1);
    fetchMock.mockRestore();
    expect(Number((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM agent WHERE project_id = ? AND id LIKE 'failover-%'",
    ).bind("failover-cas-project").first<{ count: number }>())?.count)).toBe(1);
    expect(Number((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM failover_replacement WHERE project_id = ? AND status = 'created'",
    ).bind("failover-cas-project").first<{ count: number }>())?.count)).toBe(1);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM backup_account WHERE project_id = ? AND status = 'idle'",
    ).bind("failover-cas-project").first<{ count: number }>())?.count).toBe(1);
  });

  it("leaves disabled failover unchanged and replaces one stale agent when enabled", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "failover-project", name: "Failover Project" }),
    });
    expect([201, 409]).toContain(project.response.status);
    await call("/api/board/backup-accounts", {
      method: "POST",
      body: JSON.stringify({
        project_id: "failover-project",
        id: "failover-a",
        role_tag: "worker",
        org_id: "org-failover",
        credential: "api-secret-failover",
      }),
    });
    const agent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "failover-agent", project_id: "failover-project", name: "Failover Agent", role: "worker" }),
    });
    expect(agent.response.status).toBe(201);
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "failover-project", title: "Failover Task", assignee_agent_id: "failover-agent" }),
    });
    await env.DB.prepare(
      "UPDATE task_item SET phase = 'in_progress', lease_owner = ?, lease_expires_at = ?, lease_generation = 4 WHERE id = ?",
    ).bind("failover-agent", "2099-01-01T00:00:00.000Z", task.body.id).run();
    await env.DB.prepare("UPDATE agent SET last_seen_at = ?, status = 'online' WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "failover-agent").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ session_id: "devin-failover" }), { status: 200 }),
    );
    await worker.scheduled({} as ScheduledEvent, env);
    expect((await env.DB.prepare("SELECT status FROM backup_account WHERE id = ?").bind("failover-a").first<{ status: string }>())?.status).toBe("idle");
    await call("/api/board/failover-config", {
      method: "POST",
      body: JSON.stringify({ project_id: "failover-project", failover_enabled: true, cooldown_seconds: 60 }),
    });
    await worker.scheduled({} as ScheduledEvent, env);
    fetchMock.mockRestore();
    const oldAgent = await env.DB.prepare("SELECT status, token_revoked_at FROM agent WHERE id = ?")
      .bind("failover-agent").first<{ status: string; token_revoked_at: string | null }>();
    const updatedTask = await env.DB.prepare("SELECT lease_generation, lease_owner FROM task_item WHERE id = ?")
      .bind(task.body.id).first<{ lease_generation: number; lease_owner: string | null }>();
    const replacement = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM agent WHERE project_id = ? AND id <> ?",
    ).bind("failover-project", "failover-agent").first<{ count: number }>();
    expect(oldAgent?.status).toBe("shutdown");
    expect(oldAgent?.token_revoked_at).toBeTruthy();
    expect(updatedTask?.lease_generation).toBe(5);
    expect(updatedTask?.lease_owner).toBeNull();
    expect(Number(replacement?.count)).toBe(1);
    expect((await env.DB.prepare("SELECT status FROM backup_account WHERE id = ?").bind("failover-a").first<{ status: string }>())?.status).toBe("active");
  });

  it("releases a reserved account when Devin session creation fails", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "failure-project", name: "Failure Project" }),
    });
    expect([201, 409]).toContain(project.response.status);
    await call("/api/board/backup-accounts", {
      method: "POST",
      body: JSON.stringify({
        project_id: "failure-project",
        id: "failure-a",
        role_tag: "worker",
        org_id: "org-failure",
        credential: "api-secret-failure",
      }),
    });
    await call("/api/board/failover-config", {
      method: "POST",
      body: JSON.stringify({ project_id: "failure-project", failover_enabled: true }),
    });
    const agent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "failure-agent", project_id: "failure-project", name: "Failure Agent", role: "worker" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "failure-project", title: "Failure Task", assignee_agent_id: "failure-agent" }),
    });
    await env.DB.prepare(
      "UPDATE task_item SET phase = 'in_progress', lease_owner = ? WHERE id = ?",
    ).bind("failure-agent", task.body.id).run();
    await env.DB.prepare("UPDATE agent SET last_seen_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "failure-agent").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    await worker.scheduled({} as ScheduledEvent, env);
    fetchMock.mockRestore();
    expect((await env.DB.prepare("SELECT status FROM backup_account WHERE id = ?").bind("failure-a").first<{ status: string }>())?.status).toBe("idle");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM agent WHERE project_id = ? AND id LIKE 'failover-%'")
      .bind("failure-project").first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT lease_owner FROM task_item WHERE id = ?")
      .bind(task.body.id).first<{ lease_owner: string | null }>())?.lease_owner).toBe("failure-agent");
  });

  it("terminates a created session when failover finalization loses the task race", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "failover-cleanup-project", name: "Failover Cleanup" }),
    });
    expect(project.response.status).toBe(201);
    await call("/api/board/backup-accounts", {
      method: "POST",
      body: JSON.stringify({
        project_id: "failover-cleanup-project",
        id: "failover-cleanup-a",
        role_tag: "worker",
        org_id: "org-failover-cleanup",
        credential: "api-secret-failover-cleanup",
      }),
    });
    await call("/api/board/failover-config", {
      method: "POST",
      body: JSON.stringify({ project_id: "failover-cleanup-project", name: "ignored", failover_enabled: true }),
    });
    const agent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "cleanup-agent", project_id: "failover-cleanup-project", name: "Failover Agent", role: "worker" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "failover-cleanup-project", title: "Cleanup task", assignee_agent_id: "cleanup-agent" }),
    });
    await env.DB.prepare(
      "UPDATE task_item SET phase = 'in_progress', lease_owner = ?, lease_generation = 3 WHERE id = ?",
    ).bind("cleanup-agent", task.body.id).run();
    await env.DB.prepare("UPDATE agent SET last_seen_at = ?, status = 'online' WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", "cleanup-agent").run();
    const methods: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const method = init?.method || "GET";
      methods.push(method);
      if (method === "POST") {
        await env.DB.prepare("UPDATE task_item SET lease_owner = 'racer', lease_generation = 99 WHERE id = ?")
          .bind(task.body.id).run();
        return new Response(JSON.stringify({ session_id: "devin-cleanup" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    await worker.scheduled({} as ScheduledEvent, env);
    fetchMock.mockRestore();
    expect(methods).toEqual(["POST", "DELETE"]);
    expect((await env.DB.prepare("SELECT status FROM backup_account WHERE id = ?")
      .bind("failover-cleanup-a").first<{ status: string }>())?.status).toBe("idle");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM agent WHERE project_id = ? AND id LIKE 'failover-%'")
      .bind("failover-cleanup-project").first<{ count: number }>())?.count).toBe(0);
    const failureEvent = await env.DB.prepare(
      "SELECT payload_json FROM task_event WHERE task_id = ? AND event_type = 'agent_failover_failed' ORDER BY created_at DESC LIMIT 1",
    ).bind(task.body.id).first<{ payload_json: string }>();
    expect(failureEvent?.payload_json).toContain("devin-cleanup");
  });

  it("enforces failover replacements over a rolling quota across cron runs", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "failover-quota-project", name: "Failover Quota" }),
    });
    expect(project.response.status).toBe(201);
    for (const suffix of ["a", "b"]) {
      await call("/api/board/backup-accounts", {
        method: "POST",
        body: JSON.stringify({
          project_id: "failover-quota-project",
          id: `failover-quota-${suffix}`,
          role_tag: "worker",
          org_id: "org-failover-quota",
          credential: `api-secret-quota-${suffix}`,
        }),
      });
      await call("/api/board/agents", {
        method: "POST",
        body: JSON.stringify({ id: `failover-quota-agent-${suffix}`, project_id: "failover-quota-project", name: `Agent ${suffix}`, role: "worker" }),
      });
      const task = await call("/api/board/tasks", {
        method: "POST",
        body: JSON.stringify({ board_id: "failover-quota-project", title: `Quota task ${suffix}`, assignee_agent_id: `failover-quota-agent-${suffix}` }),
      });
      await env.DB.prepare(
        "UPDATE task_item SET phase = 'in_progress', lease_owner = ?, lease_generation = 1 WHERE id = ?",
      ).bind(`failover-quota-agent-${suffix}`, task.body.id).run();
      await env.DB.prepare("UPDATE agent SET last_seen_at = ?, status = 'online' WHERE id = ?")
        .bind("2000-01-01T00:00:00.000Z", `failover-quota-agent-${suffix}`).run();
    }
    await call("/api/board/failover-config", {
      method: "POST",
      body: JSON.stringify({ project_id: "failover-quota-project", failover_enabled: true, max_replacements: 1 }),
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ session_id: "devin-quota" }), { status: 200 }),
    );
    await worker.scheduled({} as ScheduledEvent, env);
    await worker.scheduled({} as ScheduledEvent, env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
    expect(Number((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM failover_replacement WHERE project_id = ? AND status = 'created'",
    ).bind("failover-quota-project").first<{ count: number }>())?.count)).toBe(1);
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

  it("reports an assignee mismatch instead of an unmet dependency", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "claim-assignee-diagnostics", name: "Claim Assignee Diagnostics" }),
    });
    const developer = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "claim-assignee-developer",
        project_id: "claim-assignee-diagnostics",
        name: "Developer",
        role: "开发 Agent",
      }),
    });
    const reviewer = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "claim-assignee-reviewer",
        project_id: "claim-assignee-diagnostics",
        name: "Reviewer",
        role: "代码审查 Agent",
      }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({
        board_id: "claim-assignee-diagnostics",
        title: "assigned pending task",
        assignee_agent_id: "claim-assignee-developer",
      }),
    });
    const denied = await call(
      `/api/board/tasks/${task.body.id}/claim`,
      { method: "POST", body: JSON.stringify({ agent_id: "claim-assignee-reviewer" }) },
      String(reviewer.body.token),
    );
    expect(developer.body.token).toBeTruthy();
    expect(denied.response.status).toBe(403);
    expect(denied.body.error).toBe("task is assigned to another agent");
  });

  it("reports unmet dependencies when the dependency is not done", async () => {
    const parent = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "diagnostics parent" }),
    });
    const child = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "diagnostics child" }),
    });
    const dependencies = await call(`/api/board/tasks/${child.body.id}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [parent.body.id] }),
    });
    expect(dependencies.response.status).toBe(200);
    const blocked = await call(
      `/api/board/tasks/${child.body.id}/claim`,
      { method: "POST", body: JSON.stringify({ agent_id: "worker" }) },
    );
    expect(blocked.response.status).toBe(422);
    expect(blocked.body.error).toBe("dependencies are unmet");
  });

  it("persists and normalizes project-oriented task fields", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "projectization-fields", name: "Projectization Fields" }),
    });
    const created = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({
        board_id: "projectization-fields",
        title: "Project task",
        epic: "Launch",
        user_story: "As a user",
        risk: "medium",
        readiness: { problem_clear: true, files_known: true, unexpected: true },
        evidence: { commands: ["npm test", 7], findings: ["green"], residual: "none", extra: "ignored" },
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      epic: "Launch",
      user_story: "As a user",
      risk: "medium",
      readiness: {
        problem_clear: true,
        files_known: true,
        non_goals_clear: false,
      },
      evidence: { commands: ["npm test"], findings: ["green"], residual: "none" },
    });
    const fetched = await call(`/api/board/tasks/${created.body.id}?project=projectization-fields`);
    expect(fetched.body.epic).toBe("Launch");
    expect(fetched.body.user_story).toBe("As a user");
    expect(fetched.body.risk).toBe("medium");
    expect(Object.keys(fetched.body.readiness)).toHaveLength(7);
    expect(fetched.body.evidence).toEqual({
      commands: ["npm test"],
      findings: ["green"],
      residual: "none",
    });
    const patched = await call(`/api/board/tasks/${created.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        epic: "Ship",
        risk: "high",
        readiness: { acceptance_testable: true },
      }),
    });
    expect(patched.response.status).toBe(200);
    expect(patched.body.epic).toBe("Ship");
    expect(patched.body.risk).toBe("high");
    expect(patched.body.readiness.acceptance_testable).toBe(true);
    expect(patched.body.readiness.problem_clear).toBe(false);
  });

  it("rejects invalid project risk values on create and patch", async () => {
    const created = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "Risk validation", risk: "urgent" }),
    });
    expect(created.response.status).toBe(422);
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "Risk patch validation" }),
    });
    const patched = await call(`/api/board/tasks/${task.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ risk: "urgent" }),
    });
    expect(patched.response.status).toBe(422);
    expect(patched.body.error).toBe("invalid risk");
  });

  it("aggregates the project roadmap by epic and user story", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "roadmap-project", name: "Roadmap Project" }),
    });
    const makeTask = (body: Record<string, unknown>) => call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "roadmap-project", title: "Roadmap task", ...body }),
    });
    const first = await makeTask({ epic: "Launch", user_story: "Onboarding" });
    const second = await makeTask({ epic: "Launch", user_story: "Onboarding" });
    await makeTask({ epic: "Launch", user_story: "Billing" });
    await makeTask({ epic: "Ops", user_story: "" });
    await call(`/api/board/tasks/${first.body.id}`, { method: "PATCH", body: JSON.stringify({ phase: "done" }) });
    await call(`/api/board/tasks/${second.body.id}`, { method: "PATCH", body: JSON.stringify({ phase: "done" }) });
    const result = await call("/api/board/roadmap?project=roadmap-project");
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({ total: 4, done: 2, pct: 50 });
    expect(result.body.epics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        epic: "Launch",
        total: 3,
        done: 2,
        pct: 67,
        stories: expect.arrayContaining([
          expect.objectContaining({ name: "Onboarding", total: 2, done: 2, pct: 100 }),
          expect.objectContaining({ name: "Billing", total: 1, done: 0, pct: 0 }),
        ]),
      }),
      expect.objectContaining({
        epic: "Ops",
        stories: [expect.objectContaining({ name: "", total: 1, done: 0, pct: 0 })],
      }),
    ]));
  });

  it("replays idempotent creates", async () => {
    const init = { method: "POST", headers: { "idempotency-key": "same-create" }, body: JSON.stringify({ title: "once" }) };
    const first = await call("/api/board/tasks", init);
    const second = await call("/api/board/tasks", init);
    expect(first.body.id).toBe(second.body.id);
  });

  it("reclaims expired leases without a claim-time sweep", async () => {
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

  it("enforces the role capability matrix and records assessments", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "capability-project", name: "Capability Project" }),
    });
    expect(project.response.status).toBe(201);
    const registrations = await Promise.all([
      ["capability-developer", "开发"],
      ["capability-reviewer", "审查"],
      ["capability-tester", "测试"],
      ["capability-worker", "worker"],
      ["capability-lead", "lead"],
    ].map(([id, role]) => call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id, project_id: "capability-project", name: id, role }),
    })));
    for (const registration of registrations) expect(registration.response.status).toBe(201);
    const [developerToken, reviewerToken, testerToken, workerToken, leadToken] =
      registrations.map((registration) => String(registration.body.token));

    const managementTarget = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "capability-project", title: "Management target" }),
    });
    expect(managementTarget.response.status).toBe(201);
    const targetId = String(managementTarget.body.id);
    await call(`/api/board/tasks/${targetId}`, {
      method: "PATCH",
      body: JSON.stringify({ phase: "in_progress" }),
    });
    const beforeDenied = await call(`/api/board/tasks/${targetId}`, {}, developerToken);

    const deniedManagement = await Promise.all([
      call("/api/board/tasks", {
        method: "POST",
        body: JSON.stringify({ board_id: "capability-project", title: "Denied create" }),
      }, developerToken),
      call(`/api/board/tasks/${targetId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Denied update" }),
      }, developerToken),
      call(`/api/board/tasks/${targetId}`, { method: "DELETE" }, developerToken),
      call(`/api/board/tasks/${targetId}/dependencies`, {
        method: "PUT",
        body: JSON.stringify({ depends_on: [] }),
      }, developerToken),
      call(`/api/board/tasks/${targetId}/review`, {
        method: "POST",
        body: JSON.stringify({ decision: "pass", note: "not allowed" }),
      }, developerToken),
      call(`/api/board/tasks/${targetId}/verify`, {
        method: "POST",
        body: JSON.stringify({ decision: "pass", note: "not allowed" }),
      }, developerToken),
    ]);
    expect(deniedManagement.map((result) => result.response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    const afterDenied = await call(`/api/board/tasks/${targetId}`, {}, developerToken);
    expect(afterDenied.body.title).toBe(beforeDenied.body.title);
    expect(afterDenied.body.deleted_at).toBe(beforeDenied.body.deleted_at);
    expect(afterDenied.body.review_status).toBeNull();
    expect(afterDenied.body.verify_status).toBeNull();

    const leadCreated = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "capability-project", title: "Lead-managed task" }),
    }, leadToken);
    expect(leadCreated.response.status).toBe(201);
    const leadTaskId = String(leadCreated.body.id);
    const leadUpdated = await call(`/api/board/tasks/${leadTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "managed by lead" }),
    }, leadToken);
    expect(leadUpdated.response.status).toBe(200);
    const leadDependencies = await call(`/api/board/tasks/${leadTaskId}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [targetId] }),
    }, leadToken);
    expect(leadDependencies.response.status).toBe(200);
    const adminCreated = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "capability-project", title: "Admin-managed task" }),
    });
    expect(adminCreated.response.status).toBe(201);

    const reviewPass = await call(`/api/board/tasks/${targetId}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "pass", note: "looks good" }),
    }, reviewerToken);
    expect(reviewPass.response.status).toBe(200);
    expect(reviewPass.body.review_status).toBe("pass");
    expect(reviewPass.body.review_agent_id).toBe("capability-reviewer");
    const reviewReject = await call(`/api/board/tasks/${targetId}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "reject", note: "needs changes" }),
    }, reviewerToken);
    expect(reviewReject.response.status).toBe(200);
    expect(reviewReject.body.review_status).toBe("reject");
    expect(reviewReject.body.review_note).toBe("needs changes");

    const verifyTask = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "capability-project", title: "Verification target" }),
    });
    const verifyTaskId = String(verifyTask.body.id);
    await call(`/api/board/tasks/${verifyTaskId}`, {
      method: "PATCH",
      body: JSON.stringify({ phase: "in_progress" }),
    });
    const verifyResult = await call(`/api/board/tasks/${verifyTaskId}/verify`, {
      method: "POST",
      body: JSON.stringify({ decision: "pass", note: "tests pass" }),
    }, testerToken);
    expect(verifyResult.response.status).toBe(200);
    expect(verifyResult.body.verify_status).toBe("pass");
    expect(verifyResult.body.verify_agent_id).toBe("capability-tester");

    const workerTask = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "capability-project", title: "Worker task" }),
    });
    const workerTaskId = String(workerTask.body.id);
    const workerClaim = await call(`/api/board/tasks/${workerTaskId}/claim`, { method: "POST" }, workerToken);
    expect(workerClaim.response.status).toBe(200);
    const workerComplete = await call(`/api/board/tasks/${workerTaskId}/complete`, { method: "POST" }, workerToken);
    expect(workerComplete.response.status).toBe(200);

    const events = await call(`/api/board/tasks/${targetId}/events`);
    expect(events.body.events.some((event: { event_type: string; actor_agent_id: string }) =>
      event.event_type === "reviewed" && event.actor_agent_id === "capability-reviewer")).toBe(true);
  });

  it("delivers direct and broadcast mailbox messages with durable recipient state", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "mailbox-project", name: "Mailbox Project" }),
    });
    const otherProject = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "mailbox-other", name: "Mailbox Other" }),
    });
    expect(project.response.status).toBe(201);
    expect(otherProject.response.status).toBe(201);
    const registrations = await Promise.all([
      ["mailbox-alice", "worker"],
      ["mailbox-bob", "worker"],
      ["mailbox-carol", "worker"],
      ["mailbox-lead", "lead"],
      ["mailbox-other-agent", "worker"],
    ].map(([id, role], index) => call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({
        id,
        project_id: index === 4 ? "mailbox-other" : "mailbox-project",
        name: id,
        role,
      }),
    })));
    for (const registration of registrations) expect(registration.response.status).toBe(201);
    const [aliceToken, bobToken, carolToken, leadToken, otherToken] =
      registrations.map((registration) => String(registration.body.token));

    const direct = await call("/api/mailbox/messages", {
      method: "POST",
      body: JSON.stringify({
        to: ["mailbox-bob"],
        subject: "Direct",
        body: { text: "hello Bob" },
      }),
    }, aliceToken);
    expect(direct.response.status).toBe(201);
    expect(direct.body.message.kind).toBe("direct");
    expect(direct.body.deliveries).toHaveLength(1);
    const directMessageId = String(direct.body.message.id);
    const directDeliveryId = String(direct.body.deliveries[0].id);
    const blankKeyA = await call("/api/mailbox/messages", {
      method: "POST",
      body: JSON.stringify({ to: ["mailbox-carol"], body: "blank key" }),
    }, aliceToken);
    const blankKeyB = await call("/api/mailbox/messages", {
      method: "POST",
      body: JSON.stringify({ to: ["mailbox-carol"], body: "blank key" }),
    }, aliceToken);
    expect(blankKeyA.body.message.id).not.toBe(blankKeyB.body.message.id);
    const aliceInbox = await call("/api/mailbox/inbox", {}, aliceToken);
    const bobInbox = await call("/api/mailbox/inbox", {}, bobToken);
    const carolInbox = await call("/api/mailbox/inbox", {}, carolToken);
    expect(aliceInbox.body.deliveries.some((delivery: { message_id: string }) => delivery.message_id === directMessageId)).toBe(false);
    expect(bobInbox.body.deliveries.some((delivery: { message_id: string }) => delivery.message_id === directMessageId)).toBe(true);
    expect(carolInbox.body.deliveries.some((delivery: { message_id: string }) => delivery.message_id === directMessageId)).toBe(false);

    const seen = await call(`/api/mailbox/deliveries/${directDeliveryId}/seen`, { method: "POST" }, bobToken);
    expect(seen.response.status).toBe(200);
    expect(seen.body.delivery.status).toBe("seen");
    const seenAgain = await call(`/api/mailbox/deliveries/${directDeliveryId}/seen`, { method: "POST" }, bobToken);
    expect(seenAgain.response.status).toBe(200);
    expect(seenAgain.body.idempotent).toBe(true);
    const acked = await call(`/api/mailbox/deliveries/${directDeliveryId}/ack`, { method: "POST" }, bobToken);
    expect(acked.response.status).toBe(200);
    expect(acked.body.delivery.status).toBe("acked");

    const broadcast = await call("/api/mailbox/messages", {
      method: "POST",
      body: JSON.stringify({ to: "broadcast", subject: "Broadcast", payload: { text: "hello team" } }),
    }, aliceToken);
    expect(broadcast.response.status).toBe(201);
    expect(broadcast.body.message.kind).toBe("broadcast");
    expect(broadcast.body.deliveries.map((delivery: { recipient_agent_id: string }) => delivery.recipient_agent_id))
      .toEqual(["mailbox-bob", "mailbox-carol", "mailbox-lead"]);

    const deadMessage = await call("/api/mailbox/messages", {
      method: "POST",
      body: JSON.stringify({ to: ["mailbox-bob"], body: "retry me" }),
    }, aliceToken);
    const deadDeliveryId = String(deadMessage.body.deliveries[0].id);
    const nack1 = await call(`/api/mailbox/deliveries/${deadDeliveryId}/nack`, { method: "POST" }, bobToken);
    const nack2 = await call(`/api/mailbox/deliveries/${deadDeliveryId}/nack`, { method: "POST" }, bobToken);
    const nack3 = await call(`/api/mailbox/deliveries/${deadDeliveryId}/nack`, { method: "POST" }, bobToken);
    expect(nack1.body.delivery.status).toBe("unread");
    expect(nack2.body.delivery.status).toBe("unread");
    expect(nack3.body.delivery.status).toBe("dead");
    const deadletter = await call("/api/mailbox/deadletter", {}, leadToken);
    expect(deadletter.body.deliveries.some((delivery: { id: string }) => delivery.id === deadDeliveryId)).toBe(true);

    const idempotencyBefore = await env.DB.prepare("SELECT COUNT(*) AS count FROM message WHERE project_id = ?")
      .bind("mailbox-project").first<{ count: number }>();
    const idempotentInit = {
      method: "POST",
      headers: { "idempotency-key": "mailbox-same-message" },
      body: JSON.stringify({ to: ["mailbox-carol"], body: "once" }),
    };
    const idempotentFirst = await call("/api/mailbox/messages", idempotentInit, aliceToken);
    const idempotentSecond = await call("/api/mailbox/messages", idempotentInit, aliceToken);
    expect(idempotentFirst.body.message.id).toBe(idempotentSecond.body.message.id);
    const idempotencyAfter = await env.DB.prepare("SELECT COUNT(*) AS count FROM message WHERE project_id = ?")
      .bind("mailbox-project").first<{ count: number }>();
    expect(Number(idempotencyAfter?.count) - Number(idempotencyBefore?.count)).toBe(1);
    await env.DB.prepare("DELETE FROM idempotency_key WHERE scope = ? AND key = ?")
      .bind("mailbox:send:mailbox-project", "mailbox-same-message").run();
    const mailboxAfterCleanup = await call("/api/mailbox/messages", idempotentInit, aliceToken);
    expect(mailboxAfterCleanup.body.message.id).toBe(idempotentFirst.body.message.id);
    const mailboxMessageCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM message WHERE project_id = ? AND idempotency_key = ?",
    ).bind("mailbox-project", "mailbox-same-message").first<{ count: number }>();
    expect(Number(mailboxMessageCount?.count)).toBe(1);

    const reply = await call("/api/mailbox/messages", {
      method: "POST",
      body: JSON.stringify({ to: ["mailbox-alice"], reply_to: directMessageId, body: "reply" }),
    }, bobToken);
    expect(reply.response.status).toBe(201);
    expect(reply.body.message.reply_to).toBe(directMessageId);
    const sent = await call("/api/mailbox/sent", {}, aliceToken);
    expect(sent.body.messages.some((message: { id: string }) => message.id === directMessageId)).toBe(true);
    const viewed = await call(`/api/mailbox/messages/${directMessageId}`, {}, bobToken);
    expect(viewed.response.status).toBe(200);
    expect(viewed.body.message.id).toBe(directMessageId);

    const crossSend = await call("/api/mailbox/messages", {
      method: "POST",
      body: JSON.stringify({ to: ["mailbox-other-agent"], body: "cross-project" }),
    }, aliceToken);
    expect(crossSend.response.status).toBe(403);
    const otherMessage = await call("/api/mailbox/messages", {
      method: "POST",
      body: JSON.stringify({ project_id: "mailbox-other", to: ["mailbox-other-agent"], body: "private" }),
    });
    const crossRead = await call(`/api/mailbox/messages/${otherMessage.body.message.id}`, {}, aliceToken);
    expect(crossRead.response.status).toBe(403);
    const crossRows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM message WHERE project_id = ? AND payload_json = ?",
    ).bind("mailbox-project", JSON.stringify("cross-project")).first<{ count: number }>();
    expect(Number(crossRows?.count)).toBe(0);
    void otherToken;
  });

  it("enforces opt-in plan approval and three-layer acceptance before dependency unlock", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "phase3-project", name: "Phase 3 Project" }),
    });
    expect(project.response.status).toBe(201);
    const developer = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "phase3-developer", project_id: "phase3-project", name: "Developer", role: "开发" }),
    });
    const lead = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "phase3-lead", project_id: "phase3-project", name: "Lead", role: "编排" }),
    });
    expect(developer.response.status).toBe(201);
    expect(lead.response.status).toBe(201);
    const developerToken = String(developer.body.token);
    const leadToken = String(lead.body.token);

    const planTask = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "phase3-project", title: "Plan-gated", require_plan: true }),
    });
    const planChild = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "phase3-project", title: "Plan child" }),
    });
    await call(`/api/board/tasks/${planChild.body.id}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [planTask.body.id] }),
    });
    const planTaskId = String(planTask.body.id);
    const planChildId = String(planChild.body.id);
    expect((await call(`/api/board/tasks/${planTaskId}/claim`, { method: "POST" }, developerToken)).response.status).toBe(200);
    const blockedComplete = await call(`/api/board/tasks/${planTaskId}/complete`, { method: "POST" }, developerToken);
    expect(blockedComplete.response.status).toBe(409);
    const stillClaimed = await call(`/api/board/tasks/${planTaskId}`, {}, developerToken);
    expect(stillClaimed.body.phase).toBe("in_progress");
    expect(stillClaimed.body.lease_owner).toBe("phase3-developer");

    const deniedPlanReview = await call(`/api/board/tasks/${planTaskId}/plan-review`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    }, developerToken);
    expect(deniedPlanReview.response.status).toBe(403);
    expect((await call(`/api/board/tasks/${planTaskId}`, {}, developerToken)).body.plan_status).toBeNull();

    const submitted = await call(`/api/board/tasks/${planTaskId}/plan`, {
      method: "POST",
      body: JSON.stringify({ plan: "Implement and test the change." }),
    }, developerToken);
    expect(submitted.response.status).toBe(200);
    expect(submitted.body.plan_status).toBe("submitted");
    const rejected = await call(`/api/board/tasks/${planTaskId}/plan-review`, {
      method: "POST",
      body: JSON.stringify({ decision: "reject", note: "Add test coverage." }),
    }, leadToken);
    expect(rejected.response.status).toBe(200);
    expect(rejected.body.plan_status).toBe("rejected");
    const resubmitted = await call(`/api/board/tasks/${planTaskId}/plan`, {
      method: "POST",
      body: JSON.stringify({ plan: "Implement, test, and document the change." }),
    }, developerToken);
    expect(resubmitted.response.status).toBe(200);
    const approved = await call(`/api/board/tasks/${planTaskId}/plan-review`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", note: "Approved." }),
    }, leadToken);
    expect(approved.response.status).toBe(200);
    expect(approved.body.plan_status).toBe("approved");
    const completed = await call(`/api/board/tasks/${planTaskId}/complete`, { method: "POST" }, developerToken);
    expect(completed.response.status).toBe(200);
    expect(completed.body.phase).toBe("done");
    expect((await call(`/api/board/tasks/${planChildId}/claim`, { method: "POST" }, developerToken)).response.status).toBe(200);

    const acceptanceTask = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "phase3-project", title: "Acceptance-gated", require_acceptance: true }),
    });
    const acceptanceChild = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "phase3-project", title: "Acceptance child" }),
    });
    await call(`/api/board/tasks/${acceptanceChild.body.id}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [acceptanceTask.body.id] }),
    });
    const acceptanceTaskId = String(acceptanceTask.body.id);
    const acceptanceChildId = String(acceptanceChild.body.id);
    expect((await call(`/api/board/tasks/${acceptanceTaskId}/claim`, { method: "POST" }, developerToken)).response.status).toBe(200);
    const submittedCompletion = await call(`/api/board/tasks/${acceptanceTaskId}/complete`, { method: "POST", body: JSON.stringify({ result: "self-reported" }) }, developerToken);
    expect(submittedCompletion.response.status).toBe(200);
    expect(submittedCompletion.body.phase).toBe("in_progress");
    expect(submittedCompletion.body.acceptance_status).toBe("submitted");
    expect((await call(`/api/board/tasks/${acceptanceChildId}/claim`, { method: "POST" }, developerToken)).response.status).toBe(422);

    const deniedAcceptance = await call(`/api/board/tasks/${acceptanceTaskId}/acceptance`, {
      method: "POST",
      body: JSON.stringify({ decision: "accept" }),
    }, developerToken);
    expect(deniedAcceptance.response.status).toBe(403);
    const unchanged = await call(`/api/board/tasks/${acceptanceTaskId}`, {}, developerToken);
    expect(unchanged.body.phase).toBe("in_progress");
    expect(unchanged.body.acceptance_status).toBe("submitted");

    const rejectedAcceptance = await call(`/api/board/tasks/${acceptanceTaskId}/acceptance`, {
      method: "POST",
      body: JSON.stringify({ decision: "reject", note: "Please revise." }),
    }, leadToken);
    expect(rejectedAcceptance.response.status).toBe(200);
    expect(rejectedAcceptance.body.phase).toBe("in_progress");
    expect(rejectedAcceptance.body.acceptance_status).toBe("rejected");
    expect((await call(`/api/board/tasks/${acceptanceTaskId}/claim`, { method: "POST" }, developerToken)).response.status).toBe(200);
    expect((await call(`/api/board/tasks/${acceptanceTaskId}/complete`, { method: "POST" }, developerToken)).response.status).toBe(200);
    const accepted = await call(`/api/board/tasks/${acceptanceTaskId}/acceptance`, {
      method: "POST",
      body: JSON.stringify({ decision: "accept", note: "Accepted." }),
    }, leadToken);
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.phase).toBe("done");
    expect(accepted.body.acceptance_status).toBe("accepted");
    expect((await call(`/api/board/tasks/${acceptanceChildId}/claim`, { method: "POST" }, developerToken)).response.status).toBe(200);
  });

  it("supports agent lifecycle, quality gates, and isolated hook delivery", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "phase4-project", name: "Phase 4 Project" }),
    });
    expect(project.response.status).toBe(201);
    const developer = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "phase4-developer", project_id: "phase4-project", name: "Developer", role: "开发" }),
    });
    const tester = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "phase4-tester", project_id: "phase4-project", name: "Tester", role: "测试" }),
    });
    const lead = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "phase4-lead", project_id: "phase4-project", name: "Lead", role: "编排" }),
    });
    const developerToken = String(developer.body.token);
    const testerToken = String(tester.body.token);
    const leadToken = String(lead.body.token);

    const lifecycleTask = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "phase4-project", title: "Lifecycle task" }),
    });
    const lifecycleTaskId = String(lifecycleTask.body.id);
    expect((await call(`/api/board/tasks/${lifecycleTaskId}/claim`, { method: "POST" }, developerToken)).response.status).toBe(200);
    expect((await call("/api/board/agents/phase4-developer/idle", { method: "POST" }, developerToken)).response.status).toBe(200);
    const deniedLifecycle = await call("/api/board/agents/phase4-tester/shutdown", { method: "POST" }, developerToken);
    expect(deniedLifecycle.response.status).toBe(403);
    const shutdown = await call("/api/board/agents/phase4-developer/shutdown", { method: "POST" }, developerToken);
    expect(shutdown.response.status).toBe(200);
    expect(shutdown.body.released_leases).toBe(1);
    expect((await call(`/api/board/tasks/${lifecycleTaskId}/claim`, { method: "POST" }, testerToken)).response.status).toBe(200);
    expect((await call("/api/board/agents/phase4-tester/shutdown", { method: "POST" }, leadToken)).response.status).toBe(200);

    const hookDenied = await call("/api/board/hooks", {
      method: "POST",
      body: JSON.stringify({ project_id: "phase4-project", event_type: "gate_passed", url: "https://example.com/hook", secret: "local-secret" }),
    }, developerToken);
    expect(hookDenied.response.status).toBe(403);
    const hook = await call("/api/board/hooks", {
      method: "POST",
      body: JSON.stringify({ project_id: "phase4-project", event_type: "gate_passed", url: "https://example.com/hook", secret: "local-secret" }),
    }, leadToken);
    expect(hook.response.status).toBe(201);
    expect((await call(`/api/board/hooks/${hook.body.id}`, { method: "DELETE" }, leadToken)).response.status).toBe(200);
    const hookAgain = await call("/api/board/hooks", {
      method: "POST",
      body: JSON.stringify({ project_id: "phase4-project", event_type: "gate_passed", url: "https://example.com/hook", secret: "local-secret" }),
    }, leadToken);
    expect(hookAgain.response.status).toBe(201);

    const gated = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "phase4-project", title: "Quality gated", required_gates: ["tests"] }),
    });
    const gatedId = String(gated.body.id);
    expect((await call(`/api/board/tasks/${gatedId}/claim`, { method: "POST" }, developerToken)).response.status).toBe(200);
    const blocked = await call(`/api/board/tasks/${gatedId}/complete`, { method: "POST" }, developerToken);
    expect(blocked.response.status).toBe(409);
    const deniedGate = await call(`/api/board/tasks/${gatedId}/gate`, {
      method: "POST",
      body: JSON.stringify({ gate: "tests", decision: "pass" }),
    }, developerToken);
    expect(deniedGate.response.status).toBe(403);
    const unchangedGate = await env.DB.prepare("SELECT status FROM task_gate WHERE task_id = ?").bind(gatedId).first<{ status: string }>();
    expect(unchangedGate).toBeNull();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const passed = await call(`/api/board/tasks/${gatedId}/gate`, {
      method: "POST",
      body: JSON.stringify({ gate: "tests", decision: "pass", note: "All tests pass." }),
    }, testerToken);
    expect(passed.response.status).toBe(200);
    expect((await call(`/api/board/tasks/${gatedId}/complete`, { method: "POST" }, developerToken)).response.status).toBe(200);
    await worker.scheduled({} as ScheduledEvent, env);
    expect(fetchSpy).toHaveBeenCalled();
    const hookCall = fetchSpy.mock.calls[0];
    expect(hookCall).toBeTruthy();
    const headers = hookCall?.[0] instanceof Request ? hookCall[0].headers : (hookCall?.[1] as RequestInit | undefined)?.headers;
    expect(new Headers(headers).get("x-coord-board-signature")).toMatch(/^sha256=/);
    fetchSpy.mockRestore();
  });

  it("persists hook deliveries, retries failures, and dead-letters exhausted hooks", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "hook-outbox-project", name: "Hook Outbox" }),
    });
    expect(project.response.status).toBe(201);
    const hook = await call("/api/board/hooks", {
      method: "POST",
      body: JSON.stringify({
        project_id: "hook-outbox-project",
        event_type: "task_claimed",
        url: "https://example.com/retry-hook",
        secret: "outbox-secret",
      }),
    });
    expect(hook.response.status).toBe(201);
    const agent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "hook-outbox-agent", project_id: "hook-outbox-project", name: "Worker", role: "worker" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "hook-outbox-project", title: "Hook retry task" }),
    });
    const failingFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("destination unavailable"));
    expect((await call(`/api/board/tasks/${task.body.id}/claim`, { method: "POST" }, String(agent.body.token))).response.status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM hook_delivery WHERE hook_id = ? AND event_type = 'task_claimed'").bind(hook.body.id).first()).toBeTruthy();
    await worker.scheduled({} as ScheduledEvent, env);
    let delivery = await env.DB.prepare(
      "SELECT status, attempt_count, next_attempt_at, payload_json, last_error FROM hook_delivery WHERE hook_id = ?",
    ).bind(hook.body.id).first<Record<string, unknown>>();
    expect(delivery?.status).toBe("pending");
    expect(Number(delivery?.attempt_count)).toBe(1);
    expect(JSON.stringify(delivery)).not.toContain("outbox-secret");
    for (let attempt = 0; attempt < 4; attempt++) {
      await env.DB.prepare("UPDATE hook_delivery SET next_attempt_at = ? WHERE hook_id = ?")
        .bind("2000-01-01T00:00:00.000Z", hook.body.id).run();
      await worker.scheduled({} as ScheduledEvent, env);
    }
    delivery = await env.DB.prepare(
      "SELECT status, attempt_count FROM hook_delivery WHERE hook_id = ?",
    ).bind(hook.body.id).first<Record<string, unknown>>();
    expect(delivery?.status).toBe("dead");
    expect(Number(delivery?.attempt_count)).toBe(5);
    const deadView = await call("/api/board/hook-deliveries?project=hook-outbox-project&status=dead");
    expect(deadView.response.status).toBe(200);
    expect(JSON.stringify(deadView.body)).not.toContain("outbox-secret");
    failingFetch.mockRestore();

    const successHook = await call("/api/board/hooks", {
      method: "POST",
      body: JSON.stringify({
        project_id: "hook-outbox-project",
        event_type: "task_completed",
        url: "https://example.com/success-hook",
        secret: "success-secret",
      }),
    });
    const successFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const successTask = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "hook-outbox-project", title: "Hook success task" }),
    });
    expect((await call(`/api/board/tasks/${successTask.body.id}/claim`, { method: "POST" }, String(agent.body.token))).response.status).toBe(200);
    expect((await call(`/api/board/tasks/${successTask.body.id}/complete`, { method: "POST" }, String(agent.body.token))).response.status).toBe(200);
    await worker.scheduled({} as ScheduledEvent, env);
    const successDelivery = await env.DB.prepare(
      "SELECT status FROM hook_delivery WHERE hook_id = ?",
    ).bind(successHook.body.id).first<{ status: string }>();
    expect(successDelivery?.status).toBe("delivered");
    const callsAfterSuccess = successFetch.mock.calls.length;
    await worker.scheduled({} as ScheduledEvent, env);
    expect(successFetch.mock.calls.length).toBe(callsAfterSuccess);
    successFetch.mockRestore();
  });

  it("prevents overlapping hook cron runs from posting twice and recovers stale deliveries", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "hook-hardening-project", name: "Hook Hardening" }),
    });
    expect(project.response.status).toBe(201);
    const hook = await call("/api/board/hooks", {
      method: "POST",
      body: JSON.stringify({
        project_id: "hook-hardening-project",
        event_type: "task_claimed",
        url: "https://example.com/hardening-hook",
      }),
    });
    const agent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "hook-hardening-agent", project_id: "hook-hardening-project", name: "Worker", role: "worker" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "hook-hardening-project", title: "Overlap task" }),
    });
    expect((await call(`/api/board/tasks/${task.body.id}/claim`, { method: "POST" }, String(agent.body.token))).response.status).toBe(200);
    let resolveFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { resolveFetch = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await fetchGate;
      return new Response("ok");
    });
    const first = worker.scheduled({} as ScheduledEvent, env);
    await Promise.resolve();
    const second = worker.scheduled({} as ScheduledEvent, env);
    await Promise.resolve();
    resolveFetch();
    await Promise.all([first, second]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare("SELECT status FROM hook_delivery WHERE hook_id = ?").bind(hook.body.id).first<{ status: string }>())?.status).toBe("delivered");
    fetchSpy.mockRestore();

    await env.DB.prepare(
      `INSERT INTO hook_delivery
       (id, hook_id, project_id, event_type, phase, payload_json, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, 'task_claimed', 'post', '{}', 'delivering', 0, ?, ?, ?)`,
    ).bind("stale-hook-delivery", hook.body.id, "hook-hardening-project", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z").run();
    const recoveryFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await worker.scheduled({} as ScheduledEvent, env);
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare("SELECT status FROM hook_delivery WHERE id = ?").bind("stale-hook-delivery").first<{ status: string }>())?.status).toBe("delivered");
    recoveryFetch.mockRestore();
  });

  it("cleans retained hook deliveries and expired share tokens during scheduled sweeps", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "cleanup-project", name: "Cleanup" }),
    });
    expect(project.response.status).toBe(201);
    const hook = await call("/api/board/hooks", {
      method: "POST",
      body: JSON.stringify({ project_id: "cleanup-project", event_type: "task_claimed", url: "https://example.com/cleanup" }),
    });
    await env.DB.prepare(
      `INSERT INTO hook_delivery
       (id, hook_id, project_id, event_type, phase, payload_json, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, 'task_claimed', 'post', '{}', ?, 1, ?, ?, ?)`,
    ).bind("old-delivered", hook.body.id, "cleanup-project", "delivered", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z").run();
    await env.DB.prepare(
      `INSERT INTO hook_delivery
       (id, hook_id, project_id, event_type, phase, payload_json, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, 'task_claimed', 'post', '{}', 'pending', 0, ?, ?, ?)`,
    ).bind("keep-pending", hook.body.id, "cleanup-project", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z").run();
    const issued = await call("/api/board/share-token", {
      method: "POST",
      body: JSON.stringify({ project_id: "cleanup-project", ttl_seconds: 3600 }),
    });
    await env.DB.prepare("UPDATE share_token SET expires_at = ? WHERE token_hash = ?")
      .bind("2000-01-01T00:00:00.000Z", await sha256ForTest(String(issued.body.token))).run();
    await worker.scheduled({} as ScheduledEvent, env);
    expect(await env.DB.prepare("SELECT id FROM hook_delivery WHERE id = ?").bind("old-delivered").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM hook_delivery WHERE id = ?").bind("keep-pending").first()).toBeTruthy();
    expect(await env.DB.prepare("SELECT token_hash FROM share_token WHERE token_hash = ?").bind(await sha256ForTest(String(issued.body.token))).first()).toBeNull();
  });

  it("paginates mailbox inbox and sent messages with project isolation", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "mailbox-page-project", name: "Mailbox Pages" }),
    });
    expect(project.response.status).toBe(201);
    const sender = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "mailbox-page-sender", project_id: "mailbox-page-project", name: "Sender", role: "worker" }),
    });
    const recipient = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "mailbox-page-recipient", project_id: "mailbox-page-project", name: "Recipient", role: "worker" }),
    });
    for (let index = 0; index < 3; index++) {
      const sent = await call("/api/mailbox/messages", {
        method: "POST",
        body: JSON.stringify({ to: ["mailbox-page-recipient"], body: `page-${index}` }),
      }, String(sender.body.token));
      expect(sent.response.status).toBe(201);
    }
    const sentPage = await call("/api/mailbox/sent?project_id=mailbox-page-project&limit=2", {}, String(sender.body.token));
    expect(sentPage.response.status).toBe(200);
    expect(sentPage.body.messages).toHaveLength(2);
    expect(typeof sentPage.body.next_cursor).toBe("string");
    const sentNext = await call(`/api/mailbox/sent?project_id=mailbox-page-project&limit=2&cursor=${encodeURIComponent(sentPage.body.next_cursor)}`, {}, String(sender.body.token));
    expect(sentNext.body.messages).toHaveLength(1);
    expect(sentNext.body.next_cursor).toBeNull();
    const tampered = `${sentPage.body.next_cursor.slice(0, -1)}${sentPage.body.next_cursor.endsWith("a") ? "b" : "a"}`;
    expect((await call(`/api/mailbox/sent?project_id=mailbox-page-project&limit=2&cursor=${encodeURIComponent(tampered)}`, {}, String(sender.body.token))).response.status).toBe(400);
    expect((await call(`/api/mailbox/inbox?limit=2&cursor=${encodeURIComponent(sentPage.body.next_cursor)}`, {}, String(sender.body.token))).response.status).toBe(400);
    expect((await call(`/api/mailbox/sent?project_id=default&limit=2&cursor=${encodeURIComponent(sentPage.body.next_cursor)}`)).response.status).toBe(400);

    const inboxPage = await call("/api/mailbox/inbox?limit=1", {}, String(recipient.body.token));
    expect(inboxPage.response.status).toBe(200);
    expect(inboxPage.body.deliveries).toHaveLength(1);
    expect(inboxPage.body.next_cursor).toBeTruthy();
    const clamped = await call("/api/mailbox/inbox?limit=999", {}, String(recipient.body.token));
    expect(clamped.response.status).toBe(200);
    expect(clamped.body.deliveries.length).toBeLessThanOrEqual(200);
    const denied = await call("/api/mailbox/sent?project_id=default", {}, String(sender.body.token));
    expect(denied.response.status).toBe(403);
  });

  it("blocks toxic tasks after repeated attempts, notifies leaders, and supports reset", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "toxic-task-project", name: "Toxic Tasks" }),
    });
    expect(project.response.status).toBe(201);
    const developer = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "toxic-developer", project_id: "toxic-task-project", name: "Developer", role: "开发" }),
    });
    const leader = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "toxic-leader", project_id: "toxic-task-project", name: "Leader", role: "编排" }),
    });
    const normal = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "toxic-task-project", title: "Normal retry" }),
    });
    await env.DB.prepare("UPDATE task_item SET attempt_count = 4 WHERE id = ?").bind(normal.body.id).run();
    const normalClaim = await call(`/api/board/tasks/${normal.body.id}/claim`, { method: "POST" }, String(developer.body.token));
    expect(normalClaim.response.status).toBe(200);
    expect(normalClaim.body.attempt_count).toBe(5);

    const toxic = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "toxic-task-project", title: "Poison task" }),
    });
    await env.DB.prepare("UPDATE task_item SET attempt_count = 5 WHERE id = ?").bind(toxic.body.id).run();
    const blocked = await call(`/api/board/tasks/${toxic.body.id}/claim`, { method: "POST" }, String(developer.body.token));
    expect(blocked.response.status).toBe(423);
    expect(blocked.body.task.blocked).toBe(1);
    expect((await call(`/api/board/tasks/${toxic.body.id}`, {}, String(developer.body.token))).body.lease_owner).toBeNull();
    const inbox = await call("/api/mailbox/inbox", {}, String(leader.body.token));
    expect(inbox.body.deliveries.some((delivery: { subject: string }) => delivery.subject === "疑似毒任务已熔断")).toBe(true);

    const reset = await call(`/api/board/tasks/${toxic.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ phase: "pending", attempt_count: 0 }),
    }, String(leader.body.token));
    expect(reset.response.status).toBe(200);
    expect(reset.body.blocked).toBe(0);
    const reclaimed = await call(`/api/board/tasks/${toxic.body.id}/claim`, { method: "POST" }, String(developer.body.token));
    expect(reclaimed.response.status).toBe(200);
  });

  it("aggregates an isolated team snapshot and protects leader controls", async () => {
    const projectA = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "team-project-a", name: "Team A" }),
    });
    const projectB = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "team-project-b", name: "Team B" }),
    });
    expect(projectA.response.status).toBe(201);
    expect(projectB.response.status).toBe(201);
    const developer = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "team-developer", project_id: "team-project-a", name: "Developer", role: "开发" }),
    });
    const teammate = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "team-teammate", project_id: "team-project-a", name: "Teammate", role: "开发" }),
    });
    const lead = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "team-lead", project_id: "team-project-a", name: "Lead", role: "编排" }),
    });
    const other = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "team-other", project_id: "team-project-b", name: "Other", role: "开发" }),
    });
    const developerToken = String(developer.body.token);
    const teammateToken = String(teammate.body.token);
    const leadToken = String(lead.body.token);
    const otherToken = String(other.body.token);
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "team-project-a", title: "Team task", required_gates: ["tests"] }),
    });
    const taskId = String(task.body.id);
    expect((await call(`/api/board/tasks/${taskId}/claim`, { method: "POST" }, developerToken)).response.status).toBe(200);
    const otherTask = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "team-project-b", title: "Other task" }),
    });
    const blockedUpstream = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "team-project-a", title: "Blocked upstream" }),
    });
    const blockedDownstream = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "team-project-a", title: "Blocked downstream" }),
    });
    await env.DB.prepare("UPDATE task_item SET blocked = 1 WHERE id = ?").bind(blockedUpstream.body.id).run();
    expect((await call(`/api/board/tasks/${blockedDownstream.body.id}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [blockedUpstream.body.id] }),
    }, leadToken)).response.status).toBe(200);
    const snapshot = await call("/api/board/team", {}, developerToken);
    expect(snapshot.response.status).toBe(200);
    expect(snapshot.body.project.id).toBe("team-project-a");
    expect(snapshot.body.agents.map((agent: any) => agent.id)).toEqual(expect.arrayContaining(["team-developer", "team-teammate", "team-lead"]));
    expect(snapshot.body.agents.find((agent: any) => agent.id === "team-developer").current_task.id).toBe(taskId);
    expect(snapshot.body.tasks.find((item: any) => item.id === taskId).required_gates).toEqual(["tests"]);
    expect(snapshot.body.tasks.find((item: any) => item.id === String(otherTask.body.id))).toBeUndefined();
    expect(snapshot.body.blocked_task_count).toBe(1);
    expect(snapshot.body.blocked_tasks.map((item: any) => item.id)).toContain(String(blockedUpstream.body.id));
    expect(snapshot.body.blocked_dependency_count).toBe(1);
    expect(snapshot.body.blocked_dependency_tasks[0].blocked_upstream_task_ids).toEqual([String(blockedUpstream.body.id)]);
    expect((await call("/api/board/team?project=team-project-b", {}, developerToken)).response.status).toBe(403);
    expect((await call(`/api/board/team?project=team-project-a`, {}, "test-token")).response.status).toBe(200);

    const deniedReassign = await call(`/api/board/tasks/${taskId}/reassign`, {
      method: "POST",
      body: JSON.stringify({ assignee_agent_id: "team-teammate" }),
    }, developerToken);
    expect(deniedReassign.response.status).toBe(403);
    const unchanged = await call(`/api/board/tasks/${taskId}`, {}, developerToken);
    expect(unchanged.body.assignee_agent_id).toBeNull();
    const reassigned = await call(`/api/board/tasks/${taskId}/reassign`, {
      method: "POST",
      body: JSON.stringify({ assignee_agent_id: "team-teammate" }),
    }, leadToken);
    expect(reassigned.response.status).toBe(200);
    expect(reassigned.body.assignee_agent_id).toBe("team-teammate");
    expect(reassigned.body.phase).toBe("ready");
    expect(reassigned.body.lease_owner).toBeNull();

    const releasable = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "team-project-a", title: "Release task" }),
    });
    const releasableId = String(releasable.body.id);
    expect((await call(`/api/board/tasks/${releasableId}/claim`, { method: "POST" }, teammateToken)).response.status).toBe(200);
    const deniedRelease = await call(`/api/board/tasks/${releasableId}/release`, {
      method: "POST",
      body: JSON.stringify({ agent_id: "team-teammate" }),
    }, developerToken);
    expect(deniedRelease.response.status).toBe(403);
    expect((await call(`/api/board/tasks/${releasableId}`, {}, developerToken)).body.lease_owner).toBe("team-teammate");
    const forcedRelease = await call(`/api/board/tasks/${releasableId}/release`, {
      method: "POST",
      body: JSON.stringify({ agent_id: "team-teammate" }),
    }, leadToken);
    expect(forcedRelease.response.status).toBe(200);
    expect((await call(`/api/board/tasks/${releasableId}`, {}, developerToken)).body.lease_owner).toBeNull();
    expect((await call(`/api/board/team?project=team-project-b`, {}, otherToken)).response.status).toBe(200);
  });

  it("includes project fields in the team snapshot task projection", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "team-project-fields", name: "Team Project Fields" }),
    });
    const created = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({
        board_id: "team-project-fields",
        title: "Projectized team task",
        epic: "Launch",
        user_story: "As a lead",
        risk: "high",
        readiness: {
          problem_clear: true,
          files_known: true,
          verification_contract: true,
        },
      }),
    });
    expect(created.response.status).toBe(201);
    const snapshot = await call("/api/board/team?project=team-project-fields");
    expect(snapshot.response.status).toBe(200);
    const task = snapshot.body.tasks.find((item: any) => item.id === created.body.id);
    expect(task).toMatchObject({
      epic: "Launch",
      user_story: "As a lead",
      risk: "high",
    });
    expect(task.readiness).toMatchObject({
      problem_clear: true,
      files_known: true,
      verification_contract: true,
    });
    expect(typeof task.readiness).toBe("object");
  });

  it("serves project events with bounded reads and project-scoped authorization", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "events-project-a", name: "Events A" }),
    });
    const otherProject = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "events-project-b", name: "Events B" }),
    });
    expect([201, 409]).toContain(project.response.status);
    expect([201, 409]).toContain(otherProject.response.status);
    const eventAgent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "events-agent", project_id: "events-project-a", name: "Events Agent", role: "开发" }),
    });
    const eventAgentToken = String(eventAgent.body.token);
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "events-project-a", title: "Event task" }),
    });
    expect(task.response.status).toBe(201);
    const eventTaskId = String(task.body.id);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO agent_event(id, agent_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind("dashboard-agent-event", "events-agent", "events-project-a", "agent_active", JSON.stringify({ source: "dashboard", api_key: "do-not-leak" }), "2099-01-01T00:00:02.000Z"),
      env.DB.prepare(
        "INSERT INTO task_event(id, task_id, actor_agent_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind("dashboard-task-event", eventTaskId, "events-agent", "updated", JSON.stringify({ title: "safe summary" }), "2099-01-01T00:00:01.000Z"),
    ]);
    const events = await call("/api/board/events?project=events-project-a&limit=1", {}, "test-token");
    expect(events.response.status).toBe(200);
    expect(events.body.project_id).toBe("events-project-a");
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0]).toMatchObject({ type: "agent_active", agent_id: "events-agent", task_id: null });
    expect(events.body.events[0].payload_summary).toContain("dashboard");
    expect(JSON.stringify(events.body)).not.toContain("do-not-leak");
    expect((await call("/api/board/events?project=events-project-a", {}, "test-token")).body.events.length).toBeGreaterThan(1);
    expect((await call("/api/board/events?project=events-project-b", {}, eventAgentToken)).response.status).toBe(403);
    expect((await call("/api/board/events?project=events-project-a", {}, "missing-token")).response.status).toBe(401);
    const clamped = await call("/api/board/events?project=events-project-a&limit=9999", {}, "test-token");
    expect(clamped.response.status).toBe(200);
    expect(clamped.body.events.length).toBeLessThanOrEqual(200);
    const share = await call("/api/board/share-token", {
      method: "POST",
      body: JSON.stringify({ project_id: "events-project-a" }),
    });
    expect(share.response.status).toBe(201);
    const sharedEvents = await call("/api/board/events?project=events-project-a", {}, String(share.body.token));
    expect(sharedEvents.response.status).toBe(200);
  });

  it("serves fragment-token bootstrap without exposing it to the request", async () => {
    const response = await SELF.fetch(new Request("https://coord-board.test/?project=fragment-project"));
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("location.hash");
    expect(page).toContain("sharedParams.get('token')");
    expect(page).toContain("sharedParams.get('tkn')");
    expect(page).toContain("history.replaceState");
    expect(page).toContain("sessionStorage.setItem('coord-board-token',sharedToken)");
  });

  it("renews only a current unexpired lease holder and preserves generation", async () => {
    const created = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "renew lease" }),
    });
    const taskId = String(created.body.id);
    const claimed = await call(`/api/board/tasks/${taskId}/claim`, {
      method: "POST",
      body: JSON.stringify({ agent_id: "a", lease_seconds: 60 }),
    });
    expect(claimed.response.status).toBe(200);
    const generation = Number(claimed.body.lease_generation);
    const renewed = await call(`/api/board/tasks/${taskId}/renew`, {
      method: "POST",
      body: JSON.stringify({ agent_id: "a", lease_generation: generation, lease_seconds: 120 }),
    });
    expect(renewed.response.status).toBe(200);
    expect(renewed.body.lease_generation).toBe(generation);
    const denied = await call(`/api/board/tasks/${taskId}/renew`, {
      method: "POST",
      body: JSON.stringify({ agent_id: "b", lease_generation: generation }),
    });
    expect(denied.response.status).toBe(409);
    const after = await call(`/api/board/tasks/${taskId}`);
    expect(after.body.lease_owner).toBe("a");
    expect(after.body.lease_generation).toBe(generation);
  });

  it("does not reclaim an unexpired lease when the agent is stale", async () => {
    const created = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "stale lease protection" }),
    });
    const taskId = String(created.body.id);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE task_item SET phase = 'in_progress', lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?",
      ).bind("dead", future, future, taskId),
      env.DB.prepare(
        "UPDATE agent SET status = 'active', last_seen_at = ?, updated_at = ? WHERE id = ?",
      ).bind("2000-01-01T00:00:00.000Z", future, "dead"),
    ]);
    const trigger = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "sweep trigger" }),
    });
    expect(trigger.response.status).toBe(201);
    const after = await call(`/api/board/tasks/${taskId}`);
    expect(after.body.lease_owner).toBe("dead");
    expect(after.body.lease_expires_at).toBe(future);
  });

  it("supports PATCH assignee set and clear while enforcing project isolation", async () => {
    const projectA = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "patch-assignee-a", name: "Patch Assignee A" }),
    });
    const projectB = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "patch-assignee-b", name: "Patch Assignee B" }),
    });
    expect(projectA.response.status).toBe(201);
    expect(projectB.response.status).toBe(201);
    const agentA = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "patch-assignee-agent-a", project_id: "patch-assignee-a", name: "A", role: "worker" }),
    });
    const agentB = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "patch-assignee-agent-b", project_id: "patch-assignee-b", name: "B", role: "worker" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "patch-assignee-a", title: "assignee patch" }),
    });
    const taskId = String(task.body.id);
    const set = await call(`/api/board/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ assignee_agent_id: agentA.body.id }),
    });
    expect(set.response.status).toBe(200);
    expect(set.body.assignee_agent_id).toBe(agentA.body.id);
    const clear = await call(`/api/board/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ assignee_agent_id: null }),
    });
    expect(clear.response.status).toBe(200);
    expect(clear.body.assignee_agent_id).toBeNull();
    const crossProject = await call(`/api/board/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ assignee_agent_id: agentB.body.id }),
    });
    expect(crossProject.response.status).toBe(422);
    expect((await call(`/api/board/tasks/${taskId}`)).body.assignee_agent_id).toBeNull();
  });

  it("rejects completion without an active lease for a worker", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "complete-lease-project", name: "Complete Lease" }),
    });
    expect(project.response.status).toBe(201);
    const registration = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "complete-lease-worker", project_id: "complete-lease-project", name: "Worker", role: "worker" }),
    });
    expect(registration.response.status).toBe(201);
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "complete-lease-project", title: "must claim first" }),
    });
    const denied = await call(`/api/board/tasks/${task.body.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ agent_id: "complete-lease-worker" }),
    }, String(registration.body.token));
    expect(denied.response.status).toBe(409);
    const unchanged = await call(`/api/board/tasks/${task.body.id}`);
    expect(unchanged.body.phase).toBe("pending");
  });

  it("rejects dependency updates that would create a multi-node cycle", async () => {
    const [a, b, c] = await Promise.all([
      call("/api/board/tasks", { method: "POST", body: JSON.stringify({ title: "cycle A" }) }),
      call("/api/board/tasks", { method: "POST", body: JSON.stringify({ title: "cycle B" }) }),
      call("/api/board/tasks", { method: "POST", body: JSON.stringify({ title: "cycle C" }) }),
    ]);
    await call(`/api/board/tasks/${b.body.id}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [a.body.id] }),
    });
    await call(`/api/board/tasks/${c.body.id}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [b.body.id] }),
    });
    const cycle = await call(`/api/board/tasks/${a.body.id}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [c.body.id] }),
    });
    expect(cycle.response.status).toBe(422);
    expect((await call(`/api/board/tasks/${a.body.id}`)).body.dependencies).toEqual([]);
  });

  it("rejects a two-task dependency cycle", async () => {
    const [a, b] = await Promise.all([
      call("/api/board/tasks", { method: "POST", body: JSON.stringify({ title: "two-node A" }) }),
      call("/api/board/tasks", { method: "POST", body: JSON.stringify({ title: "two-node B" }) }),
    ]);
    expect((await call(`/api/board/tasks/${a.body.id}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [b.body.id] }),
    })).response.status).toBe(200);
    const cycle = await call(`/api/board/tasks/${b.body.id}/dependencies`, {
      method: "PUT",
      body: JSON.stringify({ depends_on: [a.body.id] }),
    });
    expect(cycle.response.status).toBe(422);
    expect(cycle.body.error).toBe("dependency cycle");
  });

  it("prevents PATCH from bypassing required gates or acceptance", async () => {
    const gated = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "patch gate", required_gates: ["qa"] }),
    });
    const gatedPatch = await call(`/api/board/tasks/${gated.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ phase: "done" }),
    });
    expect(gatedPatch.response.status).toBe(409);
    expect((await call(`/api/board/tasks/${gated.body.id}`)).body.phase).toBe("pending");
    const acceptance = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "patch acceptance", require_acceptance: true }),
    });
    const acceptancePatch = await call(`/api/board/tasks/${acceptance.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ phase: "done" }),
    });
    expect(acceptancePatch.response.status).toBe(422);
    expect((await call(`/api/board/tasks/${acceptance.body.id}`)).body.phase).toBe("pending");
    const removableGate = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "remove stale gate", required_gates: ["old-gate"] }),
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE task_item SET phase = 'in_progress', lease_owner = ?, lease_expires_at = ? WHERE id = ?",
      ).bind("lead", new Date(Date.now() + 60_000).toISOString(), removableGate.body.id),
      env.DB.prepare(
        "INSERT INTO task_gate(id, task_id, gate_name, status, created_at, updated_at) VALUES (?, ?, ?, 'failed', ?, ?)",
      ).bind("stale-gate", removableGate.body.id, "old-gate", nowForTest(), nowForTest()),
    ]);
    const completed = await call(`/api/board/tasks/${removableGate.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ required_gates: [], phase: "done" }),
    });
    expect(completed.response.status).toBe(200);
    expect(completed.body.phase).toBe("done");
    expect(completed.body.lease_owner).toBeNull();
    expect(completed.body.lease_expires_at).toBeNull();
    const teamAfterDone = await call("/api/board/team?project=default");
    expect(teamAfterDone.body.agents.find((agent: { id: string }) => agent.id === "lead").current_task).toBeNull();
    const gateChange = await env.DB.prepare(
      "SELECT event_type, payload_json FROM task_event WHERE task_id = ? AND event_type = 'done_gate_requirements_changed'",
    ).bind(removableGate.body.id).first<{ event_type: string; payload_json: string }>();
    expect(gateChange?.event_type).toBe("done_gate_requirements_changed");
    expect(gateChange?.payload_json).toContain("old-gate");
    const plan = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "patch plan", require_plan: true }),
    });
    const planPatch = await call(`/api/board/tasks/${plan.body.id}`, {
      method: "PATCH",
      body: JSON.stringify({ phase: "done", require_plan: false }),
    });
    expect(planPatch.response.status).toBe(409);
    const acceptanceDone = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "accepted terminal lease", require_acceptance: true }),
    });
    const acceptanceExpiry = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare(
      "UPDATE task_item SET phase = 'in_progress', acceptance_status = 'submitted', lease_owner = ?, lease_expires_at = ? WHERE id = ?",
    ).bind("lead", acceptanceExpiry, acceptanceDone.body.id).run();
    const accepted = await call(`/api/board/tasks/${acceptanceDone.body.id}/acceptance`, {
      method: "POST",
      body: JSON.stringify({ decision: "accept" }),
    });
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.phase).toBe("done");
    expect(accepted.body.lease_owner).toBeNull();
    expect(accepted.body.lease_expires_at).toBeNull();
  });

  it("serves the unauthenticated API health alias", async () => {
    const response = await SELF.fetch(new Request("https://coord-board.test/api/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "coord-board" });
  });

  it("expires orphaned in-progress idempotency reservations during lease sweeps", async () => {
    const trigger = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "idempotency sweep trigger" }),
    });
    const triggerClaim = await call(`/api/board/tasks/${trigger.body.id}/claim`, {
      method: "POST",
      body: JSON.stringify({ agent_id: "a" }),
    });
    expect(triggerClaim.response.status).toBe(200);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO idempotency_key(scope, key, response_status, response_body, created_at) VALUES (?, ?, NULL, NULL, ?)",
    ).bind("task:create:default", "orphaned-key", "2000-01-01T00:00:00.000Z").run();
    await worker.scheduled({} as ScheduledEvent, env);
    const sweep = await call(`/api/board/tasks/${trigger.body.id}/claim`, {
      method: "POST",
      body: JSON.stringify({ agent_id: "b" }),
    });
    expect(sweep.response.status).toBe(409);
    const reused = await call("/api/board/tasks", {
      method: "POST",
      headers: { "idempotency-key": "orphaned-key" },
      body: JSON.stringify({ title: "reused after cleanup" }),
    });
    expect(reused.response.status).toBe(201);
    const retried = await call("/api/board/tasks", {
      method: "POST",
      headers: { "idempotency-key": "orphaned-key" },
      body: JSON.stringify({ title: "reused after cleanup" }),
    });
    expect(retried.response.status).toBe(201);
    expect(retried.body.id).toBe(reused.body.id);
  });

  it("rotates agent tokens and rejects revoked credentials", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "credentials-project", name: "Credentials" }),
    });
    expect(project.response.status).toBe(201);
    const registration = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "credentials-worker",
        project_id: "credentials-project",
        name: "Credentials Worker",
        role: "worker",
      }),
    });
    expect(registration.response.status).toBe(201);
    const oldToken = String(registration.body.token);
    const rotated = await call("/api/board/agents/credentials-worker/rotate-token", { method: "POST" });
    expect(rotated.response.status).toBe(200);
    const newToken = String(rotated.body.token);
    expect(newToken).not.toBe(oldToken);
    expect((await call("/api/board/agents", {}, oldToken)).response.status).toBe(401);
    expect((await call("/api/board/agents", {}, newToken)).response.status).toBe(200);
    expect(rotated.body.token_hash).toBeUndefined();
  });

  it("revokes a worker token on shutdown and blocks subsequent claims", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "credentials-project", name: "Credentials" }),
    });
    const registration = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "shutdown-revoke-worker",
        project_id: "credentials-project",
        name: "Shutdown Worker",
        role: "worker",
      }),
    });
    const token = String(registration.body.token);
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "credentials-project", title: "claim before revoke" }),
    });
    const claimed = await call(`/api/board/tasks/${task.body.id}/claim`, { method: "POST" }, token);
    expect(claimed.response.status).toBe(200);
    const shutdown = await call("/api/board/agents/shutdown-revoke-worker/shutdown", {
      method: "POST",
      body: JSON.stringify({ revoke_token: true }),
    });
    expect(shutdown.response.status).toBe(200);
    expect(shutdown.body.token_revoked).toBe(true);
    const anotherTask = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "credentials-project", title: "claim after revoke" }),
    });
    const denied = await call(`/api/board/tasks/${anotherTask.body.id}/claim`, { method: "POST" }, token);
    expect(denied.response.status).toBe(401);
  });

  it("issues project-scoped read-only share tokens with expiry", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "credentials-project", name: "Credentials" }),
    });
    const issued = await call("/api/board/share-token", {
      method: "POST",
      body: JSON.stringify({ project_id: "credentials-project", ttl_seconds: 3600 }),
    });
    expect(issued.response.status).toBe(201);
    const token = String(issued.body.token);
    const team = await call("/api/board/team?project=credentials-project", {}, token);
    expect(team.response.status).toBe(200);
    const deniedMutation = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "credentials-project", title: "share must not mutate" }),
    }, token);
    expect(deniedMutation.response.status).toBe(403);
    expect(deniedMutation.body.error).toContain("read-only");
    await env.DB.prepare("UPDATE share_token SET expires_at = ? WHERE token_hash = ?")
      .bind("2000-01-01T00:00:00.000Z", await sha256ForTest(token)).run();
    expect((await call("/api/board/team?project=credentials-project", {}, token)).response.status).toBe(401);
  });

  it("serves canonical role-aware briefings without credentials or desktop-sync claims", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "credentials-project", name: "Credentials" }),
    });
    const worker = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "briefing-worker",
        project_id: "credentials-project",
        name: "Briefing Worker",
        role: "worker",
      }),
    });
    const lead = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "briefing-lead",
        project_id: "credentials-project",
        name: "Briefing Lead",
        role: "lead",
      }),
    });
    const workerToken = String(worker.body.token);
    const leadToken = String(lead.body.token);
    const workerBriefing = await call("/api/board/briefing?role=worker&project=credentials-project", {}, workerToken);
    expect(workerBriefing.response.status).toBe(200);
    expect(workerBriefing.body.capabilities).toContain("claim");
    expect(workerBriefing.body.capabilities).not.toContain("manage");
    expect(workerBriefing.body.briefing_markdown).toContain("POST /api/board/tasks/:id/renew");
    expect(workerBriefing.body.briefing_markdown).toContain("every 60–120 seconds");
    expect(workerBriefing.body.briefing_markdown).toContain("Board API and mailbox");
    expect(workerBriefing.body.briefing_markdown).not.toContain("desktop engine");
    expect(workerBriefing.body.briefing_markdown).not.toContain(workerToken);
    const leadBriefing = await call("/api/board/briefing?role=lead&project=credentials-project", {}, leadToken);
    expect(leadBriefing.response.status).toBe(200);
    expect(leadBriefing.body.capabilities).toContain("manage");
    expect(leadBriefing.body.briefing_markdown).toContain("PATCH /api/board/tasks/:id");
    expect(leadBriefing.body.briefing_markdown).toContain("assignee_agent_id");
    expect(leadBriefing.body.briefing_markdown).toContain("POST /api/board/tasks/:id/reassign");
    expect(leadBriefing.body.briefing_markdown).toContain("POST /api/board/agents/:id/shutdown");
    expect(leadBriefing.body.briefing_markdown).not.toContain(leadToken);
  });

  it("atomically claims accounts across owners, refreshes idempotently, and releases by project", async () => {
    for (const id of ["claims-project", "claims-other-project"]) {
      const project = await call("/api/board/projects", {
        method: "POST",
        body: JSON.stringify({ id, name: id }),
      });
      expect([201, 409]).toContain(project.response.status);
    }
    const requests = await Promise.all([
      call("/api/board/account-claims", {
        method: "POST",
        body: JSON.stringify({
          project_id: "claims-project",
          claimed_by: "spawner-a",
          ttl_seconds: 300,
          accounts: [{ account_ref: "account-1", role_tag: "开发" }],
        }),
      }),
      call("/api/board/account-claims", {
        method: "POST",
        body: JSON.stringify({
          project_id: "claims-project",
          claimed_by: "spawner-b",
          accounts: [{ account_ref: "account-1", role_tag: "开发" }],
        }),
      }),
    ]);
    expect(requests.every((result) => result.response.status === 200)).toBe(true);
    expect(requests.filter((result) => result.body.claims[0].granted).length).toBe(1);

    const refresh = await call("/api/board/account-claims", {
      method: "POST",
      body: JSON.stringify({
        project_id: "claims-project",
        claimed_by: "spawner-a",
        accounts: [{ account_ref: "account-1", role_tag: "测试" }],
      }),
    });
    expect(refresh.response.status).toBe(200);
    expect(refresh.body.claims[0]).toMatchObject({ account_ref: "account-1", role_tag: "测试", granted: true });
    const refreshedRow = await env.DB.prepare(
      "SELECT claimed_by, role_tag, status FROM account_claim WHERE project_id = ? AND account_ref = ?",
    ).bind("claims-project", "account-1").first<{ claimed_by: string; role_tag: string; status: string }>();
    expect(refreshedRow).toEqual({ claimed_by: "spawner-a", role_tag: "测试", status: "claimed" });

    await env.DB.prepare(
      "UPDATE account_claim SET expires_at = ? WHERE project_id = ? AND account_ref = ?",
    ).bind("2000-01-01T00:00:00.000Z", "claims-project", "account-1").run();
    const afterExpiry = await call("/api/board/account-claims", {
      method: "POST",
      body: JSON.stringify({
        project_id: "claims-project",
        claimed_by: "spawner-b",
        accounts: [{ account_ref: "account-1", role_tag: "开发" }],
      }),
    });
    expect(afterExpiry.body.claims[0].granted).toBe(true);

    const otherProject = await call("/api/board/account-claims", {
      method: "POST",
      body: JSON.stringify({
        project_id: "claims-other-project",
        claimed_by: "spawner-a",
        accounts: [{ account_ref: "account-1", role_tag: "开发" }],
      }),
    });
    expect(otherProject.body.claims[0].granted).toBe(true);
    const released = await call("/api/board/account-claims/release", {
      method: "POST",
      body: JSON.stringify({
        project_id: "claims-project",
        claimed_by: "spawner-b",
        account_refs: ["account-1"],
      }),
    });
    expect(released.body.released).toBe(1);
    expect((await call("/api/board/account-claims?project=claims-other-project")).body.claims).toHaveLength(1);
  });

  it("requires manage capability and does not mutate denied account claims", async () => {
    const worker = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "claims-worker",
        project_id: "default",
        name: "Claims Worker",
        role: "worker",
      }),
    });
    expect(worker.response.status).toBe(201);
    expect(worker.body.token).toBeTruthy();
    const denied = await call("/api/board/account-claims", {
      method: "POST",
      body: JSON.stringify({
        project_id: "claims-project",
        claimed_by: "spawner-denied",
        accounts: [{ account_ref: "account-denied", role_tag: "开发" }],
      }),
    }, String(worker.body.token));
    expect(denied.response.status).toBe(403);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM account_claim WHERE project_id = ? AND account_ref = ?",
    ).bind("claims-project", "account-denied").first<{ count: number }>())?.count).toBe(0);
  });

  it("stores worker profiles and hides them from other projects", async () => {
    const project = await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "profile-project", name: "Profile Project" }),
    });
    expect([201, 409]).toContain(project.response.status);
    const created = await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({
        project_id: "profile-project",
        id: "profile-dev",
        name: "Developer",
        role_tag: "开发",
        model: "gpt-5",
        snapshot_id: "snap-1",
        system_prompt: "You build features.",
        prompt_template: "Work on {{task_title}} ({{task_id}}).",
        playbook_refs: ["pb-1"],
        knowledge_refs: ["kn-1"],
        mcp_tools: ["github"],
        repo_config: { repo: "org/app", branch: "main" },
      }),
    });
    expect(created.response.status).toBe(200);
    expect(created.body.worker_profiles[0]).toMatchObject({
      id: "profile-dev",
      role_tag: "开发",
      model: "gpt-5",
      playbook_refs: ["pb-1"],
      repo_config: { repo: "org/app", branch: "main" },
      enabled: 1,
    });
    const listed = await call("/api/board/worker-profiles?project=profile-project");
    expect(listed.response.status).toBe(200);
    expect(listed.body.worker_profiles).toHaveLength(1);

    const worker = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "profile-worker", project_id: "profile-project", name: "PW", role: "worker" }),
    });
    const denied = await call(
      "/api/board/worker-profiles?project=profile-project",
      { method: "GET" },
      String(worker.body.token),
    );
    expect(denied.response.status).toBe(403);

    const deleted = await call("/api/board/worker-profiles/profile-dev", { method: "DELETE" });
    expect(deleted.response.status).toBe(200);
    expect((await call("/api/board/worker-profiles?project=profile-project")).body.worker_profiles).toHaveLength(0);
  });

  it("rejects task spawn without a worker profile and records requested spawn", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "spawn-project", name: "Spawn Project" }),
    });
    await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({
        project_id: "spawn-project",
        id: "spawn-profile",
        name: "Spawn Dev",
        role_tag: "worker",
        system_prompt: "Build it.",
      }),
    });
    const invalid = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "spawn-project", title: "No profile spawn", spawn: true }),
    });
    expect(invalid.response.status).toBe(422);
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({
        board_id: "spawn-project",
        title: "Spawn me",
        worker_profile_id: "spawn-profile",
        spawn: true,
      }),
    });
    expect(task.response.status).toBe(201);
    expect(task.body.worker_profile_id).toBe("spawn-profile");
    expect(task.body.spawn_status).toBe("requested");
  });

  it("spawns a worker session for a requested task via the scheduled run", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "spawn-run-project", name: "Spawn Run" }),
    });
    await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({
        project_id: "spawn-run-project",
        id: "spawn-run-profile",
        name: "Runner",
        role_tag: "worker",
        model: "ultra",
        knowledge_refs: ["kn-1", "kn-2"],
        playbook_refs: ["pb-1"],
        snapshot_id: "snap-123",
      }),
    });
    await call("/api/board/backup-accounts", {
      method: "POST",
      body: JSON.stringify({
        project_id: "spawn-run-project",
        id: "spawn-run-account",
        role_tag: "worker",
        org_id: "org-spawn-run",
        credential: "api-secret-spawn-run",
      }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({
        board_id: "spawn-run-project",
        title: "Cloud spawn task",
        description: "Do the work",
        worker_profile_id: "spawn-run-profile",
        spawn: true,
      }),
    });
    expect(task.response.status).toBe(201);
    const taskId = String(task.body.id);
    const capturedPrompts: string[] = [];
    const capturedBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedBodies.push(parsed);
      capturedPrompts.push(String(parsed.prompt ?? ""));
      return new Response(JSON.stringify({ session_id: "devin-spawn-run" }), { status: 200 });
    });
    await worker.scheduled({} as ScheduledEvent, env);
    fetchMock.mockRestore();

    // The create-session body must use only valid v3 SessionCreateRequest fields.
    const createBody = capturedBodies.find((b) => "prompt" in b && !("message" in b));
    expect(createBody).toBeDefined();
    expect(createBody!.devin_mode).toBe("ultra");
    expect(createBody!.knowledge_ids).toEqual(["kn-1", "kn-2"]);
    expect(createBody!.playbook_id).toBe("pb-1");
    expect(createBody!.snapshot_id).toBeUndefined();

    const row = await env.DB.prepare(
      "SELECT spawn_status, assignee_agent_id FROM task_item WHERE id = ?",
    ).bind(taskId).first<{ spawn_status: string; assignee_agent_id: string }>();
    expect(row?.spawn_status).toBe("spawned");
    expect(row?.assignee_agent_id).toMatch(/^spawn-/);
    const agent = await env.DB.prepare(
      "SELECT metadata_json FROM agent WHERE id = ?",
    ).bind(row!.assignee_agent_id).first<{ metadata_json: string }>();
    expect(JSON.parse(agent!.metadata_json).session_id).toBe("devin-spawn-run");
    expect(capturedPrompts.some((prompt) => prompt.includes("Cloud spawn task"))).toBe(true);
    expect(capturedPrompts.every((prompt) => !prompt.includes("api-secret-spawn-run"))).toBe(true);
    const account = await env.DB.prepare(
      "SELECT status FROM backup_account WHERE id = ?",
    ).bind("spawn-run-account").first<{ status: string }>();
    expect(account?.status).toBe("active");
  });

  it("does not let a profile upsert move an existing profile to another project", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "hijack-owner", name: "Owner" }),
    });
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "hijack-attacker", name: "Attacker" }),
    });
    const created = await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({
        project_id: "hijack-owner",
        id: "shared-id",
        name: "Owned",
        role_tag: "worker",
      }),
    });
    expect(created.response.status).toBe(200);
    const hijack = await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({
        project_id: "hijack-attacker",
        id: "shared-id",
        name: "Stolen",
        role_tag: "worker",
      }),
    });
    expect(hijack.response.status).toBe(200);
    expect(hijack.body.worker_profiles).toHaveLength(0);
    const stored = await env.DB.prepare(
      "SELECT project_id, name FROM worker_profile WHERE id = ?",
    ).bind("shared-id").first<{ project_id: string; name: string }>();
    expect(stored?.project_id).toBe("hijack-owner");
    expect(stored?.name).toBe("Owned");
  });

  it("recovers a task stuck in spawning and re-queues it", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "stuck-project", name: "Stuck" }),
    });
    await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({ project_id: "stuck-project", id: "stuck-profile", name: "P", role_tag: "worker" }),
    });
    await call("/api/board/backup-accounts", {
      method: "POST",
      body: JSON.stringify({ project_id: "stuck-project", id: "stuck-account", role_tag: "worker", org_id: "org-stuck", credential: "secret-stuck" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "stuck-project", title: "Stuck task", worker_profile_id: "stuck-profile", spawn: true }),
    });
    const taskId = String(task.body.id);
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await env.DB.prepare("UPDATE task_item SET spawn_status = 'spawning', updated_at = ? WHERE id = ?").bind(stale, taskId).run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ session_id: "devin-stuck" }), { status: 200 }));
    await worker.scheduled({} as ScheduledEvent, env);
    fetchMock.mockRestore();
    const row = await env.DB.prepare("SELECT spawn_status FROM task_item WHERE id = ?").bind(taskId).first<{ spawn_status: string }>();
    expect(row?.spawn_status).toBe("spawned");
  });

  it("re-queues a failed spawn via PATCH spawn", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "retry-project", name: "Retry" }),
    });
    await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({ project_id: "retry-project", id: "retry-profile", name: "P", role_tag: "worker" }),
    });
    await call("/api/board/backup-accounts", {
      method: "POST",
      body: JSON.stringify({ project_id: "retry-project", id: "retry-account", role_tag: "worker", org_id: "org-retry", credential: "secret-retry" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "retry-project", title: "Retry task", worker_profile_id: "retry-profile", spawn: true }),
    });
    const taskId = String(task.body.id);
    await env.DB.prepare("UPDATE task_item SET spawn_status = 'failed' WHERE id = ?").bind(taskId).run();
    const patched = await call(`/api/board/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ spawn: true }),
    });
    expect(patched.response.status).toBe(200);
    expect(patched.body.spawn_status).toBe("requested");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ session_id: "devin-retry" }), { status: 200 }));
    await worker.scheduled({} as ScheduledEvent, env);
    fetchMock.mockRestore();
    const row = await env.DB.prepare("SELECT spawn_status FROM task_item WHERE id = ?").bind(taskId).first<{ spawn_status: string }>();
    expect(row?.spawn_status).toBe("spawned");
  });

  it("rejects PATCH spawn on a task that is already actively spawning/spawned", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "guard-project", name: "Guard" }),
    });
    await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({ project_id: "guard-project", id: "guard-profile", name: "P", role_tag: "worker" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "guard-project", title: "Guard task", worker_profile_id: "guard-profile", spawn: true }),
    });
    const taskId = String(task.body.id);
    await env.DB.prepare("UPDATE task_item SET spawn_status = 'spawned' WHERE id = ?").bind(taskId).run();
    const patched = await call(`/api/board/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ spawn: true }),
    });
    expect(patched.response.status).toBe(409);
    const row = await env.DB.prepare("SELECT spawn_status FROM task_item WHERE id = ?").bind(taskId).first<{ spawn_status: string }>();
    expect(row?.spawn_status).toBe("spawned");
  });

  it("clears a pending spawn when the worker profile is removed", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "clear-project", name: "Clear" }),
    });
    await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({ project_id: "clear-project", id: "clear-profile", name: "P", role_tag: "worker" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "clear-project", title: "Clear task", worker_profile_id: "clear-profile", spawn: true }),
    });
    const taskId = String(task.body.id);
    const patched = await call(`/api/board/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ worker_profile_id: null }),
    });
    expect(patched.response.status).toBe(200);
    const row = await env.DB.prepare("SELECT worker_profile_id, spawn_status FROM task_item WHERE id = ?").bind(taskId).first<{ worker_profile_id: string | null; spawn_status: string | null }>();
    expect(row?.worker_profile_id).toBeNull();
    expect(row?.spawn_status).toBeNull();
  });

  it("terminates an orphaned session when reconciling a stuck spawn", async () => {
    await call("/api/board/projects", {
      method: "POST",
      body: JSON.stringify({ id: "orphan-project", name: "Orphan" }),
    });
    await call("/api/board/worker-profiles", {
      method: "POST",
      body: JSON.stringify({ project_id: "orphan-project", id: "orphan-profile", name: "P", role_tag: "worker" }),
    });
    await call("/api/board/backup-accounts", {
      method: "POST",
      body: JSON.stringify({ project_id: "orphan-project", id: "orphan-account", role_tag: "worker", org_id: "org-orphan", credential: "secret-orphan" }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "orphan-project", title: "Orphan task", worker_profile_id: "orphan-profile", spawn: true }),
    });
    const taskId = String(task.body.id);
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // Simulate an isolate that created the session and persisted its id, then died before commit.
    await env.DB.prepare("UPDATE task_item SET spawn_status = 'spawning', updated_at = ? WHERE id = ?").bind(stale, taskId).run();
    await env.DB.prepare("UPDATE backup_account SET status = 'reserved' WHERE id = ?").bind("orphan-account").run();
    await env.DB.prepare(
      "INSERT INTO agent(id, project_id, name, role, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'online', ?, ?, ?)",
    ).bind(
      "orphan-agent", "orphan-project", "Orphan worker",
      JSON.stringify({ cloud_spawn: true, task_id: taskId, backup_account_id: "orphan-account", session_id: "devin-orphan" }),
      stale, stale,
    ).run();
    const seen: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify({ session_id: "devin-orphan-2" }), { status: 200 });
    });
    await worker.scheduled({} as ScheduledEvent, env);
    fetchMock.mockRestore();
    // The orphaned Devin session was terminated during reconciliation.
    expect(seen.some((entry) => entry.includes("devin-orphan"))).toBe(true);
    const orphan = await env.DB.prepare("SELECT id FROM agent WHERE id = ?").bind("orphan-agent").first();
    expect(orphan).toBeNull();
    const row = await env.DB.prepare("SELECT spawn_status FROM task_item WHERE id = ?").bind(taskId).first<{ spawn_status: string }>();
    expect(row?.spawn_status).toBe("spawned");
  });

  // ---- M2/M3/M4: leader, watchdog, answer, sleep, budget, provision, observability ----

  const seedSpawnedTask = async (project: string, opts: { session: string; account: string; org?: string } & Record<string, unknown>) => {
    const taskId = `task-${project}-${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = nowForTest();
    await env.DB.prepare(
      "INSERT INTO task_item(id, board_id, title, description, phase, spawn_status, worker_profile_id, created_at, updated_at) VALUES (?, ?, ?, '', 'in_progress', 'spawned', NULL, ?, ?)",
    ).bind(taskId, project, "Watchdog task", timestamp, timestamp).run();
    await env.DB.prepare(
      "INSERT INTO backup_account(id, project_id, role_tag, label, org_id, credential_type, credential_ciphertext, credential_iv, key_version, enabled, status, cooldown_until, last_used_at, created_at, updated_at) VALUES (?, ?, 'worker', '', ?, 'apikey', 'ct', 'iv', 'v1', 1, 'active', NULL, NULL, ?, ?)",
    ).bind(opts.account, project, opts.org ?? `org-${project}`, timestamp, timestamp).run().catch(() => undefined);
    const agentId = `spawn-${project}-${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare(
      "INSERT INTO agent(id, project_id, name, role, status, metadata_json, created_at, updated_at) VALUES (?, ?, 'W', 'worker', 'online', ?, ?, ?)",
    ).bind(agentId, project, JSON.stringify({ cloud_spawn: true, task_id: taskId, backup_account_id: opts.account, session_id: opts.session }), timestamp, timestamp).run();
    return { taskId, agentId };
  };

  // Watchdog decrypts the backup credential to poll Devin; stub decrypt so the seeded ciphertext works.
  const withDevin = (handler: (method: string, url: string, init?: RequestInit) => Response) => {
    const decryptSpy = vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async () => new TextEncoder().encode("devin-cred").buffer);
    const seen: string[] = [];
    const bodies: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      seen.push(`${method} ${url}`);
      if (init?.body) bodies.push(String(init.body));
      return handler(method, url, init);
    });
    return { restore: () => { fetchMock.mockRestore(); decryptSpy.mockRestore(); }, seen, bodies };
  };

  it("registers a Cloud-Dev leader agent and links it to the project", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "leader-project", name: "Leader" }) });
    const reg = await call("/api/board/leader", {
      method: "POST",
      body: JSON.stringify({ project_id: "leader-project", session_id: "cloud-dev-sess-1", name: "Chief" }),
    });
    expect(reg.response.status).toBe(201);
    expect(reg.body.role).toBe("lead");
    expect(reg.body.token).toBeTruthy();
    expect(reg.body.briefing_markdown).toContain("Orchestration");
    const project = await env.DB.prepare("SELECT leader_agent_id FROM project WHERE id = ?").bind("leader-project").first<{ leader_agent_id: string }>();
    expect(project?.leader_agent_id).toBe("lead-leader-project");
    // Re-link with a new session id: no new token issued.
    const relink = await call("/api/board/leader", {
      method: "POST",
      body: JSON.stringify({ project_id: "leader-project", session_id: "cloud-dev-sess-2" }),
    });
    expect(relink.response.status).toBe(200);
    expect(relink.body.relinked).toBe(true);
    expect(relink.body.token).toBeUndefined();
  });

  it("rejects leader registration from a non-admin agent", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "leader-authz", name: "Authz" }) });
    const agent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "leader-authz-worker", name: "W", project_id: "leader-authz", role: "worker" }),
    });
    const token = String(agent.body.token);
    const attempt = await call("/api/board/leader", {
      method: "POST",
      body: JSON.stringify({ project_id: "leader-authz", session_id: "x" }),
    }, token);
    expect(attempt.response.status).toBe(403);
  });

  it("watchdog flags a blocked worker and notifies the leader with question and choices", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "wd-block", name: "WD" }) });
    await call("/api/board/leader", { method: "POST", body: JSON.stringify({ project_id: "wd-block", session_id: "s" }) });
    const { taskId } = await seedSpawnedTask("wd-block", { session: "devin-wd-block", account: "wd-block-acct" });
    const devin = withDevin((method, url) => {
      if (method === "GET" && url.endsWith("devin-wd-block/messages")) {
        return new Response(JSON.stringify({ items: [{ source: "devin", message: "Which port should I use?\n- 8080\n- 9090" }], has_next_page: false }), { status: 200 });
      }
      if (method === "GET" && url.endsWith("devin-wd-block")) {
        return new Response(JSON.stringify({ status: "suspended", status_detail: "waiting_for_user" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running", status_detail: "working" }), { status: 200 });
    });
    await worker.scheduled({} as ScheduledEvent, env);
    devin.restore();
    const row = await env.DB.prepare("SELECT blocked, needs_human, watchdog_status FROM task_item WHERE id = ?").bind(taskId).first<{ blocked: number; needs_human: number; watchdog_status: string }>();
    expect(row?.blocked).toBe(1);
    expect(row?.needs_human).toBe(0);
    expect(row?.watchdog_status).toBe("blocked");
    const events = await env.DB.prepare("SELECT event_type, payload_json FROM task_event WHERE task_id = ? AND event_type = 'worker_blocked'").bind(taskId).all<{ event_type: string; payload_json: string }>();
    expect(events.results.length).toBe(1);
    expect(events.results[0].payload_json).toContain("Which port");
    const delivery = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM message_delivery WHERE recipient_agent_id = 'lead-wd-block'",
    ).first<{ c: number }>();
    expect(Number(delivery?.c)).toBeGreaterThanOrEqual(1);
  });

  it("watchdog escalates a high-risk blocked question as needs_human", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "wd-risk", name: "Risk" }) });
    await call("/api/board/leader", { method: "POST", body: JSON.stringify({ project_id: "wd-risk", session_id: "s" }) });
    const { taskId } = await seedSpawnedTask("wd-risk", { session: "devin-wd-risk", account: "wd-risk-acct" });
    const devin = withDevin((method, url) => {
      if (method === "GET" && url.endsWith("devin-wd-risk/messages")) {
        return new Response(JSON.stringify({ items: [{ source: "devin", message: "Should I delete the production database?" }] }), { status: 200 });
      }
      if (method === "GET" && url.endsWith("devin-wd-risk")) {
        return new Response(JSON.stringify({ status: "suspended", status_detail: "waiting_for_user" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running", status_detail: "working" }), { status: 200 });
    });
    await worker.scheduled({} as ScheduledEvent, env);
    devin.restore();
    const row = await env.DB.prepare("SELECT blocked, needs_human FROM task_item WHERE id = ?").bind(taskId).first<{ blocked: number; needs_human: number }>();
    expect(row?.blocked).toBe(1);
    expect(row?.needs_human).toBe(1);
    const events = await env.DB.prepare("SELECT COUNT(*) AS c FROM task_event WHERE task_id = ? AND event_type = 'worker_blocked_needs_human'").bind(taskId).first<{ c: number }>();
    expect(Number(events?.c)).toBe(1);
  });

  it("watchdog does not re-notify while the worker stays blocked", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "wd-dedupe", name: "Dedupe" }) });
    await call("/api/board/leader", { method: "POST", body: JSON.stringify({ project_id: "wd-dedupe", session_id: "s" }) });
    const { taskId } = await seedSpawnedTask("wd-dedupe", { session: "devin-wd-dedupe", account: "wd-dedupe-acct" });
    const respond = (method: string, url: string) =>
      method === "GET" && url.endsWith("devin-wd-dedupe/messages")
        ? new Response(JSON.stringify({ items: [{ source: "devin", message: "Pick one" }] }), { status: 200 })
        : method === "GET" && url.endsWith("devin-wd-dedupe")
          ? new Response(JSON.stringify({ status: "suspended", status_detail: "waiting_for_user" }), { status: 200 })
          : new Response(JSON.stringify({ status: "running", status_detail: "working" }), { status: 200 });
    let devin = withDevin(respond);
    await worker.scheduled({} as ScheduledEvent, env);
    devin.restore();
    devin = withDevin(respond);
    await worker.scheduled({} as ScheduledEvent, env);
    devin.restore();
    const events = await env.DB.prepare("SELECT COUNT(*) AS c FROM task_event WHERE task_id = ? AND event_type = 'worker_blocked'").bind(taskId).first<{ c: number }>();
    expect(Number(events?.c)).toBe(1);
  });

  it("answer endpoint forwards the chosen option to the worker and clears the block", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "answer-project", name: "Answer" }) });
    const { taskId } = await seedSpawnedTask("answer-project", { session: "devin-answer", account: "answer-acct" });
    await env.DB.prepare("UPDATE task_item SET blocked = 1, needs_human = 1 WHERE id = ?").bind(taskId).run();
    const devin = withDevin(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const answered = await call(`/api/board/tasks/${taskId}/answer`, { method: "POST", body: JSON.stringify({ message: "9090" }) });
    devin.restore();
    expect(answered.response.status).toBe(200);
    expect(answered.body.delivered).toBe(true);
    expect(devin.bodies.some((b) => b.includes("9090"))).toBe(true);
    expect(devin.bodies.every((b) => !b.includes("devin-cred"))).toBe(true);
    const row = await env.DB.prepare("SELECT blocked, needs_human FROM task_item WHERE id = ?").bind(taskId).first<{ blocked: number; needs_human: number }>();
    expect(row?.blocked).toBe(0);
    expect(row?.needs_human).toBe(0);
  });

  it("watchdog wakes an idle session that has not really finished", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "wd-wake", name: "Wake" }) });
    const { taskId, agentId } = await seedSpawnedTask("wd-wake", { session: "devin-wd-wake", account: "wd-wake-acct" });
    const devin = withDevin((method, url) =>
      method === "GET" && url.endsWith("devin-wd-wake")
        ? new Response(JSON.stringify({ status: "suspended", status_detail: "inactivity" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await worker.scheduled({} as ScheduledEvent, env);
    devin.restore();
    expect(devin.seen.some((e) => e.startsWith("POST") && e.includes("devin-wd-wake") && e.includes("/messages"))).toBe(true);
    const evt = await env.DB.prepare("SELECT COUNT(*) AS c FROM task_event WHERE task_id = ? AND event_type = 'worker_wake_nudge'").bind(taskId).first<{ c: number }>();
    expect(Number(evt?.c)).toBe(1);
    const agent = await env.DB.prepare("SELECT metadata_json FROM agent WHERE id = ?").bind(agentId).first<{ metadata_json: string }>();
    expect(JSON.parse(agent!.metadata_json).last_wake_at).toBeTruthy();
  });

  it("watchdog does not wake a session that has really completed; it escalates for verification", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "wd-done", name: "Done" }) });
    await call("/api/board/leader", { method: "POST", body: JSON.stringify({ project_id: "wd-done", session_id: "s" }) });
    const { taskId } = await seedSpawnedTask("wd-done", { session: "devin-wd-done", account: "wd-done-acct" });
    const devin = withDevin((method, url) =>
      method === "GET" && url.endsWith("devin-wd-done")
        ? new Response(JSON.stringify({ status: "exit", status_detail: "finished", structured_output: { result: "shipped" } }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await worker.scheduled({} as ScheduledEvent, env);
    devin.restore();
    expect(devin.seen.some((e) => e.startsWith("POST") && e.includes("devin-wd-done") && e.includes("/messages"))).toBe(false);
    const row = await env.DB.prepare("SELECT needs_human FROM task_item WHERE id = ?").bind(taskId).first<{ needs_human: number }>();
    expect(row?.needs_human).toBe(1);
    const evt = await env.DB.prepare("SELECT COUNT(*) AS c FROM task_event WHERE task_id = ? AND event_type = 'worker_session_ended'").bind(taskId).first<{ c: number }>();
    expect(Number(evt?.c)).toBe(1);
  });

  it("sleep endpoint sleeps the worker and stops the watchdog from waking it", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "sleep-project", name: "Sleep" }) });
    const { taskId, agentId } = await seedSpawnedTask("sleep-project", { session: "devin-sleep", account: "sleep-acct" });
    let devin = withDevin(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const slept = await call(`/api/board/tasks/${taskId}/sleep`, { method: "POST", body: JSON.stringify({}) });
    devin.restore();
    expect(slept.response.status).toBe(200);
    const agent = await env.DB.prepare("SELECT metadata_json FROM agent WHERE id = ?").bind(agentId).first<{ metadata_json: string }>();
    expect(JSON.parse(agent!.metadata_json).leader_sleep).toBe(1);
    // The watchdog now ignores this worker even if the session looks idle.
    devin = withDevin((method, url) =>
      method === "GET" && url.endsWith("devin-sleep")
        ? new Response(JSON.stringify({ status: "suspended", status_detail: "inactivity" }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await worker.scheduled({} as ScheduledEvent, env);
    devin.restore();
    expect(devin.seen.some((e) => e.includes("devin-sleep"))).toBe(false);
  });

  it("budget breaker stops spawning once the project spawn budget is consumed", async () => {
    await call("/api/board/provision", {
      method: "POST",
      body: JSON.stringify({
        project: { id: "budget-project", name: "Budget", spawn_budget_max: 1 },
        worker_profiles: [{ id: "budget-profile", name: "P", role_tag: "worker" }],
        backup_accounts: [{ id: "budget-account", role_tag: "worker", org_id: "org-budget", credential: "budget-secret" }],
      }),
    });
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({ board_id: "budget-project", title: "Over budget", worker_profile_id: "budget-profile", spawn: true }),
    });
    const taskId = String(task.body.id);
    // One spawn already consumed the budget (spawn_created events are the budget ledger).
    await env.DB.prepare(
      "INSERT INTO task_event(id, task_id, actor_agent_id, event_type, payload_json, created_at) VALUES (?, ?, NULL, 'spawn_created', ?, ?)",
    ).bind(`evt-${Math.random().toString(36).slice(2)}`, taskId, JSON.stringify({ project_id: "budget-project" }), nowForTest()).run();
    const devin = withDevin(() => new Response(JSON.stringify({ session_id: "should-not-happen" }), { status: 200 }));
    await worker.scheduled({} as ScheduledEvent, env);
    devin.restore();
    const row = await env.DB.prepare("SELECT spawn_status, needs_human FROM task_item WHERE id = ?").bind(taskId).first<{ spawn_status: string; needs_human: number }>();
    expect(row?.spawn_status).toBe("failed");
    expect(row?.needs_human).toBe(1);
    const evt = await env.DB.prepare("SELECT COUNT(*) AS c FROM task_event WHERE task_id = ? AND event_type = 'spawn_budget_exceeded'").bind(taskId).first<{ c: number }>();
    expect(Number(evt?.c)).toBe(1);
  });

  it("provisions a project, profiles, and encrypted accounts without leaking credentials", async () => {
    const result = await call("/api/board/provision", {
      method: "POST",
      body: JSON.stringify({
        project: { id: "prov-project", name: "Provisioned", spawn_budget_max: 5 },
        worker_profiles: [
          { id: "prov-dev", name: "Dev", role_tag: "developer", model: "gpt-5" },
          { id: "prov-rev", name: "Rev", role_tag: "reviewer" },
        ],
        backup_accounts: [{ id: "prov-acct", role_tag: "developer", org_id: "org-prov", credential: "prov-secret-cred" }],
        leader: { session_id: "prov-sess", name: "Prov Lead" },
      }),
    });
    expect(result.response.status).toBe(201);
    expect(JSON.stringify(result.body)).not.toContain("prov-secret-cred");
    expect(result.body.worker_profile_ids).toEqual(expect.arrayContaining(["prov-dev", "prov-rev"]));
    expect(result.body.backup_account_ids).toEqual(["prov-acct"]);
    expect(result.body.leader.role).toBe("lead");
    const stored = await env.DB.prepare("SELECT credential_ciphertext FROM backup_account WHERE id = ?").bind("prov-acct").first<{ credential_ciphertext: string }>();
    expect(stored?.credential_ciphertext).toBeTruthy();
    expect(stored?.credential_ciphertext).not.toContain("prov-secret-cred");
    const project = await env.DB.prepare("SELECT spawn_budget_max, leader_agent_id FROM project WHERE id = ?").bind("prov-project").first<{ spawn_budget_max: number; leader_agent_id: string }>();
    expect(project?.spawn_budget_max).toBe(5);
    expect(project?.leader_agent_id).toBe("lead-prov-project");
  });

  it("does not let provision move an existing backup account to another project", async () => {
    await call("/api/board/provision", {
      method: "POST",
      body: JSON.stringify({
        project: { id: "acct-owner", name: "Owner" },
        backup_accounts: [{ id: "shared-acct", role_tag: "worker", org_id: "org-owner", credential: "owner-cred" }],
      }),
    });
    const hijack = await call("/api/board/provision", {
      method: "POST",
      body: JSON.stringify({
        project: { id: "acct-attacker", name: "Attacker" },
        backup_accounts: [{ id: "shared-acct", role_tag: "worker", org_id: "org-attacker", credential: "attacker-cred" }],
      }),
    });
    expect(hijack.response.status).toBe(201);
    const stored = await env.DB.prepare(
      "SELECT project_id, org_id FROM backup_account WHERE id = ?",
    ).bind("shared-acct").first<{ project_id: string; org_id: string }>();
    expect(stored?.project_id).toBe("acct-owner");
    expect(stored?.org_id).toBe("org-owner");
  });

  it("spawn-stats reports per-profile metrics and budget usage", async () => {
    await call("/api/board/provision", {
      method: "POST",
      body: JSON.stringify({
        project: { id: "stats-project", name: "Stats", spawn_budget_max: 3 },
        worker_profiles: [{ id: "stats-profile", name: "P", role_tag: "worker" }],
      }),
    });
    await env.DB.prepare(
      "INSERT INTO task_item(id, board_id, title, description, phase, spawn_status, worker_profile_id, blocked, needs_human, created_at, updated_at) VALUES (?, 'stats-project', 'T', '', 'in_progress', 'spawned', 'stats-profile', 1, 0, ?, ?)",
    ).bind(`stats-task-${Math.random().toString(36).slice(2)}`, nowForTest(), nowForTest()).run();
    const stats = await call("/api/board/spawn-stats?project=stats-project");
    expect(stats.response.status).toBe(200);
    expect(stats.body.budget).toMatchObject({ max: 3 });
    const profile = stats.body.profiles.find((p: Record<string, unknown>) => p.worker_profile_id === "stats-profile");
    expect(profile.spawned).toBe(1);
    expect(profile.blocked).toBe(1);
    expect(profile.active).toBe(1);
  });

  it("enforces project isolation on the leader dashboard", async () => {
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "iso-a", name: "A" }) });
    await call("/api/board/projects", { method: "POST", body: JSON.stringify({ id: "iso-b", name: "B" }) });
    const agent = await call("/api/board/agents", {
      method: "POST",
      body: JSON.stringify({ id: "iso-a-lead", name: "L", project_id: "iso-a", role: "lead" }),
    });
    const token = String(agent.body.token);
    const cross = await call("/api/board/leader?project=iso-b", {}, token);
    expect(cross.response.status).toBe(403);
    const own = await call("/api/board/leader?project=iso-a", {}, token);
    expect(own.response.status).toBe(200);
  });
});
