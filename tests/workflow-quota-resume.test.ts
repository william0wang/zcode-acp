/**
 * Workflow quota auto-resume watchdog tests (src/workflow/quota-resume.ts).
 *
 * The watchdog is driven against a FakeBackend that scripts the two reads
 * (workflows/runs journal, v4/conversation/workflowRuns summaries) and the
 * resume command; the store is the hermetic-HOME temp dir (never the real
 * ~/.zcode/v2). Timers are fake; fire() is called directly instead of waiting
 * on them.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import type * as acp from "@agentclientprotocol/sdk";

import {
  armQuotaResumeWatchdog,
  fire,
  hasQuotaResumePendingForCwd,
  quotaResumeEntryForTest,
  quotaResumePending,
  resetQuotaResumeForTest,
  scanQuotaStoppedRuns,
  scheduleQuotaResume,
  updateQuotaResumeEntryForTest,
} from "../src/workflow/quota-resume.js";
import { ZcodeAcpServer } from "../src/server.js";
import type { QuotaResult } from "../src/quota/types.js";
import { resetPushSenderForTests } from "../src/push/push.js";

vi.mock("../src/crash-guards.js", async (orig) => {
  const actual = await orig<typeof import("../src/crash-guards.js")>();
  return { ...actual, appendDiary: () => undefined };
});

const CWD = "/proj/quota";

class FakeBackend {
  isDead = false;
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** workflows/runs rows. */
  journalRuns: unknown[] = [];
  /** v4/conversation/workflowRuns summaries keyed by sessionId. */
  summariesBySession = new Map<string, unknown[]>();
  /** v4/command handling: "accepted" | {error status}. */
  commandResult: unknown = { status: "accepted", result: {} };
  commandCalls: Array<Record<string, unknown>> = [];

  async request(
    id: number,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{ id: number; result?: unknown; error?: { code?: number; message: string } }> {
    this.calls.push({ method, params });
    if (method === "workflows/runs") return { id, result: { runs: this.journalRuns } };
    if (method === "v4/conversation/workflowRuns") {
      const sid = String(params["sessionId"]);
      return { id, result: { runs: this.summariesBySession.get(sid) ?? [] } };
    }
    if (method === "v4/command") {
      this.commandCalls.push(params);
      return { id, result: this.commandResult };
    }
    return { id, result: {} };
  }
}

function makeServer(): { server: ZcodeAcpServer; backend: FakeBackend; notes: string[] } {
  const notes: string[] = [];
  const server = new ZcodeAcpServer();
  server.registerSession("sess_acp", "sess_z1");
  server.sessionCwds.set("sess_acp", CWD);
  // Settled enabled gate + live-session marker: resumeWorkflowRun's session
  // resolution runs the real ensureRealSession, which must not attempt a
  // backend reload flight against the fake.
  server.backendWorkflowGate = Promise.resolve({
    enabled: true,
    mode: "onDemand",
    source: "remote",
  });
  server.markBackendLoaded("sess_acp");
  server.clients.add({
    notify(_method: string, params: { update?: { content?: { text?: string } } }) {
      const text = params?.update?.content?.text;
      if (typeof text === "string") notes.push(text);
      return Promise.resolve();
    },
    request: () => Promise.resolve({}),
  } as unknown as acp.AgentContext);
  const backend = new FakeBackend();
  server.backend = backend as unknown as ZcodeAcpServer["backend"];
  return { server, backend, notes };
}

const stoppedByQuota = (extra: Record<string, unknown> = {}) => ({
  runId: "run_q1",
  name: "nightly",
  status: "stopped",
  stopReason: "provider",
  parentSessionId: "sess_z1",
  updatedAt: Date.now(),
  ...extra,
});

const quotaSummary = (extra: Record<string, unknown> = {}) => ({
  runId: "run_q1",
  label: "nightly",
  status: "stopped",
  stopReason: "provider",
  failureCode: "ProviderStop",
  failureMessage: "Subagent a hit a permanent model-side error (rate_limited [1308]): cap",
  resumable: true,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ZCODE_ACP_LANG", "en");
  resetQuotaResumeForTest();
});

afterEach(() => {
  resetQuotaResumeForTest();
  resetPushSenderForTests();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("scanQuotaStoppedRuns", () => {
  it("schedules a quota-stopped run (journal stopReason + summary failureMessage)", async () => {
    const { server, backend } = makeServer();
    backend.journalRuns = [stoppedByQuota()];
    backend.summariesBySession.set("sess_z1", [quotaSummary()]);

    await scanQuotaStoppedRuns(server);

    const entry = quotaResumeEntryForTest("run_q1")!;
    expect(entry.zcodeSid).toBe("sess_z1");
    expect(entry.cwd).toBe(CWD);
    expect(entry.name).toBe("nightly");
    expect(entry.attempts).toBe(0);
    expect(quotaResumePending("run_q1")).toBe(true);
  });

  it("ignores provider stops that are not quota (auth) and non-stopped rows", async () => {
    const { server, backend } = makeServer();
    backend.journalRuns = [
      stoppedByQuota(),
      stoppedByQuota({ runId: "run_done", status: "completed" }),
      stoppedByQuota({ runId: "run_user", stopReason: "user" }),
    ];
    backend.summariesBySession.set("sess_z1", [
      quotaSummary({ runId: "run_q1", failureMessage: "auth_failed [401]: sign in again" }),
      quotaSummary({ runId: "run_done" }),
      quotaSummary({ runId: "run_user" }),
    ]);

    await scanQuotaStoppedRuns(server);
    expect(quotaResumePending("run_q1")).toBe(false);
    expect(backend.calls.some((c) => c.method === "v4/conversation/workflowRuns")).toBe(true);
  });

  it("skips a run that is not resumable or already scheduled", async () => {
    const { server, backend } = makeServer();
    backend.journalRuns = [stoppedByQuota()];
    backend.summariesBySession.set("sess_z1", [quotaSummary({ resumable: false })]);
    await scanQuotaStoppedRuns(server);
    expect(quotaResumePending("run_q1")).toBe(false);

    // Already scheduled → a second scan is a no-op (no duplicate RPC rows).
    backend.summariesBySession.set("sess_z1", [quotaSummary()]);
    await scheduleQuotaResume(server, { runId: "run_q1", zcodeSid: "sess_z1", cwd: CWD });
    const before = backend.calls.length;
    await scanQuotaStoppedRuns(server);
    const after = backend.calls
      .slice(before)
      .filter((c) => c.method === "v4/conversation/workflowRuns");
    expect(after).toHaveLength(0);
  });

  it("never spawns a backend and does nothing before a backend exists", async () => {
    const { server, backend } = makeServer();
    server.backend = null;
    await scanQuotaStoppedRuns(server);
    expect(backend.calls).toHaveLength(0);
    expect(quotaResumePending("run_q1")).toBe(false);
  });

  it("respects the workflow gate verdict (disabled = no scan)", async () => {
    const { server, backend } = makeServer();
    server.backendWorkflowGate = Promise.resolve({
      enabled: false,
      mode: "disabled",
      source: "remote",
    });
    backend.journalRuns = [stoppedByQuota()];
    backend.summariesBySession.set("sess_z1", [quotaSummary()]);
    await scanQuotaStoppedRuns(server);
    expect(quotaResumePending("run_q1")).toBe(false);
  });

  it("respects quota.autoResume=false", async () => {
    vi.stubEnv("ZCODE_ACP_QUOTA_AUTO_RESUME", "0");
    const { server, backend } = makeServer();
    backend.journalRuns = [stoppedByQuota()];
    backend.summariesBySession.set("sess_z1", [quotaSummary()]);
    await scanQuotaStoppedRuns(server);
    expect(quotaResumePending("run_q1")).toBe(false);
  });
});

describe("fire", () => {
  const quotaOk = (): Promise<QuotaResult> =>
    Promise.resolve({
      kind: "success",
      level: "pro",
      items: [
        { key: "token_5h", label: "5h", usedPercent: 10, leftPercent: 90 },
        { key: "token_week", label: "week", usedPercent: 40, leftPercent: 60 },
      ],
    });

  const quotaExhausted = (resetInMs: number): Promise<QuotaResult> =>
    Promise.resolve({
      kind: "success",
      level: "pro",
      items: [
        {
          key: "token_5h",
          label: "5h",
          usedPercent: 100,
          leftPercent: 0,
          nextResetTime: Date.now() + resetInMs,
        },
      ],
    });

  async function armed(server: ZcodeAcpServer, backend: FakeBackend) {
    backend.journalRuns = [stoppedByQuota()];
    backend.summariesBySession.set("sess_z1", [quotaSummary()]);
    await scanQuotaStoppedRuns(server);
    // Make it due now (the scan armed it in the future).
    updateQuotaResumeEntryForTest("run_q1", { resumeAt: Date.now() - 1 });
    return quotaResumeEntryForTest("run_q1")!;
  }

  it("does not double-fire when another LIVE bridge holds the fire claim", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    // A sibling bridge (pid 1 = launchd, effectively always alive) is mid-fire.
    updateQuotaResumeEntryForTest("run_q1", {
      resumeAt: Date.now() - 1,
      firing: { pid: 1, at: Date.now() },
    });

    await fire(server, "run_q1", { queryQuota: quotaOk });

    expect(backend.commandCalls).toHaveLength(0);
    // The sibling's claim survives untouched — its outcome is the truth.
    expect(quotaResumeEntryForTest("run_q1")!.firing?.pid).toBe(1);
  });

  it("takes over a STALE foreign claim (dead holder)", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    updateQuotaResumeEntryForTest("run_q1", {
      resumeAt: Date.now() - 1,
      firing: { pid: 999_999_999, at: Date.now() - 60 * 60_000 },
    });

    await fire(server, "run_q1", { queryQuota: quotaOk });

    expect(backend.commandCalls).toHaveLength(1);
    const entry = quotaResumeEntryForTest("run_q1")!;
    expect(entry.firing).toBeUndefined();
    expect(entry.awaitingVerify).toBe(true);
  });

  it("resumes the stopped run once the quota card shows no future reset", async () => {
    const { server, backend, notes } = makeServer();
    await armed(server, backend);

    await fire(server, "run_q1", { queryQuota: quotaOk });

    expect(backend.commandCalls).toHaveLength(1);
    expect(backend.commandCalls[0]).toMatchObject({
      type: "resumeWorkflowRun",
      sessionId: "sess_z1",
      payload: { workId: "run_q1" },
    });
    // Entry kept for the verify pass; the user got one announcement.
    const entry = quotaResumeEntryForTest("run_q1")!;
    expect(entry.awaitingVerify).toBe(true);
    expect(notes.some((n) => n.includes("resumed automatically"))).toBe(true);
  });

  it("defers without consuming an attempt while a future reset is known", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);

    await fire(server, "run_q1", { queryQuota: () => quotaExhausted(3_600_000) });

    expect(backend.commandCalls).toHaveLength(0);
    const entry = quotaResumeEntryForTest("run_q1")!;
    expect(entry.attempts).toBe(0);
    expect(entry.resumeAt).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it("drops the entry when the run is already running again", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    backend.summariesBySession.set("sess_z1", [quotaSummary({ status: "running" })]);

    await fire(server, "run_q1", { queryQuota: quotaOk });

    expect(backend.commandCalls).toHaveLength(0);
    expect(quotaResumeEntryForTest("run_q1")).toBeUndefined();
  });

  it("drops the entry when the run finished or stopped being resumable", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    backend.summariesBySession.set("sess_z1", [quotaSummary({ status: "completed" })]);
    await fire(server, "run_q1", { queryQuota: quotaOk });
    expect(quotaResumeEntryForTest("run_q1")).toBeUndefined();
  });

  it("counts a verify miss as a failed attempt and backs off", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    await fire(server, "run_q1", { queryQuota: quotaOk });
    // The run stopped again by the verify pass — no future reset known.
    updateQuotaResumeEntryForTest("run_q1", { resumeAt: Date.now() - 1 });

    await fire(server, "run_q1", { queryQuota: quotaOk });

    const entry = quotaResumeEntryForTest("run_q1")!;
    expect(entry.attempts).toBe(1);
    expect(entry.awaitingVerify).toBeFalsy();
    expect(entry.resumeAt).toBeGreaterThan(Date.now());
  });

  it("retires a permanently-rejected run (never re-scheduled by the scan)", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    backend.commandResult = {
      status: "rejected",
      reasonCode: "fault.command.workflowRunResumeRejected.not_resumable",
    };
    await fire(server, "run_q1", { queryQuota: quotaOk });
    const retired = quotaResumeEntryForTest("run_q1")!;
    expect(retired.gaveUp).toBeDefined();
    expect(quotaResumePending("run_q1")).toBe(false);
    // A later scan of the same (still quota-stopped) journal row must NOT
    // re-schedule it — that would be a give-up/retry loop.
    await scanQuotaStoppedRuns(server);
    expect(quotaResumeEntryForTest("run_q1")!.gaveUp).toBeDefined();
    expect(quotaResumePending("run_q1")).toBe(false);

    // A FRESH schedule (an explicit new detection) lifts the give-up, and a
    // session_busy rejection keeps the entry with a short retry.
    await scheduleQuotaResume(server, { runId: "run_q1", zcodeSid: "sess_z1", cwd: CWD });
    updateQuotaResumeEntryForTest("run_q1", { resumeAt: Date.now() - 1 });
    backend.commandResult = {
      status: "rejected",
      reasonCode: "fault.command.workflowRunResumeRejected.session_busy",
    };
    await fire(server, "run_q1", { queryQuota: quotaOk });
    const entry = quotaResumeEntryForTest("run_q1")!;
    expect(entry.attempts).toBe(0);
    expect(entry.resumeAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1);
  });

  it("retires a script_missing rejection as permanent (no retry ladder)", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    backend.commandResult = {
      status: "rejected",
      reasonCode: "fault.command.workflowRunResumeRejected.script_missing",
    };
    await fire(server, "run_q1", { queryQuota: quotaOk });
    const retired = quotaResumeEntryForTest("run_q1")!;
    expect(retired.gaveUp).toBeDefined();
    expect(retired.attempts).toBe(0);
  });

  it("drops the entry when the run is already running elsewhere (already_running)", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    backend.commandResult = {
      status: "rejected",
      reasonCode: "fault.command.workflowRunResumeRejected.already_running",
    };
    await fire(server, "run_q1", { queryQuota: quotaOk });
    // Not a failure of ours — someone else resumed it; the entry is done.
    expect(quotaResumeEntryForTest("run_q1")).toBeUndefined();
    expect(quotaResumePending("run_q1")).toBe(false);
  });

  it("retries (never retires) when the gate verdict is unresolved", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    // Fail-closed gate fetch: mode=unknown is cached for the process
    // generation — a transient network blip must not retire the resume.
    server.backendWorkflowGate = Promise.resolve({
      mode: "unknown",
      enabled: false,
      source: "default",
    });
    await fire(server, "run_q1", { queryQuota: quotaOk });
    const entry = quotaResumeEntryForTest("run_q1")!;
    expect(entry.gaveUp).toBeUndefined();
    expect(entry.attempts).toBe(1);
  });

  it("retires a real disabled verdict as permanent", async () => {
    const { server, backend } = makeServer();
    await armed(server, backend);
    server.backendWorkflowGate = Promise.resolve({
      mode: "disabled",
      enabled: false,
      source: "remote",
    });
    await fire(server, "run_q1", { queryQuota: quotaOk });
    expect(quotaResumeEntryForTest("run_q1")!.gaveUp).toBeDefined();
  });

  it("is a no-op for an unknown runId", async () => {
    const { server, backend } = makeServer();
    await fire(server, "run_missing", { queryQuota: quotaOk });
    expect(backend.commandCalls).toHaveLength(0);
  });
});

describe("armQuotaResumeWatchdog", () => {
  it("re-arms entries of its own cwd and exposes the idle-exit predicate", async () => {
    const { server } = makeServer();
    await scheduleQuotaResume(server, {
      runId: "run_q1",
      zcodeSid: "sess_z1",
      cwd: CWD,
      resetAt: Date.now() + 60_000,
    });
    expect(hasQuotaResumePendingForCwd(CWD)).toBe(true);
    expect(hasQuotaResumePendingForCwd("/other")).toBe(false);
    armQuotaResumeWatchdog(server);
    expect(hasQuotaResumePendingForCwd(CWD)).toBe(true);
  });

  it("keeps a future-dated entry beyond the age TTL, but prunes an overdue abandoned one", async () => {
    const { server } = makeServer();
    await scheduleQuotaResume(server, {
      runId: "run_weekly",
      zcodeSid: "sess_z1",
      cwd: CWD,
      resetAt: Date.now() + 7 * 24 * 60 * 60_000,
    });
    await scheduleQuotaResume(server, { runId: "run_stale", zcodeSid: "sess_z1", cwd: CWD });
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60_000;
    updateQuotaResumeEntryForTest("run_weekly", { updatedAt: eightDaysAgo });
    updateQuotaResumeEntryForTest("run_stale", {
      resumeAt: eightDaysAgo,
      updatedAt: eightDaysAgo,
    });

    // The weekly wait survives its age; the abandoned overdue entry is gone.
    expect(quotaResumeEntryForTest("run_weekly")).toBeDefined();
    expect(quotaResumeEntryForTest("run_stale")).toBeUndefined();
  });
});
