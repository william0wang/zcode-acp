/**
 * Handler-level tail replay tests — session/load with `_meta.zcode.limit`
 * replays only the turn-aligned tail and returns replayMeta; session/
 * load_earlier pages backwards with the cursor; expired cursors and
 * unregistered sessions error.
 *
 * Mock layout mirrors tests/session-lazy.test.ts (tasks-index and the durable
 * alias store are mocked away from real disk; the fake backend serves
 * configurable session/messages).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { loadSession } from "../src/handlers/session.js";
import { loadEarlier } from "../src/handlers/replay.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

vi.mock("../src/lazy-sessions.js", () => ({
  rememberLazySession: () => {},
  recordMaterializedSession: () => {},
  lookupLazySession: () => undefined,
}));

// Layout: 8 messages, 4 turns (starts at 0, 1, 3, 6).
function hist(): ZcodeMessage[] {
  const m = (id: string, role: "user" | "assistant" | "system", text: string): ZcodeMessage => ({
    info: { id, role },
    parts: [{ type: "text", text }],
  });
  return [
    m("s0", "system", "sys"),
    m("u1", "user", "one"),
    m("a1", "assistant", "A1"),
    m("u2", "user", "two"),
    m("a2a", "assistant", "A2a"),
    m("a2b", "assistant", "A2b"),
    m("u3", "user", "three"),
    m("a3", "assistant", "A3"),
  ];
}

/** Fake backend with a mutable message history (tests swap it for compaction). */
function fakeBackend(history: ZcodeMessage[]): ZcodeBackend {
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "session/resume":
        case "workspace/updateProviderRegistry":
          return { result: {} };
        case "session/read":
          return { result: { projection: { contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { result: { messages: history } };
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return backend;
}

/** cx that collects session/update payloads. */
function collectCx(): { cx: acp.AgentContext; updates: acp.SessionUpdate[] } {
  const updates: acp.SessionUpdate[] = [];
  const cx = {
    notify: async (_method: string, params: { update: acp.SessionUpdate }) => {
      updates.push(params.update);
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, updates };
}

function chunks(updates: acp.SessionUpdate[]): string[] {
  return updates
    .filter(
      (u) => u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk",
    )
    .map((u) => (u as { content?: { text?: string } }).content?.text ?? "");
}

function loadParams(extra: Record<string, unknown> = {}): acp.LoadSessionRequest {
  return {
    sessionId: "sess_tail",
    cwd: "/tmp/ws",
    mcpServers: [],
    ...extra,
  } as acp.LoadSessionRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("session/load tail limit", () => {
  it("replays only the turn-aligned tail and returns replayMeta", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(hist());
    const { cx, updates } = collectCx();

    const result = await loadSession(server, loadParams({ _meta: { zcode: { limit: 2 } } }), cx);

    expect(chunks(updates)).toEqual(["three", "A3"]);
    expect((result as { replayMeta?: unknown }).replayMeta).toMatchObject({
      hasMore: true,
      replayedMessages: 2,
      replayedTurns: 1,
      totalMessages: 8,
      totalTurns: 4,
    });
  });

  it("limit 0 attaches without replaying anything", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(hist());
    const { cx, updates } = collectCx();

    await loadSession(server, loadParams({ _meta: { zcode: { limit: 0 } } }), cx);

    expect(chunks(updates)).toEqual([]);
  });

  it("without _meta the full history replays (Zed path regression)", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(hist());
    const { cx, updates } = collectCx();

    const result = await loadSession(server, loadParams(), cx);

    expect(chunks(updates)).toEqual(["sys", "one", "A1", "two", "A2a", "A2b", "three", "A3"]);
    expect((result as { replayMeta?: unknown }).replayMeta).toMatchObject({
      hasMore: false,
      replayedMessages: 8,
      totalMessages: 8,
      totalTurns: 4,
    });
  });
});

describe("system-reminder stripping in replay", () => {
  it("strips reminder blocks from user text and drops reminder-only messages", async () => {
    const history = hist();
    // u2: reminder prefix + real text. u3: reminder only — must vanish.
    history[3] = {
      info: { id: "u2", role: "user" },
      parts: [{ type: "text", text: "<system-reminder>todo nudge</system-reminder>\n\ntwo" }],
    };
    history[6] = {
      info: { id: "u3", role: "user" },
      parts: [{ type: "text", text: "<system-reminder>todo nudge</system-reminder>" }],
    };
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(history);
    const { cx, updates } = collectCx();

    await loadSession(server, loadParams(), cx);

    const texts = chunks(updates);
    expect(texts).toEqual(["sys", "one", "A1", "two", "A2a", "A2b", "A3"]);
    expect(texts.join("\n")).not.toContain("system-reminder");
  });

  it("leaves assistant text that literally mentions the tag untouched", async () => {
    const history = hist();
    history[4] = {
      info: { id: "a2a", role: "assistant" },
      parts: [{ type: "text", text: "A2a discusses <system-reminder> tags" }],
    };
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(history);
    const { cx, updates } = collectCx();

    await loadSession(server, loadParams(), cx);

    expect(chunks(updates)).toContain("A2a discusses <system-reminder> tags");
  });
});

describe("session/load_earlier", () => {
  async function attachTail(server: ZcodeAcpServer): Promise<string> {
    const { cx } = collectCx();
    const result = await loadSession(server, loadParams({ _meta: { zcode: { limit: 2 } } }), cx);
    return (result as { replayMeta: { cursor: string } }).replayMeta.cursor;
  }

  it("pages backwards until hasMore is false, then returns an empty page", async () => {
    const server = new ZcodeAcpServer();
    const history = hist();
    server.backend = fakeBackend(history);

    let cursor = await attachTail(server);
    const pages: string[][] = [];
    let hasMore = true;
    while (hasMore) {
      const { cx, updates } = collectCx();
      const res = await loadEarlier(
        server,
        { sessionId: "sess_tail", before: cursor, limit: 2 },
        cx,
      );
      pages.push(chunks(updates));
      hasMore = res.replayMeta.hasMore;
      cursor = res.replayMeta.cursor;
    }
    expect(pages).toEqual([["two", "A2a", "A2b"], ["one", "A1"], ["sys"]]);
  });

  it("still pages when new turns arrived since attach", async () => {
    const server = new ZcodeAcpServer();
    const history = hist();
    server.backend = fakeBackend(history);
    const cursor = await attachTail(server);

    // The live session moved on (append-only) — the cursor's prefix is intact.
    history.push(
      { info: { id: "u4", role: "user" }, parts: [{ type: "text", text: "four" }] },
      { info: { id: "a4", role: "assistant" }, parts: [{ type: "text", text: "A4" }] },
    );

    const { cx, updates } = collectCx();
    const res = await loadEarlier(server, { sessionId: "sess_tail", before: cursor, limit: 2 }, cx);
    expect(chunks(updates)).toEqual(["two", "A2a", "A2b"]);
    expect(res.replayMeta).toMatchObject({ hasMore: true, totalMessages: 10, totalTurns: 5 });
  });

  it("errors with cursor expired after the history compacted", async () => {
    const server = new ZcodeAcpServer();
    const history = hist();
    server.backend = fakeBackend(history);
    const cursor = await attachTail(server);

    // Simulate compaction: the old turn count no longer matches the cursor.
    history.splice(0, 4);

    const { cx } = collectCx();
    await expect(
      loadEarlier(server, { sessionId: "sess_tail", before: cursor, limit: 2 }, cx),
    ).rejects.toThrow("cursor expired");
  });

  it("errors for a session that was never attached in this bridge", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(hist());
    const { cx } = collectCx();
    await expect(
      loadEarlier(server, { sessionId: "never-attached", before: "whatever", limit: 2 }, cx),
    ).rejects.toThrow("session not registered");
  });

  it("requires a before cursor", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(hist());
    server.registerSession("sess_tail", "sess_tail");
    const { cx } = collectCx();
    await expect(
      loadEarlier(server, { sessionId: "sess_tail", limit: 2 } as never, cx),
    ).rejects.toThrow("before");
  });
});
