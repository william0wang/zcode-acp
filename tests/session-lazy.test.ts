/**
 * Lazy session creation tests.
 *
 * session/new returns a placeholder id and defers zcode `session/create` to
 * first use (ensureRealSession), so an editor startup that never prompts
 * leaves no session in the backend or the App's task index. Placeholders stay
 * resolvable by session/resume and session/load — including after a bridge
 * restart, via the durable alias store (mocked below).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import {
  ensureRealSession,
  loadSession,
  newSession,
  reloadBackendSession,
  resumeSession,
  setConfigOptionHandler,
} from "../src/handlers/session.js";
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

// In-memory durable alias store (src/lazy-sessions.ts persists this to
// ~/.zcode/v2/acp-lazy-sessions.json — never touch real disk in tests).
const mockStore = new Map<string, { cwd: string; zcodeSid?: string; createdAt: number }>();
vi.mock("../src/lazy-sessions.js", () => ({
  rememberLazySession: (acpSid: string, cwd: string) => {
    mockStore.set(acpSid, { cwd, createdAt: Date.now() });
  },
  recordMaterializedSession: (acpSid: string, zcodeSid: string, cwd: string) => {
    const existing = mockStore.get(acpSid);
    mockStore.set(acpSid, {
      cwd: existing?.cwd ?? cwd,
      zcodeSid,
      createdAt: existing?.createdAt ?? Date.now(),
      ...(existing?.modelChoice ? { modelChoice: existing.modelChoice } : {}),
    });
  },
  recordModelChoice: (acpSid: string, patch: { model?: string; thought?: string; at?: number }) => {
    const existing = mockStore.get(acpSid);
    if (!existing) return;
    mockStore.set(acpSid, {
      ...existing,
      modelChoice: { ...(existing.modelChoice ?? {}), ...patch },
    });
  },
  lookupLazySession: (acpSid: string) => mockStore.get(acpSid),
  lookupModelChoiceByZcodeSid: (zcodeSid: string) => {
    let best: { model?: string; thought?: string; at?: number } | undefined;
    for (const rec of mockStore.values()) {
      if (rec.zcodeSid !== zcodeSid || !rec.modelChoice) continue;
      if (!best || (rec.modelChoice.at ?? 0) > (best.at ?? 0)) best = rec.modelChoice;
    }
    return best;
  },
}));

beforeEach(() => {
  mockStore.clear();
  // Keep the create-mode assertions deterministic on a machine that exports
  // ZCODE_ACP_MODE; the per-test stub below still overrides this.
  vi.stubEnv("ZCODE_ACP_MODE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Fake backend: answers session/create (counting creates), session/resume,
 * session/read (empty projection/settings), session/messages (from `messages`,
 * empty by default), the provider-registry push, and session/list (from
 * `listed`, for title adoption); errors on everything else.
 */
function fakeBackend(
  listed: Array<{ sessionId: string; title?: string }> = [],
  messages: ZcodeMessage[] = [],
  resumeWorkspace?: string,
): ZcodeBackend & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  let created = 0;
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case "session/create":
          created += 1;
          return {
            id,
            result: {
              session: { sessionId: `sess_lazy_${created}`, title: "", traceId: "trace_1" },
            },
          };
        case "session/resume":
          return {
            id,
            // A resume result may carry the session's recorded workspace —
            // the value normal mode adopts as the session root.
            result: resumeWorkspace
              ? { session: { workspace: { workspacePath: resumeWorkspace } } }
              : {},
          };
        case "workspace/updateProviderRegistry":
          return { id, result: {} };
        case "provider/updateAccountConfig":
          return {
            id,
            result: { receivedRevision: "account:test", providerCount: 0, status: "received" },
          };
        case "session/list":
          return { id, result: { sessions: listed } };
        case "session/read":
          return { id, result: { projection: { contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { id, result: { messages } };
        default:
          return { id, error: { message: `unhandled ${method}` } };
      }
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

  it("starts the session in ZCODE_ACP_MODE when it is set", async () => {
    vi.stubEnv("ZCODE_ACP_MODE", "build");
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await ensureRealSession(server, resp.sessionId);

    const creates = calls.filter((c) => c.method === "session/create");
    expect(creates).toHaveLength(1);
    expect(creates[0].params).toMatchObject({ mode: "build" });
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

  it("recovers a materialized placeholder from a previous bridge lifetime", async () => {
    const server = new ZcodeAcpServer();
    mockStore.set("acp_old", { cwd: "/tmp/ws", zcodeSid: "sess_old", createdAt: Date.now() });
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await expect(ensureRealSession(server, "acp_old")).resolves.toBe("sess_old");
    expect(server.resolveSid("acp_old")).toBe("sess_old");
    expect(calls.filter((c) => c.method === "session/create")).toHaveLength(0);
  });

  it("re-hydrates a never-used placeholder from a previous bridge lifetime", async () => {
    const server = new ZcodeAcpServer();
    mockStore.set("acp_old_unused", { cwd: "/tmp/ws", createdAt: Date.now() });
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await expect(ensureRealSession(server, "acp_old_unused")).resolves.toBe("sess_lazy_1");
    expect(server.resolveSid("acp_old_unused")).toBe("sess_lazy_1");
    const creates = calls.filter((c) => c.method === "session/create");
    expect(creates).toHaveLength(1);
    // Look the create up by method, not by index — the account-provider push
    // (provider/updateAccountConfig) precedes it, so calls[0] is not the create.
    expect(creates[0]!.params).toMatchObject({
      workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" },
    });
  });
});

describe("resumeSession with lazy placeholders", () => {
  it("materializes a pending placeholder and skips the backend resume RPC", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    const cx = {} as acp.AgentContext;

    const out = await resumeSession(
      server,
      { sessionId: resp.sessionId } as acp.ResumeSessionRequest,
      cx,
    );

    expect(server.resolveSid(resp.sessionId)).toBe("sess_lazy_1");
    expect(calls.some((c) => c.method === "session/create")).toBe(true);
    expect(calls.some((c) => c.method === "session/resume")).toBe(false);
    expect(out.modes.currentModeId).toBe("yolo");
  });

  it("replays client-provided mcpServers into the backend session/create", async () => {
    // Regression: session/new accepted an mcpServers parameter but never read
    // it, so client-configured stdio servers were silently dropped. The lazy
    // placeholder must carry them into session/create verbatim.
    const server = new ZcodeAcpServer();
    const mcpServers = [{ name: "echo", command: "node", args: ["/tmp/mcp-echo.mjs"], env: [] }];
    const resp = await newSession(server, { cwd: "/tmp/ws", mcpServers } as acp.NewSessionRequest);
    expect(server.pendingSessions.get(resp.sessionId)).toMatchObject({ mcpServers });

    const { backend, calls } = fakeBackend();
    server.backend = backend;
    await ensureRealSession(server, resp.sessionId);

    const creates = calls.filter((c) => c.method === "session/create");
    expect(creates).toHaveLength(1);
    expect(creates[0].params).toMatchObject({ mode: "yolo", mcpServers });
  });

  it("omits mcpServers from session/create when the client provided none", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    await ensureRealSession(server, resp.sessionId);

    const creates = calls.filter((c) => c.method === "session/create");
    expect(creates[0].params).not.toHaveProperty("mcpServers");
  });

  it("forwards resume-provided mcpServers to the backend session/resume", async () => {
    // Regression companion: ACP session/resume also carries mcpServers; the
    // backend re-connects them as part of the resume.
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    const mcpServers = [{ name: "echo", command: "node", args: [], env: [] }];

    await resumeSession(
      server,
      { sessionId: "sess_real_1", cwd: "/tmp/ws", mcpServers } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0].params).toMatchObject({ sessionId: "sess_real_1", mcpServers });
    // The client cwd does NOT become the session root (backend-authoritative
    // only); with no recorded root and no workspace in the resume result the
    // bridge falls back to its process cwd.
    expect(server.sessionCwds.get("sess_real_1")).toBe(process.cwd());
  });

  it("re-sends stored mcpServers on an eviction reload (#193)", async () => {
    // The backend treats mcpServers as per-load runtime config, not persisted
    // state — an idle-eviction reload must carry them again or the session
    // silently loses its client MCP tools for the rest of its life.
    const server = new ZcodeAcpServer();
    const mcpServers = [{ name: "echo", command: "node", args: [], env: [] }];
    const resp = await newSession(server, { cwd: "/tmp/ws", mcpServers } as acp.NewSessionRequest);
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    await ensureRealSession(server, resp.sessionId);
    calls.length = 0;

    await reloadBackendSession(server, resp.sessionId, "sess_lazy_1");

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0].params).toMatchObject({ sessionId: "sess_lazy_1", mcpServers });
  });

  it("session/load re-sends a stored mcpServers set even when params carry []", async () => {
    // The SDK makes `mcpServers: []` mandatory on session/load; that empty
    // array must NOT wipe a set remembered at session/new.
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    const mcpServers = [{ name: "echo", command: "node", args: [], env: [] }];
    server.registerSession("s-load", "sess_load");
    server.sessionCwds.set("s-load", "/tmp/ws");
    server.sessionMcpServers.set("s-load", mcpServers);

    await loadSession(
      server,
      { sessionId: "s-load", cwd: "/tmp/ws", mcpServers: [] } as acp.LoadSessionRequest,
      {} as acp.AgentContext,
    );

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0].params).toMatchObject({ sessionId: "sess_load", mcpServers });
  });

  it("resumes an already-materialized placeholder without backend resume", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;
    await ensureRealSession(server, resp.sessionId);
    calls.length = 0;

    await resumeSession(
      server,
      { sessionId: resp.sessionId } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    expect(calls.some((c) => c.method === "session/create")).toBe(false);
    expect(calls.some((c) => c.method === "session/resume")).toBe(false);
  });

  it("passes a real backend id through to session/resume", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await resumeSession(
      server,
      { sessionId: "sess_real" } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    const resume = calls.find((c) => c.method === "session/resume");
    expect(resume?.params).toMatchObject({ sessionId: "sess_real" });
    expect(server.resolveSid("sess_real")).toBe("sess_real");
  });

  it("recovers a previous-lifetime placeholder and resumes its real session", async () => {
    const server = new ZcodeAcpServer();
    mockStore.set("acp_old", { cwd: "/tmp/ws", zcodeSid: "sess_old", createdAt: Date.now() });
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await resumeSession(
      server,
      { sessionId: "acp_old" } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    const resume = calls.find((c) => c.method === "session/resume");
    expect(resume?.params).toMatchObject({ sessionId: "sess_old" });
    expect(server.resolveSid("acp_old")).toBe("sess_old");
    expect(calls.some((c) => c.method === "session/create")).toBe(false);
  });

  it("materializes a previous-lifetime placeholder that was never used", async () => {
    const server = new ZcodeAcpServer();
    mockStore.set("acp_old_unused", { cwd: "/tmp/ws", createdAt: Date.now() });
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await resumeSession(
      server,
      { sessionId: "acp_old_unused" } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    expect(server.resolveSid("acp_old_unused")).toBe("sess_lazy_1");
    expect(calls.some((c) => c.method === "session/create")).toBe(true);
    expect(calls.some((c) => c.method === "session/resume")).toBe(false);
  });
});

describe("loadSession with lazy placeholders", () => {
  it("materializes a pending placeholder without the backend resume RPC", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await loadSession(
      server,
      { sessionId: resp.sessionId } as acp.LoadSessionRequest,
      {} as acp.AgentContext,
    );

    expect(server.resolveSid(resp.sessionId)).toBe("sess_lazy_1");
    expect(calls.some((c) => c.method === "session/create")).toBe(true);
    expect(calls.some((c) => c.method === "session/resume")).toBe(false);
  });

  it("passes a real backend id through to session/resume", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await loadSession(
      server,
      { sessionId: "sess_real", cwd: "/tmp/ws" } as acp.LoadSessionRequest,
      {} as acp.AgentContext,
    );

    const resume = calls.find((c) => c.method === "session/resume");
    expect(resume?.params).toMatchObject({ sessionId: "sess_real" });
    // Same as resumeSession: the client cwd is NOT recorded as the root.
    expect(server.sessionCwds.get("sess_real")).toBe(process.cwd());
  });
});

describe("stored title adoption on load/resume", () => {
  it("adopts the backend's stored title into the discovery summary", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend([{ sessionId: "sess_real", title: "Historical title" }]);
    server.backend = backend;

    await resumeSession(
      server,
      { sessionId: "sess_real" } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    expect(server.sessionTitles.get("sess_real")).toBe("Historical title");
    expect(server.sessionSummaries.get("sess_real")?.title).toBe("Historical title");
  });

  it("does not overwrite an in-process title", async () => {
    const server = new ZcodeAcpServer();
    server.sessionTitles.set("sess_real", "In-process title");
    const { backend, calls } = fakeBackend([{ sessionId: "sess_real", title: "Historical title" }]);
    server.backend = backend;

    await resumeSession(
      server,
      { sessionId: "sess_real" } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    expect(server.sessionTitles.get("sess_real")).toBe("In-process title");
    expect(calls.some((c) => c.method === "session/list")).toBe(false);
  });

  it("leaves the session untitled when the backend has no stored title", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend();
    server.backend = backend;

    await resumeSession(
      server,
      { sessionId: "sess_real" } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    expect(server.sessionSummaries.get("sess_real")?.title).toBeUndefined();
  });

  it("loadSession adopts the title the same way", async () => {
    const server = new ZcodeAcpServer();
    const { backend } = fakeBackend([{ sessionId: "sess_real", title: "Historical title" }]);
    server.backend = backend;

    await loadSession(
      server,
      { sessionId: "sess_real" } as acp.LoadSessionRequest,
      {} as acp.AgentContext,
    );

    expect(server.sessionSummaries.get("sess_real")?.title).toBe("Historical title");
  });
});

describe("discovery activity gating", () => {
  it("a never-used placeholder resumed by an editor restart stays hidden", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));
    const { backend } = fakeBackend();
    server.backend = backend;

    // Editor restart → session/resume of the stored placeholder materializes
    // an empty backend session; no turn ever runs.
    await resumeSession(
      server,
      { sessionId: resp.sessionId, cwd: "/tmp/ws" } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    const summary = server.sessionSummaries.get(resp.sessionId);
    expect(summary).toBeDefined();
    expect(summary?.hasActivity).toBeFalsy();
  });

  it("loadSession with history marks the session discoverable", async () => {
    const server = new ZcodeAcpServer();
    const history: ZcodeMessage[] = [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ];
    const { backend } = fakeBackend([], history);
    server.backend = backend;

    await loadSession(
      server,
      { sessionId: "sess_hist" } as acp.LoadSessionRequest,
      { notify: async () => {} } as unknown as acp.AgentContext,
    );

    expect(server.sessionSummaries.get("sess_hist")?.hasActivity).toBe(true);
  });
});

describe("backend-loaded session tracking", () => {
  const stubCx = { notify: async () => {} } as unknown as acp.AgentContext;

  it("session/load re-issues the resume RPC for a mapping that was never loaded", async () => {
    const server = new ZcodeAcpServer();
    // The poison case: a mapping re-registered from the durable store (or
    // left by a failed resume) without the session ever being loaded into
    // this backend subprocess.
    server.registerSession("s-old", "sess_old");
    const history: ZcodeMessage[] = [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "old turn" }] },
    ];
    const { backend, calls } = fakeBackend([], history);
    server.backend = backend;

    await loadSession(server, { sessionId: "s-old" } as acp.LoadSessionRequest, stubCx);

    const resume = calls.find((c) => c.method === "session/resume");
    expect(resume?.params).toMatchObject({ sessionId: "sess_old" });
    expect(server.isBackendSessionLive("s-old")).toBe(true);
  });

  it("session/load skips the resume RPC once the session is verified loaded", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("s-live", "sess_live");
    server.markBackendLoaded("s-live");
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await loadSession(server, { sessionId: "s-live" } as acp.LoadSessionRequest, stubCx);

    expect(calls.some((c) => c.method === "session/resume")).toBe(false);
    expect(calls.some((c) => c.method === "session/messages")).toBe(true);
  });

  it("materializing a placeholder marks it backend-loaded", async () => {
    const server = new ZcodeAcpServer();
    const resp = await newSession(server, newSessionParams("/tmp/ws"));
    const { backend } = fakeBackend();
    server.backend = backend;

    await ensureRealSession(server, resp.sessionId);

    expect(server.isBackendSessionLive(resp.sessionId)).toBe(true);
  });
});

describe("serve mode cwd pinning (ADR-0014 hardening)", () => {
  // A remote client can mint {sid → arbitrary cwd} durable aliases on any
  // editor bridge (session/new trusts the local editor's cwd) and then resume
  // them on a serve bridge. Serve mode must treat foreign-cwd records as
  // unknown ids and never move its pinned session root — neither via the
  // workspace it sends to the backend nor via the root recorded for /fs.

  it("session/new ignores a client cwd and records the pinned project", async () => {
    const server = new ZcodeAcpServer({ serveMode: true });
    const resp = await newSession(server, newSessionParams("/etc"));

    expect(server.pendingSessions.get(resp.sessionId)).toEqual({ cwd: process.cwd() });
    expect(mockStore.get(resp.sessionId)?.cwd).toBe(process.cwd());
  });

  it("rejects a foreign durable record with a zcodeSid (no alias smuggling)", async () => {
    const server = new ZcodeAcpServer({ serveMode: true });
    mockStore.set("acp_foreign", {
      cwd: "/Users/victim/secret",
      zcodeSid: "sess_foreign",
      createdAt: 1,
    });
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await expect(ensureRealSession(server, "acp_foreign")).rejects.toThrow(
      "session acp_foreign not found",
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects a foreign never-used record (no foreign materialization)", async () => {
    const server = new ZcodeAcpServer({ serveMode: true });
    mockStore.set("acp_pending_foreign", { cwd: "/Users/victim/secret", createdAt: 1 });
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await expect(ensureRealSession(server, "acp_pending_foreign")).rejects.toThrow(
      "session acp_pending_foreign not found",
    );
    expect(calls).toHaveLength(0);
  });

  it("materializes its OWN record in the process cwd", async () => {
    const server = new ZcodeAcpServer({ serveMode: true });
    mockStore.set("acp_own", { cwd: process.cwd(), createdAt: 1 });
    const { backend, calls } = fakeBackend();
    server.backend = backend;

    await expect(ensureRealSession(server, "acp_own")).resolves.toBe("sess_lazy_1");
    expect(calls.filter((c) => c.method === "session/create")[0]!.params).toMatchObject({
      workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
    });
  });

  it("resume pins the root to the process cwd; a foreign-workspace session is refused", async () => {
    const server = new ZcodeAcpServer({ serveMode: true });
    const { backend, calls } = fakeBackend([], [], "/tmp/foreign-ws");
    server.backend = backend;

    await expect(
      resumeSession(
        server,
        { sessionId: "sess_real_1", cwd: "/tmp/attacker" } as acp.ResumeSessionRequest,
        {} as acp.AgentContext,
      ),
    ).rejects.toThrow("session belongs to another workspace");

    // The workspace sent to the backend was pinned; the refused session
    // records no mapping and no root.
    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.params).toMatchObject({
      workspace: { workspacePath: process.cwd() },
    });
    expect(server.resolveSid("sess_real_1")).toBeUndefined();
    expect(server.sessionCwds.get("sess_real_1")).toBeUndefined();
  });

  it("resume of the serve bridge's OWN workspace stays pinned", async () => {
    const server = new ZcodeAcpServer({ serveMode: true });
    // The backend reports the same project (sameProjectDir resolves both
    // spellings): accepted, and the recorded root stays the process cwd.
    const { backend, calls } = fakeBackend([], [], process.cwd());
    server.backend = backend;

    await resumeSession(
      server,
      { sessionId: "sess_real_1" } as acp.ResumeSessionRequest,
      {} as acp.AgentContext,
    );

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.params).toMatchObject({
      workspace: { workspacePath: process.cwd() },
    });
    expect(server.sessionCwds.get("sess_real_1")).toBe(process.cwd());
  });

  it("load pins the root the same way and refuses foreign-workspace sessions", async () => {
    const server = new ZcodeAcpServer({ serveMode: true });
    const { backend, calls } = fakeBackend([], [], "/tmp/foreign-ws");
    server.backend = backend;

    await expect(
      loadSession(
        server,
        { sessionId: "sess_real_2" } as acp.LoadSessionRequest,
        {} as acp.AgentContext,
      ),
    ).rejects.toThrow("session belongs to another workspace");

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.params).toMatchObject({
      workspace: { workspacePath: process.cwd() },
    });
    expect(server.sessionCwds.get("sess_real_2")).toBeUndefined();
  });
});

describe("store-recovered sessions (bridge restart)", () => {
  const stubCx = { notify: async () => {} } as unknown as acp.AgentContext;

  /**
   * Backend with real resident semantics: session state RPCs (setModel /
   * setThoughtLevel) fail with -32004 "Session is not active" until a
   * session/resume has loaded the session into THIS backend process.
   */
  function residentBackend(): ZcodeBackend & {
    calls: Array<{ method: string; params: unknown }>;
  } {
    const calls: Array<{ method: string; params: unknown }> = [];
    const resumed = new Set<string>();
    const backend = {
      isDead: false,
      request: async (id: number, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        const sid = String(params.sessionId ?? "");
        switch (method) {
          case "session/resume":
            resumed.add(sid);
            return { id, result: {} };
          case "session/setModel":
          case "session/setThoughtLevel":
            if (sid && !resumed.has(sid)) {
              return { id, error: { code: -32004, message: `Session is not active: ${sid}` } };
            }
            return { id, result: {} };
          case "session/read":
            return { id, result: { projection: { contextUsed: 0 }, settings: {} } };
          case "session/messages":
            return { id, result: { messages: [] } };
          default:
            return { id, result: {} };
        }
      },
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    return { backend, calls };
  }

  it("ensureRealSession reloads a store-recovered mapping before first use", async () => {
    mockStore.set("acp_restart", { cwd: "/tmp/ws", zcodeSid: "sess_restart", createdAt: 1 });
    const server = new ZcodeAcpServer();
    const { backend, calls } = residentBackend();
    server.backend = backend;

    await expect(ensureRealSession(server, "acp_restart")).resolves.toBe("sess_restart");

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    // The resume workspace comes from the record's cwd, seeded for a process
    // that never saw the session/new which recorded it.
    expect(resumes[0]!.params).toMatchObject({
      sessionId: "sess_restart",
      workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" },
    });
    expect(server.isBackendSessionLive("acp_restart")).toBe(true);
  });

  it("the FIRST model switch after a bridge restart succeeds (2026-09-18 regression)", async () => {
    mockStore.set("acp_switch", { cwd: "/tmp/ws", zcodeSid: "sess_switch", createdAt: 1 });
    const server = new ZcodeAcpServer();
    const { backend, calls } = residentBackend();
    server.backend = backend;

    const resp = await setConfigOptionHandler(
      server,
      {
        sessionId: "acp_switch",
        configId: "model",
        value: "builtin:bigmodel-coding-plan\\GLM-5.3",
      } as acp.SetSessionConfigOptionRequest,
      stubCx,
    );

    // The reload ran BEFORE the switch — setModel saw a resident session.
    const resumeIdx = calls.findIndex((c) => c.method === "session/resume");
    const setModelIdx = calls.findIndex((c) => c.method === "session/setModel");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(setModelIdx).toBeGreaterThan(resumeIdx);
    const model = resp.configOptions.find((o) => o.id === "model");
    expect(model?.currentValue).toBe("builtin:bigmodel-coding-plan\\GLM-5.3");
  });

  it("session/load on a store-recovered record resumes exactly once and carries fresh mcpServers", async () => {
    mockStore.set("acp_load", { cwd: "/tmp/ws", zcodeSid: "sess_load", createdAt: 1 });
    const server = new ZcodeAcpServer();
    const { backend, calls } = residentBackend();
    server.backend = backend;

    await loadSession(
      server,
      {
        sessionId: "acp_load",
        mcpServers: [{ name: "srv", command: "echo" }],
      } as acp.LoadSessionRequest,
      stubCx,
    );

    // The eviction guard is skipped on the load/resume path (their resume is
    // the one that must carry the client's freshly declared mcpServers, #193)
    // — so exactly ONE resume, with those servers on it.
    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.params).toMatchObject({
      mcpServers: [{ name: "srv", command: "echo" }],
    });
  });

  it("a store-recovered mapping whose backend session was deleted fails with the evicted error", async () => {
    mockStore.set("acp_dead", { cwd: "/tmp/ws", zcodeSid: "sess_dead", createdAt: 1 });
    const server = new ZcodeAcpServer();
    const calls: Array<{ method: string; params: unknown }> = [];
    const backend = {
      isDead: false,
      request: async (id: number, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "session/resume") {
          return { id, error: { code: -32004, message: `Session not found: ${params.sessionId}` } };
        }
        return { id, result: {} };
      },
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    server.backend = backend;

    await expect(ensureRealSession(server, "acp_dead")).rejects.toThrow("acp_dead");
    // No overlay retry for a deleted session.
    expect(calls.filter((c) => c.method === "session/resume")).toHaveLength(1);
  });
});
