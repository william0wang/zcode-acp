/**
 * pushIfOffline gating + payload derivation (push-backend-requirements §4/§5):
 * nothing fires when push is inactive or a client is online; offline + ACTIVE
 * renders the contracted `[kind] title\nbody` text; minimal strips bodies;
 * the interaction hook derives permission/question payloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basename } from "node:path";

const h = vi.hoisted(() => ({
  cfg: null as {
    contentDetail: "full" | "minimal";
    notify?: Record<string, boolean>;
    quietMs?: number;
    askDelayMs?: number;
    permissionAskDelayMs?: number;
  } | null,
  diary: [] as string[],
}));
vi.mock("../src/push/config.js", async (orig) => {
  const actual = await orig<typeof import("../src/push/config.js")>();
  return {
    ...actual,
    pushActive: () => h.cfg !== null,
    pushConfig: () => h.cfg,
  };
});
vi.mock("../src/crash-guards.js", async (orig) => {
  const actual = await orig<typeof import("../src/crash-guards.js")>();
  return {
    ...actual,
    appendDiary: (line: string) => h.diary.push(line),
  };
});

const {
  armAskWatchdog,
  clearAskWatchdog,
  noteUserActivity,
  pushIfOffline,
  pushInteractionIfOffline,
  pushSettled,
  resetAskWatchdogForTests,
  resetPushSenderForTests,
  sendTestPush,
  setPushSenderForTests,
} = await import("../src/push/push.js");
const { ZcodeAcpServer } = await import("../src/server.js");

// pushSourceLabel on a bare server falls back to basename(process.cwd()).
const PROJ = basename(process.cwd());

const sent: string[] = [];

beforeEach(() => {
  h.cfg = null;
  h.diary.length = 0;
  sent.length = 0;
  resetAskWatchdogForTests();
  setPushSenderForTests({
    sendText: async (c) => {
      sent.push(c);
    },
  });
});

afterEach(() => {
  // keep the injected sender from leaking into other test files
  resetPushSenderForTests();
});

describe("pushIfOffline gating", () => {
  it("never sends while a client is online", () => {
    h.cfg = { contentDetail: "full" };
    const server = new ZcodeAcpServer();
    server.clients.add({ notify: async () => {}, request: async () => undefined });
    pushIfOffline(server, { kind: "task", title: "T" });
    expect(sent).toEqual([]);
  });

  it("sends the contracted text when offline + ACTIVE", () => {
    h.cfg = { contentDetail: "full" };
    const server = new ZcodeAcpServer();
    pushIfOffline(server, { kind: "run", title: "Workflow deploy", body: "run settled: ok" });
    expect(sent).toEqual(["[run] Workflow deploy\nrun settled: ok"]);
  });

  it("swallows sender failures (fire-and-forget)", async () => {
    h.cfg = { contentDetail: "full" };
    setPushSenderForTests({
      sendText: async () => {
        throw new Error("wecom down");
      },
    });
    const server = new ZcodeAcpServer();
    expect(() => pushIfOffline(server, { kind: "task", title: "T" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 10)); // let the rejection warn, not crash
  });
});

describe("pushSettled (§5.2 — settled events ignore client presence)", () => {
  const NOTIFY_ALL = { turn: true, goal: true, run: true, task: true, compact: true };

  it("sends even while a client is online", () => {
    h.cfg = { contentDetail: "full", notify: NOTIFY_ALL };
    const server = new ZcodeAcpServer();
    server.clients.add({ notify: async () => {}, request: async () => undefined });
    pushSettled(server, { kind: "turn", title: "turn completed" });
    expect(sent).toEqual(["[turn] turn completed"]);
  });
});

describe("pushSettled quiet window (§5.2 — user active ⇒ no ping)", () => {
  const NOTIFY_ALL = { turn: true, goal: true, run: true, task: true, compact: true };

  it("suppresses a settle inside the window after user activity, and diaries why", () => {
    h.cfg = { contentDetail: "full", notify: NOTIFY_ALL, quietMs: 30_000 };
    const server = new ZcodeAcpServer();
    noteUserActivity(server);
    pushSettled(server, { kind: "turn", title: "turn completed" });
    expect(sent).toEqual([]);
    expect(h.diary).toHaveLength(1);
    expect(h.diary[0]).toContain(`push: turn "turn completed" suppressed`);
  });
});

describe("pushInteractionIfOffline (§5.1)", () => {
  it("derives permission with the toolCall title as body", () => {
    h.cfg = { contentDetail: "full", notify: { ask: true } };
    const server = new ZcodeAcpServer();
    pushInteractionIfOffline(server, "session/request_permission", {
      sessionId: "s1",
      toolCall: { title: "Bash: npm install" },
      options: [],
    });
    expect(sent).toEqual([`[${PROJ}] Approval requested\nBash: npm install`]);
  });
});

describe("unanswered-ask watchdog (§5.1 v1.3 — connected-but-away)", () => {
  const PERMISSION = "session/request_permission";
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("pushes an ask still pending after askDelayMs even with a client CONNECTED", async () => {
    h.cfg = {
      contentDetail: "full",
      notify: { ask: true },
      askDelayMs: 20,
      permissionAskDelayMs: 20,
    };
    const server = new ZcodeAcpServer();
    server.clients.add({ notify: async () => {}, request: async () => undefined });
    void server; // presence is irrelevant for the watchdog — the delay is the grace
    armAskWatchdog(PERMISSION, { toolCall: { title: "Bash: npm install" } });
    await tick(50);
    expect(sent).toEqual(["[permission] Approval requested\nBash: npm install"]);
    clearAskWatchdog();
  });

  it("coalesces concurrent asks into ONE notification until all settle", async () => {
    h.cfg = {
      contentDetail: "full",
      notify: { ask: true },
      askDelayMs: 20,
      permissionAskDelayMs: 20,
    };
    armAskWatchdog(PERMISSION, { toolCall: { title: "one" } });
    armAskWatchdog("elicitation/create", { message: "two" });
    armAskWatchdog(PERMISSION, { toolCall: { title: "three" } });
    await tick(50);
    expect(sent).toEqual(["[permission] Approval requested\none"]);
    clearAskWatchdog(); // one settles — the slot stays held for the rest
    armAskWatchdog(PERMISSION, { toolCall: { title: "late ask" } });
    await tick(50);
    expect(sent).toHaveLength(1); // still coalesced
    clearAskWatchdog();
    clearAskWatchdog();
    clearAskWatchdog(); // all settled — slot reset
    armAskWatchdog("elicitation/create", { message: "next round" });
    await tick(50);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe("[question] Agent question\nnext round");
    clearAskWatchdog();
  });
});

describe("sendTestPush (§7)", () => {
  it("sends regardless of client presence and reports the count", async () => {
    h.cfg = { contentDetail: "full" };
    const r = await sendTestPush("Hi");
    expect(r).toEqual({ ok: true, sent: 1 });
    expect(sent).toEqual(["[test] Hi"]);
  });
});
