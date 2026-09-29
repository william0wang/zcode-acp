/**
 * pushIfOffline gating + payload derivation (push-backend-requirements §4/§5):
 * nothing fires when push is inactive or a client is online; offline + ACTIVE
 * renders the contracted `[kind] title\nbody` text; minimal strips bodies;
 * the interaction hook derives permission/question payloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cfg: null as { contentDetail: "full" | "minimal" } | null,
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
