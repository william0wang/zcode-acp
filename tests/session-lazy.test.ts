/**
 * Lazy session creation tests.
 *
 * session/new returns a placeholder id and defers zcode `session/create` to
 * first use (ensureRealSession), so an editor startup that never prompts
 * leaves no session in the backend or the App's task index.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { ensureRealSession, newSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

// Record tasks-index upserts so tests can assert the App sync happens at
// materialization (never at session/new). The real module writes the App's
// ~/.zcode/v2/tasks-index.sqlite and must not be touched by tests.
const mockUpsertCalls: Array<Record<string, unknown>> = [];
vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async (opts: Record<string, unknown>) => {
    mockUpsertCalls.push(opts);
    return true;
  },
  updateSessionTitle: async () => true,
}));

/** Fake backend: answers session/create, errors on everything else. */
function fakeBackend(): ZcodeBackend & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  let created = 0;
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "session/create") {
        created += 1;
        return {
          id,
          result: { session: { sessionId: `sess_lazy_${created}`, title: "", traceId: "trace_1" } },
        };
      }
      return { id, error: { message: `unhandled ${method}` } };
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
}

function newSessionParams(cwd: string): acp.NewSessionRequest {
  return { cwd } as acp.NewSessionRequest;
}

describe("session/new lazy creation", () => {
  it("returns a placeholder id without spawning the backend or creating a zcode session", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));

    expect(server.backend).toBeNull();
    expect(resp.sessionId).toBeTruthy();
    expect(server.pendingSessions.get(resp.sessionId)).toEqual({ cwd: "/tmp/ws" });
    expect(server.resolveSid(resp.sessionId)).toBeUndefined();
    expect(mockUpsertCalls).toHaveLength(0);
    // Fresh sessions stay auto-title-eligible on first end_turn.
    expect(server.titleEligibleSessions.has(resp.sessionId)).toBe(true);
  });

  it("returns default modes/configOptions consistent with the yolo create", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));

    expect(resp.modes.currentModeId).toBe("yolo");
    const modeOpt = resp.configOptions.find((o) => o.id === "mode");
    expect(modeOpt?.currentValue).toBe("yolo");
  });
});

describe("ensureRealSession", () => {
  it("materializes the backend session once on first use and registers the mapping", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    const sid = await ensureRealSession(server, resp.sessionId);
    expect(sid).toBe("sess_lazy_1");
    expect(server.resolveSid(resp.sessionId)).toBe(sid);
    expect(server.pendingSessions.has(resp.sessionId)).toBe(false);

    const creates = calls.filter((c) => c.method === "session/create");
    expect(creates).toHaveLength(1);
    expect(creates[0].params).toMatchObject({
      workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" },
      mode: "yolo",
    });
    expect(mockUpsertCalls).toHaveLength(1);
    expect(mockUpsertCalls[0]).toMatchObject({ workspaceKey: "/tmp/ws", taskId: sid });

    // Idempotent: a second call reuses the mapping, no new create.
    await expect(ensureRealSession(server, resp.sessionId)).resolves.toBe(sid);
    expect(calls.filter((c) => c.method === "session/create")).toHaveLength(1);
  });

  it("serializes concurrent first-uses into a single session/create", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    const [sidA, sidB] = await Promise.all([
      ensureRealSession(server, resp.sessionId),
      ensureRealSession(server, resp.sessionId),
    ]);
    expect(sidA).toBe(sidB);
    expect(calls.filter((c) => c.method === "session/create")).toHaveLength(1);
  });

  it("throws for unknown session ids", async () => {
    const server = new ZcodeAcpServer();
    await expect(ensureRealSession(server, "sess_unknown")).rejects.toThrow(
      "session sess_unknown not found",
    );
  });

  it("returns the mapping for already-registered sessions without creating", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("acp_existing", "sess_existing");
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await expect(ensureRealSession(server, "acp_existing")).resolves.toBe("sess_existing");
    expect(calls.filter((c) => c.method === "session/create")).toHaveLength(0);
  });
});
