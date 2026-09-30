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
  pushSourceLabel,
  renderPushContent,
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
  it("never sends while push is inactive", () => {
    const server = new ZcodeAcpServer();
    pushIfOffline(server, { kind: "test", title: "T" });
    expect(sent).toEqual([]);
  });

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

  it("strips bodies under contentDetail minimal", () => {
    h.cfg = { contentDetail: "minimal" };
    const server = new ZcodeAcpServer();
    pushIfOffline(server, {
      kind: "permission",
      title: "Approval requested",
      body: "Bash: rm -rf",
    });
    expect(sent).toEqual(["[permission] Approval requested"]);
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

  it("never sends while push is inactive", () => {
    const server = new ZcodeAcpServer();
    pushSettled(server, { kind: "turn", title: "turn completed" });
    expect(sent).toEqual([]);
  });

  it("suppresses a kind switched off via push.notify", () => {
    h.cfg = { contentDetail: "full", notify: { ...NOTIFY_ALL, turn: false } };
    const server = new ZcodeAcpServer();
    pushSettled(server, { kind: "turn", title: "turn completed" });
    pushSettled(server, { kind: "goal", title: "goal paused", body: "cancelled" });
    expect(sent).toEqual(["[goal] goal paused\ncancelled"]);
  });

  it("routes the compact kind through the same gate", () => {
    h.cfg = { contentDetail: "full", notify: NOTIFY_ALL };
    const server = new ZcodeAcpServer();
    pushSettled(server, { kind: "compact", title: "auto-compact completed" });
    expect(sent).toEqual(["[compact] auto-compact completed"]);

    sent.length = 0;
    h.cfg = { contentDetail: "full", notify: { ...NOTIFY_ALL, compact: false } };
    pushSettled(server, { kind: "compact", title: "auto-compact completed" });
    expect(sent).toEqual([]);
  });

  it("renders a label in the leading bracket in place of the kind", () => {
    h.cfg = { contentDetail: "minimal", notify: NOTIFY_ALL };
    const server = new ZcodeAcpServer();
    pushSettled(server, {
      kind: "turn",
      label: "myproj / fix auth flow",
      title: "turn completed",
      body: "stripped under minimal",
    });
    expect(sent).toEqual(["[myproj / fix auth flow] turn completed"]);
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

  it("pushes once the window has elapsed since the last activity", () => {
    h.cfg = { contentDetail: "full", notify: NOTIFY_ALL, quietMs: 30_000 };
    const server = new ZcodeAcpServer();
    server.lastUserActivityAt = Date.now() - 31_000;
    pushSettled(server, { kind: "turn", title: "turn completed" });
    expect(sent).toEqual(["[turn] turn completed"]);
  });

  it("quietMs 0 disables the window entirely", () => {
    h.cfg = { contentDetail: "full", notify: NOTIFY_ALL, quietMs: 0 };
    const server = new ZcodeAcpServer();
    noteUserActivity(server);
    pushSettled(server, { kind: "turn", title: "turn completed" });
    expect(sent).toEqual(["[turn] turn completed"]);
  });

  it("a config without quietMs is unwindowed (absent ≠ default)", () => {
    h.cfg = { contentDetail: "full", notify: NOTIFY_ALL };
    const server = new ZcodeAcpServer();
    noteUserActivity(server);
    pushSettled(server, { kind: "turn", title: "turn completed" });
    expect(sent).toEqual(["[turn] turn completed"]);
  });

  it("leaves offline interaction pushes unwindowed — recency there means the connection died", () => {
    h.cfg = { contentDetail: "full", quietMs: 30_000 };
    const server = new ZcodeAcpServer();
    noteUserActivity(server); // prompted seconds ago, then the client dropped
    pushIfOffline(server, { kind: "permission", title: "Approval requested" });
    expect(sent).toEqual(["[permission] Approval requested"]);
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

  it("labels the ask with the project / session title like every other push", () => {
    h.cfg = { contentDetail: "full", notify: { ask: true } };
    const server = new ZcodeAcpServer();
    server.sessionTitles.set("s1", "Which DB session");
    pushInteractionIfOffline(server, "elicitation/create", {
      sessionId: "s1",
      message: "Which database?",
    });
    expect(sent).toEqual([`[${PROJ} / Which DB session] Agent question\nWhich database?`]);
  });

  it("falls back to a project-only label when params carry no readable session", () => {
    h.cfg = { contentDetail: "full", notify: { ask: true } };
    const server = new ZcodeAcpServer();
    pushInteractionIfOffline(server, "session/request_permission", {});
    pushInteractionIfOffline(server, "elicitation/create", {});
    expect(sent).toEqual([`[${PROJ}] Approval requested`, `[${PROJ}] Agent question`]);
  });

  it("respects the notify.ask switch (off)", () => {
    h.cfg = { contentDetail: "full", notify: { ask: false } };
    const server = new ZcodeAcpServer();
    pushInteractionIfOffline(server, "session/request_permission", {
      toolCall: { title: "Bash: npm install" },
    });
    expect(sent).toEqual([]);
  });
});

describe("unanswered-ask watchdog (§5.1 v1.3 — connected-but-away)", () => {
  const PERMISSION = "session/request_permission";
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("pushes an ask still pending after askDelayMs even with a client CONNECTED", async () => {
    h.cfg = { contentDetail: "full", notify: { ask: true }, askDelayMs: 20 };
    const server = new ZcodeAcpServer();
    server.clients.add({ notify: async () => {}, request: async () => undefined });
    void server; // presence is irrelevant for the watchdog — the delay is the grace
    armAskWatchdog(PERMISSION, { toolCall: { title: "Bash: npm install" } });
    await tick(50);
    expect(sent).toEqual(["[permission] Approval requested\nBash: npm install"]);
    clearAskWatchdog();
  });

  it("a settled (answered) ask never pushes", async () => {
    h.cfg = { contentDetail: "full", notify: { ask: true }, askDelayMs: 20 };
    armAskWatchdog(PERMISSION, {});
    clearAskWatchdog(); // answered before the delay
    await tick(50);
    expect(sent).toEqual([]);
  });

  it("coalesces concurrent asks into ONE notification until all settle", async () => {
    h.cfg = { contentDetail: "full", notify: { ask: true }, askDelayMs: 20 };
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

  it("the watchdog pushes the label captured at arm time", async () => {
    h.cfg = { contentDetail: "full", notify: { ask: true }, askDelayMs: 20 };
    armAskWatchdog(
      "session/request_permission",
      { toolCall: { title: "Bash: rm" } },
      "myproj / fix auth flow",
    );
    await tick(50);
    expect(sent).toEqual(["[myproj / fix auth flow] Approval requested\nBash: rm"]);
    clearAskWatchdog();
  });

  it("the zero-clients immediate push satisfies the slot (no duplicate)", async () => {
    h.cfg = { contentDetail: "full", notify: { ask: true }, askDelayMs: 20 };
    const server = new ZcodeAcpServer();
    pushInteractionIfOffline(server, PERMISSION, { toolCall: { title: "Bash: rm" } });
    armAskWatchdog(PERMISSION, { toolCall: { title: "Bash: rm" } }); // funnel arms after dispatch
    await tick(50);
    expect(sent).toEqual([`[${PROJ}] Approval requested\nBash: rm`]);
    clearAskWatchdog();
  });

  it("notify.ask false disables the watchdog too", async () => {
    h.cfg = { contentDetail: "full", notify: { ask: false }, askDelayMs: 20 };
    armAskWatchdog(PERMISSION, {});
    await tick(50);
    expect(sent).toEqual([]);
    clearAskWatchdog();
  });
});

describe("renderPushContent", () => {
  it("omits the body line when there is no body", () => {
    expect(renderPushContent({ contentDetail: "full" }, { kind: "test", title: "T" })).toBe(
      "[test] T",
    );
  });
});

describe("pushSourceLabel", () => {
  it("joins the project dir with the session title; project alone without one", () => {
    const server = new ZcodeAcpServer();
    const bare = pushSourceLabel(server);
    expect(bare).toBe(basename(process.cwd())); // projectCwd() falls back to cwd
    server.sessionTitles.set("s1", "fix auth flow");
    expect(pushSourceLabel(server, "s1")).toBe(`${bare} / fix auth flow`);
  });
});

describe("push diary trail (delivery evidence survives the window)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0)); // dispatch resolves in a .then

  it("diaries a delivered line on a successful pushSettled", async () => {
    h.cfg = { contentDetail: "full", notify: { turn: true, goal: true, run: true, task: true } };
    const server = new ZcodeAcpServer();
    pushSettled(server, { kind: "turn", label: "proj / s", title: "turn completed" });
    await tick();
    expect(h.diary).toEqual([`push: turn "turn completed" delivered via WeCom`]);
  });

  it("diaries a delivered line on a successful pushIfOffline", async () => {
    h.cfg = { contentDetail: "full" };
    const server = new ZcodeAcpServer();
    pushIfOffline(server, { kind: "permission", title: "Approval requested" });
    await tick();
    expect(h.diary).toEqual([`push: permission "Approval requested" delivered via WeCom`]);
  });

  it("writes nothing when suppressed or inactive", async () => {
    h.cfg = { contentDetail: "full", notify: { turn: false, goal: true, run: true, task: true } };
    const server = new ZcodeAcpServer();
    pushSettled(server, { kind: "turn", title: "turn completed" });
    await tick();
    expect(h.diary).toEqual([]);
  });

  it("diaries the §7 test push on success", async () => {
    h.cfg = { contentDetail: "full" };
    await sendTestPush("Hi");
    expect(h.diary).toEqual([`push: test "Hi" delivered via WeCom`]);
  });
});

describe("sendTestPush (§7)", () => {
  it("answers push_disabled when inactive", async () => {
    const r = await sendTestPush("Hi");
    expect(r).toEqual({ ok: false, error: "push_disabled" });
  });

  it("sends regardless of client presence and reports the count", async () => {
    h.cfg = { contentDetail: "full" };
    const r = await sendTestPush("Hi");
    expect(r).toEqual({ ok: true, sent: 1 });
    expect(sent).toEqual(["[test] Hi"]);
  });

  it("surfaces send failures as send_failed", async () => {
    h.cfg = { contentDetail: "full" };
    setPushSenderForTests({
      sendText: async () => {
        throw new Error("quota exceeded");
      },
    });
    const r = await sendTestPush("Hi");
    expect(r).toEqual({ ok: false, error: "send_failed", message: "quota exceeded" });
  });
});
