/**
 * Regression: the replay batch must hold its per-session guard ACROSS the
 * session/messages fetch, not only around the replay sends.
 *
 * Bug: every replay path fetched history BEFORE entering withReplayBatch, so
 * during the backend RPC the session had no guard and a prompt dispatching
 * live updates took enqueueSessionSend's lock-free fast path — its chunks hit
 * the client BEFORE the batch. Martty renders updates in arrival order, so a
 * message sent right after a resume/boot-resume put the new turn's thinking
 * ABOVE the history that streamed in afterwards (observed live 2026-09).
 *
 * The fix runs fetch+replay inside the batch. Both tests drive an
 * alreadyLive session (no resume flight — the flight's own settled fetch runs
 * before the response, when no client can prompt yet) so the session/messages
 * RPC hanging on the gate is the one INSIDE the batch: exactly the window a
 * post-response prompt races through. The injected live send must land AFTER
 * every replayed chunk.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { sendSessionUpdate } from "../src/handlers/io.js";
import { loadSession, resumeSession } from "../src/handlers/session.js";
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

function hist(): ZcodeMessage[] {
  const m = (id: string, role: "user" | "assistant", text: string): ZcodeMessage => ({
    info: { id, role },
    parts: [{ type: "text", text }],
  });
  return [
    m("u1", "user", "one"),
    m("a1", "assistant", "A1"),
    m("u2", "user", "two"),
    m("a2", "assistant", "A2"),
  ];
}

/**
 * Fake backend whose session/messages RPC hangs on a gate the test controls —
 * reproducing the window where the replay holds (or, before the fix, does not
 * hold) the per-session guard.
 */
function gatedBackend(history: ZcodeMessage[]): {
  backend: ZcodeBackend;
  release: () => void;
  fetchStarted: () => boolean;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let messagesCalled = false;
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "session/messages":
          messagesCalled = true;
          await gate;
          return { result: { messages: history } };
        default:
          // session/read, modes, configOptions, ... — all tolerated blank.
          return { result: {} };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, release, fetchStarted: () => messagesCalled };
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

function chunkTexts(updates: acp.SessionUpdate[]): string[] {
  return updates
    .filter(
      (u) => u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk",
    )
    .map((u) => (u as { content?: { text?: string } }).content?.text ?? "");
}

/** A live turn update injected "from a prompt" while the fetch is in flight. */
function liveSend(cx: acp.AgentContext, acpSid: string): Promise<void> {
  return sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "LIVE" },
    messageId: "live1",
  });
}

describe("replay fetch-window ordering", () => {
  it("session/load: a live update dispatched during the history fetch lands after the batch", async () => {
    const server = new ZcodeAcpServer();
    const { backend, release, fetchStarted } = gatedBackend(hist());
    server.backend = backend;
    server.registerSession("sess_race", "zsess_race");
    server.markBackendLoaded("sess_race"); // alreadyLive: no flight, batch owns the fetch
    const { cx, updates } = collectCx();

    const load = loadSession(
      server,
      { sessionId: "sess_race", cwd: "/tmp/ws", mcpServers: [] } as acp.LoadSessionRequest,
      cx,
    );
    await vi.waitFor(() => expect(fetchStarted()).toBe(true));

    const live = liveSend(cx, "sess_race");
    // Let the send take its enqueue path before the fetch resolves.
    await new Promise((r) => setTimeout(r, 10));
    release();
    await load;
    await live;

    const texts = chunkTexts(updates);
    // The replay actually happened...
    expect(texts).toEqual(expect.arrayContaining(["one", "A1", "two", "A2"]));
    // ...and the live chunk queued BEHIND it, not squeezed in front.
    expect(texts.at(-1)).toBe("LIVE");
  });

  it("session/resume (martty): same ordering for the deferred TUI tail replay", async () => {
    const server = new ZcodeAcpServer();
    const { backend, release, fetchStarted } = gatedBackend(hist());
    server.backend = backend;
    server.registerSession("sess_race2", "zsess_race2");
    server.markBackendLoaded("sess_race2"); // alreadyLive: no flight
    server.clientName = "martty-test";
    const { cx, updates } = collectCx();

    const resume = resumeSession(
      server,
      { sessionId: "sess_race2" } as acp.ResumeSessionRequest,
      cx,
    );
    // The tail replay rides a setImmediate after the response; wait until its
    // fetch RPC is the one hanging.
    await vi.waitFor(() => expect(fetchStarted()).toBe(true));

    const live = liveSend(cx, "sess_race2");
    await new Promise((r) => setTimeout(r, 10));
    release();
    await resume;
    await live;

    const texts = chunkTexts(updates);
    expect(texts).toEqual(expect.arrayContaining(["one", "A1", "two", "A2"]));
    expect(texts.at(-1)).toBe("LIVE");
  });
});
