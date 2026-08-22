/**
 * Tests for session-root (cwd) trust boundaries.
 *
 * The session root decides what the /fs file endpoint exposes to remote
 * clients, so it must be backend-authoritative: a client's cwd is only
 * consulted at session/new (the editor declaring its worktree), never for
 * load/resume. The remote App used to send "/" as its cwd whenever its
 * instance list was stale (a session switch races the 4s list poll) — a
 * bridge that adopted it hijacked the file roots to the filesystem root and
 * polluted the advertised workspace label.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { loadSession, newSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

/** Fake backend whose session/resume returns the given workspace. */
function fakeBackend(
  history: ZcodeMessage[] = [],
  resumeWorkspace?: string,
): {
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
          return {
            result:
              resumeWorkspace === undefined
                ? {}
                : { session: { workspace: { workspacePath: resumeWorkspace } } },
          };
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

function loadParams(cwd?: string): acp.LoadSessionRequest {
  return { sessionId: "s-x", ...(cwd !== undefined ? { cwd } : {}) } as acp.LoadSessionRequest;
}

describe("session/load cwd trust", () => {
  it("ignores a client-supplied / — never records it as the root", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend();
    server.backend = backend;
    server.registerSession("s-x", "sess_x");

    await loadSession(server, loadParams("/"), stubCx);

    expect(server.sessionCwds.get("s-x")).not.toBe("/");
  });

  it("ignores any client cwd for existing sessions — even plausible paths", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend();
    server.backend = backend;
    server.registerSession("s-x", "sess_x");

    await loadSession(server, loadParams("/Users/attacker/elsewhere"), stubCx);

    // Client value must NOT become the root; nothing recorded → process cwd.
    expect(server.sessionCwds.get("s-x")).toBe(process.cwd());
  });

  it("adopts the backend's own workspace from the resume result", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend([], "/Users/proj/backend-truth");
    server.backend = backend;
    server.registerSession("s-x", "sess_x");

    await loadSession(server, loadParams("/Users/attacker/elsewhere"), stubCx);

    expect(server.sessionCwds.get("s-x")).toBe("/Users/proj/backend-truth");
  });

  it("heals a previously-polluted / entry from the backend workspace", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend([], "/Users/proj/backend-truth");
    server.backend = backend;
    server.registerSession("s-x", "sess_x");
    server.sessionCwds.set("s-x", "/");

    await loadSession(server, loadParams(), stubCx);

    expect(server.sessionCwds.get("s-x")).toBe("/Users/proj/backend-truth");
  });

  it("keeps the recorded root when the session is already live (no resume RPC)", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    server.registerSession("s-x", "sess_x");
    server.markBackendLoaded("s-x");
    server.sessionCwds.set("s-x", "/Users/proj/real");

    await loadSession(server, loadParams("/"), stubCx);

    expect(server.sessionCwds.get("s-x")).toBe("/Users/proj/real");
    expect(calls.some((c) => c.method === "session/resume")).toBe(false);
  });
});

describe("newSession cwd guard", () => {
  it("accepts the client worktree at creation", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend();
    server.backend = backend;

    const resp = await newSession(server, {
      cwd: "/Users/proj/app",
      mcpServers: [],
    } as unknown as acp.NewSessionRequest);

    expect(server.sessionCwds.get(resp.sessionId)).toBe("/Users/proj/app");
  });

  it("falls back to the process cwd instead of recording /", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend();
    server.backend = backend;

    const resp = await newSession(server, {
      cwd: "/",
      mcpServers: [],
    } as unknown as acp.NewSessionRequest);

    expect(server.sessionCwds.get(resp.sessionId)).toBe(process.cwd());
  });
});

describe("projectCwd()", () => {
  it("prefers the most recently active session's cwd and skips / entries", () => {
    const server = new ZcodeAcpServer();
    server.sessionCwds.set("s-stale", "/Users/proj/old");
    server.sessionCwds.set("s-polluted", "/");
    server.sessionCwds.set("s-fresh", "/Users/proj/new");
    server.sessionSummaries.set("s-stale", { updatedAt: 1_000 });
    server.sessionSummaries.set("s-polluted", { updatedAt: 2_000 });
    server.sessionSummaries.set("s-fresh", { updatedAt: 3_000 });

    expect(server.projectCwd()).toBe("/Users/proj/new");
  });

  it("falls back to the process cwd when every entry is polluted", () => {
    const server = new ZcodeAcpServer();
    server.sessionCwds.set("s-a", "/");
    server.sessionCwds.set("s-b", "/");

    expect(server.projectCwd()).toBe(process.cwd());
  });
});
