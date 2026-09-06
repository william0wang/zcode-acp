/**
 * Tests for the Martty-gated history replay on session/resume (ADR-0020):
 * ACP session/resume carries no history by design, and Martty only folds
 * chunk updates delivered AFTER the resume response — pre-response updates
 * target a session id the TUI has not adopted yet and are dropped (verified
 * against martty 0.2.35). The bridge defers a turn-aligned tail replay past
 * the response for martty clients; every other client sees no change.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { resumeSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

/** Fake backend recording nothing; resume + messages answer minimally. */
function fakeBackend(history: ZcodeMessage[]): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "session/resume":
          return { result: {} };
        case "session/subscribe":
          return { result: { eventSeq: 0 } };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 } } };
        case "session/messages":
          return { result: { messages: history } };
        default:
          return { result: {} };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

/** A client context that records every session/update it receives. */
interface SentUpdate {
  sessionUpdate: string;
  content?: { type: string; text: string };
}

function recordingCx(): { cx: acp.AgentContext; updates: SentUpdate[] } {
  const updates: SentUpdate[] = [];
  const cx = {
    notify: async (_method: string, params: { update?: SentUpdate }) => {
      if (params.update) updates.push(params.update);
    },
  } as unknown as acp.AgentContext;
  return { cx, updates };
}

const chunkKinds = new Set(["user_message_chunk", "agent_message_chunk"]);
const chunks = (updates: SentUpdate[]) => updates.filter((u) => chunkKinds.has(u.sessionUpdate));
/** setImmediate chain: one hop for the deferred replay, one for its awaits. */
const flushDeferred = () =>
  new Promise<void>((resolve) => setImmediate(() => setImmediate(() => resolve())));

const HISTORY: ZcodeMessage[] = [
  { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hello there" }] },
  { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "hi, welcome back" }] },
];

async function driveResume(clientName: string | null, history: ZcodeMessage[]) {
  const server = new ZcodeAcpServer();
  server.backend = fakeBackend(history);
  server.clientName = clientName;
  server.registerSession("sess_r", "zsess_r");
  const { cx, updates } = recordingCx();
  const res = await resumeSession(server, { sessionId: "sess_r" }, cx);
  return { res, updates };
}

describe("session/resume TUI history replay", () => {
  it("replays chunk history to martty clients after the response resolves", async () => {
    const { res, updates } = await driveResume("martty", HISTORY);
    expect(res.modes).toBeDefined();

    // The replay is deferred past the handler (= past the resume response
    // write): pre-response updates would be dropped by the TUI.
    expect(chunks(updates)).toHaveLength(0);
    await flushDeferred();
    const texts = chunks(updates).map((u) => u.content?.text);
    expect(texts).toContain("hello there");
    expect(texts).toContain("hi, welcome back");
  });

  it("matches case-insensitively on the client name", async () => {
    const { updates } = await driveResume("Martty 0.2.35", HISTORY);
    await flushDeferred();
    expect(chunks(updates).length).toBeGreaterThan(0);
  });

  it("sends no replay to non-martty clients (Zed loads its own history)", async () => {
    const { updates } = await driveResume("Zed", HISTORY);
    await flushDeferred();
    expect(chunks(updates)).toHaveLength(0);
  });

  it("treats an unknown client as non-martty", async () => {
    const { updates } = await driveResume(null, HISTORY);
    await flushDeferred();
    expect(chunks(updates)).toHaveLength(0);
  });

  it("skips the replay when the session has no history", async () => {
    const { updates } = await driveResume("martty", []);
    await flushDeferred();
    expect(chunks(updates)).toHaveLength(0);
  });

  it("bounds the replay to a turn-aligned tail", async () => {
    // 300 alternating user/assistant turns: the 200-message tail lands
    // exactly on a user turn start, so exactly 200 chunks replay.
    const long: ZcodeMessage[] = Array.from({ length: 600 }, (_, i) => ({
      info: { id: `m${i}`, role: i % 2 === 0 ? ("user" as const) : ("assistant" as const) },
      parts: [{ type: "text", text: `message ${i}` }],
    }));
    const { updates } = await driveResume("martty", long);
    await flushDeferred();
    expect(chunks(updates)).toHaveLength(200);
  });
});

describe("initialize clientName", () => {
  it("stores the client name from clientInfo", async () => {
    const server = new ZcodeAcpServer();
    await server.initialize({
      protocolVersion: 1,
      clientInfo: { name: "martty", version: "0.2.35" },
    } as unknown as acp.InitializeRequest);
    expect(server.clientName).toBe("martty");
  });
});
