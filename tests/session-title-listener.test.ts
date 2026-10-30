/**
 * SessionTitleListener unit tests.
 *
 * Drives handleEvent() with `session.titleUpdated` events in the shape
 * captured live against app-server 0.16.5 / desktop 3.12.3 (see
 * docs/PROTOCOL.md) and asserts the title-adoption rules: generated titles
 * replace the provisional seed, manual renames (titleUserSetBy) win over
 * generated pushes, custom pushes are adopted AND pinned, and non-adoptable
 * sources are ignored.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionTitleListener } from "../src/handlers/session-titles.js";
import type { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeEvent } from "../src/backend/types.js";

// tasks-index writes are persisted side effects — stub the module so tests
// never touch the real ~/.zcode/v2/tasks-index.sqlite.
vi.mock("../src/tasks-index.js", () => ({
  updateSessionTitle: vi.fn(async () => true),
  renameSessionTask: vi.fn(async () => true),
  isTitleOverridden: vi.fn(async () => false),
}));

beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface FakeServerShape {
  sessionTitles: Map<string, string>;
  titleUserSetBy: Set<string>;
  autoTitleFinalized: Set<string>;
  sessionSummaries: Map<string, unknown>;
  discoveryRetiredAt: Map<string, number>;
  sessionCwds: Map<string, string>;
  marttyClientSeen: boolean;
  acpSidByZcodeSid: Map<string, string>;
  /** acpSid → backend conversation id (mirrors sessionMap) for aliases. */
  sessionMap: Map<string, string>;
  notifies: Array<{ sessionId: string; update: Record<string, unknown> }>;
  resolveAcpSid(zcodeSid: string): string | undefined;
  sessionAliases(acpSid: string): string[];
  touchSessionSummary(sessionId: string, title: string): void;
  clients: { broadcast(): { notify(method: string, params: unknown): Promise<void> } };
}

function makeServer(zcodeSid = "zcode_1", acpSid = "acp_1"): FakeServerShape {
  const notifies: FakeServerShape["notifies"] = [];
  const server: FakeServerShape = {
    sessionTitles: new Map([[acpSid, "first prompt line as provisional title"]]),
    titleUserSetBy: new Set(),
    autoTitleFinalized: new Set(),
    sessionSummaries: new Map([[acpSid, { title: "old" }]]),
    discoveryRetiredAt: new Map(),
    sessionCwds: new Map([[acpSid, "/repo/proj"]]),
    marttyClientSeen: false, // no tty writes under vitest regardless (ttyTitleIo)
    acpSidByZcodeSid: new Map([[zcodeSid, acpSid]]),
    sessionMap: new Map([[acpSid, zcodeSid]]),
    notifies,
    resolveAcpSid(sid: string) {
      return this.acpSidByZcodeSid.get(sid);
    },
    sessionAliases(primary: string) {
      const target = this.sessionMap.get(primary);
      if (!target) return [primary];
      const aliases: string[] = [];
      for (const [sid, zsid] of this.sessionMap) {
        if (zsid === target) aliases.push(sid);
      }
      return aliases.length > 0 ? aliases : [primary];
    },
    touchSessionSummary(sessionId: string, title: string) {
      this.sessionSummaries.set(sessionId, { title });
    },
    clients: {
      broadcast() {
        return {
          async notify(method: string, params: unknown) {
            const p = params as { sessionId: string; update: Record<string, unknown> };
            notifies.push({ sessionId: p.sessionId, update: p.update });
            void method;
          },
        };
      },
    },
  };
  return server;
}

/** Macrotask flush: settles the listener's async chain (durable-pin consult). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function titleEvent(payload: Record<string, unknown>, zcodeSid = "zcode_1"): ZcodeEvent {
  return {
    sessionId: zcodeSid,
    seq: 1,
    type: "session.titleUpdated",
    payload,
  };
}

describe("SessionTitleListener", () => {
  it("adopts a generated title over the provisional first-prompt seed", async () => {
    const server = makeServer("zcode_1", "acp_1");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent(
      titleEvent({
        source: "generated",
        title: "Fix the login bug",
        previousTitle: "first prompt line as provisional title",
      }),
    );
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("Fix the login bug");
    expect(server.sessionSummaries.get("acp_1")).toEqual({ title: "Fix the login bug" });
    expect(server.notifies).toHaveLength(1);
    expect(server.notifies[0]!.sessionId).toBe("acp_1");
    expect(server.notifies[0]!.update["sessionUpdate"]).toBe("session_info_update");
    expect(server.notifies[0]!.update["title"]).toBe("Fix the login bug");
  });

  it("auto-names exactly ONCE — a later generated push never retitles mid-conversation", async () => {
    const server = makeServer("zcode_1", "acp_1");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent(titleEvent({ source: "generated", title: "First auto title" }));
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("First auto title");
    // A second generated push (deferred sidecar result, resume re-emission
    // after the stored event rotated out of the retention window) is frozen
    // out — only a manual rename may change the title again.
    l.handleEvent(titleEvent({ source: "generated", title: "Regenerated later" }));
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("First auto title");
    expect(server.notifies).toHaveLength(1);
    // A manual rename (custom push from another surface) still lands.
    l.handleEvent(titleEvent({ source: "custom", title: "my own name" }));
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("my own name");
    expect(server.notifies).toHaveLength(2);
  });

  it("a trailing title push does not resurrect a remote-closed conversation", async () => {
    // ADR-0006 close retires the summary; a generated push arriving after it
    // (the dying turn's auto-title) must update the title but NOT recreate
    // the discovery summary — that resurrected the closed row in remote
    // lists (2026-10-22).
    const server = makeServer("zcode_1", "acp_1");
    server.sessionSummaries.delete("acp_1");
    server.discoveryRetiredAt.set("acp_1", Date.now());
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent(
      titleEvent({
        source: "generated",
        title: "Fix the login bug",
        previousTitle: "first prompt line as provisional title",
      }),
    );
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("Fix the login bug");
    expect(server.sessionSummaries.has("acp_1")).toBe(false);
  });

  it("skips default and first_input sources", async () => {
    const server = makeServer("zcode_1", "acp_1");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent(titleEvent({ source: "first_input", title: "the raw prompt line" }));
    l.handleEvent(titleEvent({ source: "default", title: "" }));
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("first prompt line as provisional title");
    expect(server.notifies).toHaveLength(0);
  });

  it("a manual rename (titleUserSetBy) wins over later generated pushes", async () => {
    const server = makeServer("zcode_1", "acp_1");
    server.titleUserSetBy.add("acp_1");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent(titleEvent({ source: "generated", title: "backend generated" }));
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("first prompt line as provisional title");
    expect(server.notifies).toHaveLength(0);
  });

  it("a custom push (another surface's rename) is adopted and pins the session", async () => {
    const server = makeServer("zcode_1", "acp_1");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent(titleEvent({ source: "custom", title: "my own name" }));
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("my own name");
    expect(server.titleUserSetBy.has("acp_1")).toBe(true);
    // A later generated push must not override the adopted custom title.
    l.handleEvent(titleEvent({ source: "generated", title: "backend generated" }));
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("my own name");
    expect(server.notifies).toHaveLength(1);
  });

  it("normalizes the title (single line, trimmed, 80 chars)", async () => {
    const server = makeServer("zcode_1", "acp_1");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    const long = "x".repeat(120);
    l.handleEvent(titleEvent({ source: "generated", title: `  line1\nline2\n${long}  ` }));
    await flush();
    const adopted = server.sessionTitles.get("acp_1")!;
    expect(adopted).toHaveLength(80);
    expect(adopted).not.toContain("\n");
  });

  it("no-ops on identical title, malformed payload, or unknown session mapping", async () => {
    const server = makeServer("zcode_1", "acp_1");
    server.sessionTitles.set("acp_1", "same title");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent(titleEvent({ source: "generated", title: "same title" }));
    await flush();
    expect(server.notifies).toHaveLength(0);

    l.handleEvent(titleEvent({ source: "generated", title: 42 as unknown as string }));
    l.handleEvent(titleEvent({ source: "generated" }));

    const orphan = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_unknown");
    orphan.handleEvent(titleEvent({ source: "generated", title: "no acp alias" }, "zcode_unknown"));
    await flush();
    expect(server.notifies).toHaveLength(0);
  });

  it("ignores unrelated event types", async () => {
    const server = makeServer("zcode_1", "acp_1");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent({
      sessionId: "zcode_1",
      seq: 2,
      type: "session.updated",
      payload: { taskId: "t1", status: "running" },
    });
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("first prompt line as provisional title");
  });

  it("routes adoption over the FULL alias list (multi-client sessions)", async () => {
    const server = makeServer("zcode_1", "acp_1");
    // A second client holds the same conversation under a different acpSid.
    server.sessionMap.set("acp_2", "zcode_1");
    server.sessionTitles.set("acp_2", "first prompt line as provisional title");
    server.sessionCwds.set("acp_2", "/repo/proj");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent(titleEvent({ source: "generated", title: "Fix the login bug" }));
    await flush();
    expect(server.sessionTitles.get("acp_1")).toBe("Fix the login bug");
    expect(server.sessionTitles.get("acp_2")).toBe("Fix the login bug");
    const notified = new Set(server.notifies.map((n) => n.sessionId));
    expect(notified).toEqual(new Set(["acp_1", "acp_2"]));
  });

  it("honors the durable title_overridden pin (rename predates this process)", async () => {
    const { isTitleOverridden } = await import("../src/tasks-index.js");
    vi.mocked(isTitleOverridden).mockResolvedValueOnce(true);
    const server = makeServer("zcode_1", "acp_1");
    const l = new SessionTitleListener(server as unknown as ZcodeAcpServer, "zcode_1");
    l.handleEvent(titleEvent({ source: "generated", title: "backend generated" }));
    await flush();
    // The durable flag says the user renamed this conversation — the
    // generated push is skipped and the pin is memoized in memory.
    expect(server.sessionTitles.get("acp_1")).toBe("first prompt line as provisional title");
    expect(server.titleUserSetBy.has("acp_1")).toBe(true);
    expect(server.notifies).toHaveLength(0);
    expect(isTitleOverridden).toHaveBeenCalledWith("zcode_1");
  });
});
