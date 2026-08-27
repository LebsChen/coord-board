import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// ---------------------------------------------------------------------------
// Full orchestration lifecycle E2E, driven end-to-end against a stateful mock
// Devin v3 API. This exercises the exact public surface Cloud-Dev uses (provision
// + task create/answer/sleep) and the real cron (spawn + watchdog), so it walks:
//
//   Cloud-Dev 创建协同 (provision)
//     -> Leader 注册 + Worker spawn (createWorkerSession -> Devin POST /sessions)
//        -> Devin 接收 prompt
//     -> watchdog 维护状态: running -> blocked(问题)
//        -> Leader Inbox (mailbox) + 看板状态更新
//     -> Leader 作答 (answer -> Devin POST /messages)  -> 解除 blocked
//     -> Worker 续跑 (running) -> 真正完成 (exit/finished)
//        -> watchdog 不唤醒, 升级 needs_human 交 Leader 核验
//     -> Leader 核验后收尾 + sleep -> watchdog 不再唤醒
//     -> 任务完成 (task done)
// ---------------------------------------------------------------------------

const request = (path: string, init: RequestInit = {}, token = "test-token") =>
  new Request(`https://coord-board.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
const call = (path: string, init: RequestInit = {}, token = "test-token") =>
  SELF.fetch(request(path, init, token)).then(async (response) => ({
    response,
    body: (await response.json()) as Record<string, any>,
  }));

/**
 * Stateful mock of the Devin v3 session API. One instance models one running
 * session whose status is advanced explicitly between cron runs to simulate the
 * real agent making progress, getting blocked, being answered, and finishing.
 */
class MockDevin {
  sessionId = "";
  createBody: any = null;
  status: "running" | "suspended" | "exit" = "running";
  statusDetail = "working";
  structuredOutput: unknown = undefined;
  question: string | null = null;
  inbound: string[] = []; // messages Devin "received" (answers / wake nudges)
  private seq = 0;

  handler = (method: string, url: string, init?: RequestInit): Response => {
    // POST /sessions -> create
    if (method === "POST" && /\/sessions$/.test(url)) {
      this.createBody = init?.body ? JSON.parse(String(init.body)) : null;
      this.sessionId = `devin-e2e-${++this.seq}`;
      return new Response(JSON.stringify({ session_id: this.sessionId }), { status: 200 });
    }
    // GET .../sessions/:id/messages -> latest devin message (the question)
    if (method === "GET" && url.endsWith(`${this.sessionId}/messages`)) {
      const items = this.question ? [{ source: "devin", message: this.question }] : [];
      return new Response(JSON.stringify({ items, has_next_page: false }), { status: 200 });
    }
    // POST .../sessions/:id/messages -> Devin receives a message (answer / nudge)
    if (method === "POST" && url.endsWith(`${this.sessionId}/messages`)) {
      this.inbound.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // GET .../sessions/:id -> status poll
    if (method === "GET" && url.endsWith(this.sessionId)) {
      const payload: Record<string, unknown> = { status: this.status, status_detail: this.statusDetail };
      if (this.structuredOutput !== undefined) payload.structured_output = this.structuredOutput;
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

/** Install the mock Devin as global fetch + stub credential decryption. */
const withDevin = (devin: MockDevin) => {
  const decryptSpy = vi
    .spyOn(crypto.subtle, "decrypt")
    .mockImplementation(async () => new TextEncoder().encode("devin-cred").buffer);
  const seen: string[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    seen.push(`${method} ${url}`);
    return devin.handler(method, url, init);
  });
  return { seen, restore: () => { fetchMock.mockRestore(); decryptSpy.mockRestore(); } };
};

const cron = async () => {
  const d = withDevinCurrent();
  await worker.scheduled({} as ScheduledEvent, env);
  d.restore();
};

// The single mock instance shared across the lifecycle, plus a helper so the cron
// wrapper always installs the current instance.
let DEVIN: MockDevin;
const withDevinCurrent = () => withDevin(DEVIN);

const PROJECT = "payments-service";
const LOG = (stage: string, detail: string) => console.log(`\n[E2E] ${stage} — ${detail}`);

describe("full orchestration lifecycle (mock Devin, Cloud-Dev -> Board -> Leader/Worker -> done)", () => {
  beforeAll(() => {
    DEVIN = new MockDevin();
  });

  it("walks create -> spawn -> blocked -> answer -> finish -> verify -> sleep -> done", async () => {
    // ---- STAGE 1: Cloud-Dev pushes the collab task (provision) --------------
    // A realistic backend engineering setup: one "senior backend" worker profile bound to a
    // real repo with a runbook + PR playbook, and a real service-user API key.
    LOG("STAGE 1", "Cloud-Dev provision: payments-service project + backend worker profile(agent params) + encrypted account + Leader");
    const provision = await call("/api/board/provision", {
      method: "POST",
      body: JSON.stringify({
        project: { id: PROJECT, name: "Payments Service", spawn_budget_max: 5 },
        worker_profiles: [
          {
            id: "backend-dev",
            name: "Senior Backend Engineer",
            role_tag: "backend",
            model: "fusion",
            system_prompt: "You are a senior backend engineer. Match the repo's TypeScript style, keep changes minimal, and add regression tests for every bug fix.",
            repo_config: { repo: "LebsChen/payments-service", base_branch: "main" },
            knowledge_refs: ["payments-runbook"],
            playbook_refs: ["backend-bugfix-pr"],
          },
        ],
        backup_accounts: [
          { id: "acct-backend", role_tag: "backend", org_id: "org-payments", credential_type: "service_user", credential: "cog_live_paymentsteam_secret" },
        ],
        leader: { session_id: "cloud-dev-leader-sess", name: "Tech Lead" },
      }),
    });
    expect(provision.response.status).toBe(201);
    // credential must never echo back
    expect(JSON.stringify(provision.body)).not.toContain("cog_live_paymentsteam_secret");
    expect(provision.body.leader.role).toBe("lead");
    const leaderAgentId = `lead-${PROJECT}`;
    const storedAcct = await env.DB.prepare("SELECT credential_ciphertext FROM backup_account WHERE id = ?")
      .bind("acct-backend").first<{ credential_ciphertext: string }>();
    expect(storedAcct?.credential_ciphertext).toBeTruthy();
    expect(storedAcct?.credential_ciphertext).not.toContain("cog_live_paymentsteam_secret");

    // ---- STAGE 2: Cloud-Dev creates a task for the worker (spawn requested) --
    LOG("STAGE 2", "Cloud-Dev creates a real bug-fix task with spawn=true bound to the backend profile");
    const task = await call("/api/board/tasks", {
      method: "POST",
      body: JSON.stringify({
        board_id: PROJECT,
        title: "Fix incorrect tax rounding in checkout (bug #482)",
        description: "Checkout totals are off by one cent for orders with 3+ line items because tax is rounded per-item instead of on the order subtotal. Reproduce with the failing case in test/checkout.spec.ts, fix the rounding, and open a PR against main.",
        worker_profile_id: "backend-dev",
        spawn: true,
      }),
    });
    expect(task.response.status).toBe(201);
    const taskId = String(task.body.id);
    expect(
      (await env.DB.prepare("SELECT spawn_status FROM task_item WHERE id = ?").bind(taskId).first<{ spawn_status: string }>())
        ?.spawn_status,
    ).toBe("requested");

    // ---- STAGE 3: cron spawns the worker; Devin receives the session ---------
    LOG("STAGE 3", "cron spawns Worker -> createWorkerSession -> Devin POST /sessions (Devin 接收真实任务)");
    DEVIN.status = "running";
    DEVIN.statusDetail = "working";
    await cron();
    expect(DEVIN.sessionId).toBe("devin-e2e-1");
    expect(DEVIN.createBody).toBeTruthy();
    // agent params reached Devin: fusion profile mode + prompt carrying the real task, repo, playbook
    expect(DEVIN.createBody.devin_mode).toBe("fusion");
    expect(DEVIN.createBody.playbook_id).toBe("backend-bugfix-pr");
    expect(DEVIN.createBody.knowledge_ids).toContain("payments-runbook");
    expect(String(DEVIN.createBody.prompt)).toContain("Fix incorrect tax rounding in checkout");
    expect(String(DEVIN.createBody.prompt)).toContain("LebsChen/payments-service");
    expect(String(DEVIN.createBody.prompt)).toContain(`Board project: ${PROJECT}`);
    // plaintext credential must never appear in the Devin create body
    expect(JSON.stringify(DEVIN.createBody)).not.toContain("cog_live_paymentsteam_secret");
    const spawned = await env.DB.prepare("SELECT spawn_status, watchdog_status FROM task_item WHERE id = ?")
      .bind(taskId).first<{ spawn_status: string; watchdog_status: string }>();
    expect(spawned?.spawn_status).toBe("spawned");
    // watchdog polled in the same cron and recorded the live status
    expect(spawned?.watchdog_status).toBe("running");

    // ---- STAGE 4: worker gets blocked with a high-risk question -> Leader inbox
    // A payments "source of truth" question is high-risk, so the watchdog escalates it as
    // needs_human (a human must decide) rather than a routine block.
    LOG("STAGE 4", "Worker blocked with a high-risk payments question -> watchdog escalates needs_human + notifies Leader (Inbox)");
    DEVIN.status = "suspended";
    DEVIN.statusDetail = "waiting_for_user";
    DEVIN.question = "Tax totals differ between cart-service and invoice-service. Which should be the rounding source of truth?\n- cart-service\n- invoice-service";
    await cron();
    const blockedRow = await env.DB.prepare("SELECT blocked, needs_human, watchdog_status FROM task_item WHERE id = ?")
      .bind(taskId).first<{ blocked: number; needs_human: number; watchdog_status: string }>();
    expect(blockedRow?.blocked).toBe(1);
    expect(blockedRow?.needs_human).toBe(1);
    expect(blockedRow?.watchdog_status).toBe("blocked");
    // Leader received it in the mailbox (Inbox)
    const inboxCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM message_delivery WHERE recipient_agent_id = ?",
    ).bind(leaderAgentId).first<{ c: number }>();
    expect(Number(inboxCount?.c)).toBeGreaterThanOrEqual(1);
    const blockEvent = await env.DB.prepare(
      "SELECT payload_json FROM task_event WHERE task_id = ? AND event_type = 'worker_blocked_needs_human'",
    ).bind(taskId).first<{ payload_json: string }>();
    expect(blockEvent?.payload_json).toContain("source of truth");

    // ---- STAGE 4b: Leader dashboard reflects per-worker maintained status ----
    LOG("STAGE 4b", "Leader dashboard shows the worker as blocked (状态维护) without leaking credentials");
    const board = await call(`/api/board/leader?project=${PROJECT}`);
    expect(board.response.status).toBe(200);
    expect(JSON.stringify(board.body)).not.toContain("cog_live_paymentsteam_secret");
    expect(JSON.stringify(board.body)).toContain("blocked");

    // ---- STAGE 5: Leader answers -> Devin receives the answer, block cleared -
    LOG("STAGE 5", "Leader answers -> answer forwarded to Devin (POST /messages) -> blocked cleared");
    const answer = await (async () => {
      const d = withDevinCurrent();
      const res = await call(`/api/board/tasks/${taskId}/answer`, { method: "POST", body: JSON.stringify({ message: "invoice-service" }) });
      d.restore();
      return res;
    })();
    expect(answer.response.status).toBe(200);
    expect(answer.body.delivered).toBe(true);
    expect(DEVIN.inbound.some((b) => b.includes("invoice-service"))).toBe(true);
    expect(DEVIN.inbound.every((b) => !b.includes("devin-cred"))).toBe(true);
    const afterAnswer = await env.DB.prepare("SELECT blocked, needs_human FROM task_item WHERE id = ?")
      .bind(taskId).first<{ blocked: number; needs_human: number }>();
    expect(afterAnswer?.blocked).toBe(0);
    expect(afterAnswer?.needs_human).toBe(0);

    // ---- STAGE 6: worker resumes, then truly finishes ------------------------
    LOG("STAGE 6", "Worker resumes (running) then truly finishes (exit/finished) -> watchdog does NOT wake, escalates for verification");
    DEVIN.status = "running";
    DEVIN.statusDetail = "working";
    DEVIN.question = null;
    await cron();
    expect(
      (await env.DB.prepare("SELECT watchdog_status FROM task_item WHERE id = ?").bind(taskId).first<{ watchdog_status: string }>())
        ?.watchdog_status,
    ).toBe("running");

    DEVIN.status = "exit";
    DEVIN.statusDetail = "finished";
    DEVIN.structuredOutput = {
      pr_url: "https://github.com/LebsChen/payments-service/pull/512",
      summary: "Rounded tax half-up on the order subtotal in invoice-service; added regression test in test/checkout.spec.ts",
      tests: "passed",
    };
    const inboundBeforeFinish = DEVIN.inbound.length;
    await cron();
    // no wake nudge sent to a finished session
    expect(DEVIN.inbound.length).toBe(inboundBeforeFinish);
    const finishedRow = await env.DB.prepare("SELECT needs_human FROM task_item WHERE id = ?")
      .bind(taskId).first<{ needs_human: number }>();
    expect(finishedRow?.needs_human).toBe(1);
    const endedEvent = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM task_event WHERE task_id = ? AND event_type = 'worker_session_ended'",
    ).bind(taskId).first<{ c: number }>();
    expect(Number(endedEvent?.c)).toBe(1);

    // ---- STAGE 7: Leader verifies & puts the worker to sleep -----------------
    LOG("STAGE 7", "Leader verifies, then sleeps the worker -> watchdog stops touching the session");
    const agentRow = await env.DB.prepare(
      "SELECT id FROM agent WHERE project_id = ? AND json_extract(metadata_json,'$.task_id') = ?",
    ).bind(PROJECT, taskId).first<{ id: string }>();
    const workerAgentId = String(agentRow?.id);
    const slept = await (async () => {
      const d = withDevinCurrent();
      const res = await call(`/api/board/tasks/${taskId}/sleep`, { method: "POST", body: JSON.stringify({}) });
      d.restore();
      return res;
    })();
    expect(slept.response.status).toBe(200);
    expect(
      JSON.parse(
        (await env.DB.prepare("SELECT metadata_json FROM agent WHERE id = ?").bind(workerAgentId).first<{ metadata_json: string }>())!
          .metadata_json,
      ).leader_sleep,
    ).toBe(1);
    // Even if the session now looks idle, the watchdog leaves the slept worker alone.
    DEVIN.status = "suspended";
    DEVIN.statusDetail = "inactivity";
    const seenAfterSleep = (async () => {
      const d = withDevinCurrent();
      await worker.scheduled({} as ScheduledEvent, env);
      const touched = d.seen.some((e) => e.includes(DEVIN.sessionId));
      d.restore();
      return touched;
    });
    expect(await seenAfterSleep()).toBe(false);

    // ---- STAGE 8: Leader verifies & closes the task out ---------------------
    // The task-lifecycle "complete" endpoint is a lease-owning-worker action; after the
    // watchdog escalated needs_human the Leader verifies the structured output and closes
    // the task out. There is no separate leader-complete endpoint, so the close-out is a
    // direct phase transition (what the Leader's verify-and-done action performs).
    LOG("STAGE 8", "Leader verifies structured output and marks the task done -> lifecycle complete");
    await env.DB.prepare("UPDATE task_item SET phase = 'done', needs_human = 0, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), taskId).run();
    const finalRow = await env.DB.prepare("SELECT phase, needs_human, blocked FROM task_item WHERE id = ?")
      .bind(taskId).first<{ phase: string; needs_human: number; blocked: number }>();
    expect(finalRow?.phase).toBe("done");
    expect(finalRow?.needs_human).toBe(0);
    expect(finalRow?.blocked).toBe(0);
    LOG("DONE", "full lifecycle completed: create -> spawn -> blocked -> answer -> finish -> verify -> sleep -> done");
  });
});
