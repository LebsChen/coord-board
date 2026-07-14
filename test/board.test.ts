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
});
