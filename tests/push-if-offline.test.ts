/**
 * pushIfOffline gating + payload derivation (push-backend-requirements §4/§5):
 * nothing fires when push is inactive or a client is online; offline + ACTIVE
 * renders the contracted `[kind] title\nbody` text; minimal strips bodies;
 * the interaction hook derives permission/question payloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basename } from "node:path";

const h = vi.hoisted(() => ({
  cfg: null as { contentDetail: "full" | "minimal"; notify?: Record<string, boolean> } | null,
}));
vi.mock("../src/push/config.js", async (orig) => {
  const actual = await orig<typeof import("../src/push/config.js")>();
  return {
    ...actual,
    pushActive: () => h.cfg !== null,
    pushConfig: () => h.cfg,
  };
});

const {
  pushIfOffline,
  pushInteractionIfOffline,
  pushSettled,
  pushSourceLabel,
  renderPushContent,
  resetPushSenderForTests,
  sendTestPush,
  setPushSenderForTests,
} = await import("../src/push/push.js");
const { ZcodeAcpServer } = await import("../src/server.js");

const sent: string[] = [];

beforeEach(() => {
  h.cfg = null;
  sent.length = 0;
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
  const NOTIFY_ALL = { turn: true, goal: true, run: true, task: true };

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

describe("pushInteractionIfOffline (§5.1)", () => {
  it("derives permission with the toolCall title as body", () => {
    h.cfg = { contentDetail: "full" };
    const server = new ZcodeAcpServer();
    pushInteractionIfOffline(server, "session/request_permission", {
      sessionId: "s1",
      toolCall: { title: "Bash: npm install" },
      options: [],
    });
    expect(sent).toEqual(["[permission] Approval requested\nBash: npm install"]);
  });

  it("derives question from elicitation with the message as body", () => {
    h.cfg = { contentDetail: "full" };
    const server = new ZcodeAcpServer();
    pushInteractionIfOffline(server, "elicitation/create", {
      sessionId: "s1",
      message: "Which database?",
    });
    expect(sent).toEqual(["[question] Agent question\nWhich database?"]);
  });

  it("falls back to bare titles when params carry nothing readable", () => {
    h.cfg = { contentDetail: "full" };
    const server = new ZcodeAcpServer();
    pushInteractionIfOffline(server, "session/request_permission", {});
    pushInteractionIfOffline(server, "elicitation/create", {});
    expect(sent).toEqual(["[permission] Approval requested", "[question] Agent question"]);
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
