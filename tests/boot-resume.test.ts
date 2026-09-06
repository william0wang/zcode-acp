/**
 * Tests for the session/new boot-resume interception (ADR-0017 as amended by
 * ADR-0020): when the hub incubates a terminal window for a specific
 * conversation, ZCODE_ACP_RESUME_SESSION makes the client's opening
 * session/new load that session instead of creating a placeholder. The env is
 * consumed once; a failed load falls back to a fresh session so the window
 * still lands on a usable prompt.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { consumeBootResumeTarget, newSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

/** Fake backend recording RPCs; session/resume + messages answer minimally. */
function fakeBackend(history: ZcodeMessage[] = []): {
  backend: ZcodeBackend;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      switch (method) {
        case "workspace/updateProviderRegistry":
          return { result: {} };
        case "session/resume":
          return { result: {} };
        case "session/subscribe":
          return { result: { eventSeq: 0 } };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 } } };
        case "session/messages":
          return { result: { messages: history } };
        case "session/list":
          return { result: { sessions: [] } };
        default:
          return { result: {} };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
}

const stubCx = { notify: async () => {} } as unknown as acp.AgentContext;

describe("consumeBootResumeTarget", () => {
  afterEach(() => {
    delete process.env.ZCODE_ACP_RESUME_SESSION;
  });

  it("returns the target and deletes the env (second read is null)", () => {
    process.env.ZCODE_ACP_RESUME_SESSION = "sess_boot1";
    expect(consumeBootResumeTarget()).toBe("sess_boot1");
    expect(consumeBootResumeTarget()).toBeNull();
  });

  it("treats empty/whitespace as unset", () => {
    process.env.ZCODE_ACP_RESUME_SESSION = "   ";
    expect(consumeBootResumeTarget()).toBeNull();
  });
});

describe("session/new boot-resume interception", () => {
  afterEach(() => {
    delete process.env.ZCODE_ACP_RESUME_SESSION;
    vi.useRealTimers();
  });

  it("serves the first session/new as a session/load of the target id", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    server.registerSession("sess_boot", "zsess_boot");
    vi.spyOn(server.clients, "broadcast").mockReturnValue(stubCx);

    process.env.ZCODE_ACP_RESUME_SESSION = "sess_boot";
    const res = await newSession(server, { cwd: process.cwd() });

    // The client sees the resumed session id — it adopts it as live.
    expect(res.sessionId).toBe("sess_boot");
    // The load path ran: backend resume RPC with the target's zcode id.
    const resume = calls.find((c) => c.method === "session/resume");
    expect(resume?.params.sessionId).toBe("zsess_boot");
    // Env consumed: a second session/new (TUI /new) is a fresh placeholder.
    const second = await newSession(server, { cwd: process.cwd() });
    expect(second.sessionId).not.toBe("sess_boot");
    expect(second.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to a fresh placeholder when the load fails", async () => {
    const server = new ZcodeAcpServer();
    const backend = {
      isDead: false,
      request: async () => {
        throw new Error("session not found");
      },
      send: () => {},
      pollServerRequests: () => [],
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    server.backend = backend;
    vi.spyOn(server.clients, "broadcast").mockReturnValue(stubCx);

    process.env.ZCODE_ACP_RESUME_SESSION = "sess_gone";
    const res = await newSession(server, { cwd: process.cwd() });

    expect(res.sessionId).not.toBe("sess_gone");
    expect(server.pendingSessions.has(res.sessionId)).toBe(true);
  });

  it("creates a lazy placeholder when the env is absent", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    const res = await newSession(server, { cwd: process.cwd() });

    expect(server.pendingSessions.has(res.sessionId)).toBe(true);
    expect(calls).toHaveLength(0); // no backend RPC before first use
  });
});
