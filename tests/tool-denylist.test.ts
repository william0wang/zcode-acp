/**
 * Per-session tool denylist tests (#340).
 *
 * `--disallowed-tools` on the app-server argv is parsed by the CLI but never
 * consumed on the protocol-server path, so the merged ZCODE_DISALLOWED_TOOLS +
 * Cron* default list has to ride session/create AND every session/resume as
 * `toolDenylist` (the backend projects it onto the runtime's registry-level
 * `toolDisallowlist`; a cold-recovered runtime is rebuilt from the resume
 * params alone). A pre-toolDenylist backend rejects the key with strict zod —
 * the bridge drops it, retries once, remembers the verdict for the backend
 * generation (no rejected round-trip per session) and warns once.
 *
 * The backend is a recording fake — a real ensureBackend would spawn zcode.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { ensureRealSession, loadSession, resumeSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

// The real module writes the App's ~/.zcode/v2/tasks-index.sqlite — never
// touch real disk in tests (same mock as session-lazy.test.ts).
vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

// In-memory durable alias store (src/lazy-sessions.ts persists to
// ~/.zcode/v2/acp-lazy-sessions.json — mocked for the same reason).
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
    });
  },
  lookupLazySession: (acpSid: string) => mockStore.get(acpSid),
  lookupModelChoiceByZcodeSid: () => undefined,
}));

const CRON_DEFAULTS = ["CronCreate", "CronList", "CronUpdate", "CronDelete", "CronPauseSelf"];

type Call = { method: string; params: Record<string, unknown> };

/**
 * Recording fake backend. `rejectDenylistOn` mimics a pre-toolDenylist strict
 * schema: any request of the listed methods that carries `toolDenylist` fails
 * with the zod wording (quoted form — the bare form is covered by the regex
 * unit test below).
 */
function fakeBackend(
  opts: { rejectDenylistOn?: Array<"session/create" | "session/resume"> } = {},
): { backend: ZcodeBackend; calls: Call[] } {
  const calls: Call[] = [];
  let created = 0;
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: p });
      if (
        (opts.rejectDenylistOn ?? []).includes(method as "session/create") &&
        "toolDenylist" in p
      ) {
        return {
          id,
          error: {
            code: -32602,
            message: 'Invalid params — (root): Unrecognized key: "toolDenylist"',
          },
        };
      }
      switch (method) {
        case "session/create":
          created += 1;
          return { id, result: { session: { sessionId: `sess_created_${created}`, title: "" } } };
        case "session/resume":
          return { id, result: {} };
        case "session/list":
          return { id, result: { sessions: [] } };
        case "session/read":
          return { id, result: { projection: { status: "idle" }, settings: {} } };
        case "session/messages":
          return { id, result: { messages: [] satisfies ZcodeMessage[] } };
        default:
          return { id, result: {} };
      }
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
}

function mockContext(): acp.AgentContext {
  return {
    notify: () => Promise.resolve(),
  } as unknown as acp.AgentContext;
}

function makeServer(opts?: Parameters<typeof fakeBackend>[0]): {
  server: ZcodeAcpServer;
  calls: Call[];
} {
  const server = new ZcodeAcpServer();
  const { backend, calls } = fakeBackend(opts);
  server.backend = backend;
  return { server, calls };
}

function creates(calls: Call[]): Call[] {
  return calls.filter((c) => c.method === "session/create");
}
function resumes(calls: Call[]): Call[] {
  return calls.filter((c) => c.method === "session/resume");
}

/** `warn()` writes to stderr (src/utils.ts); count only the denylist notice. */
let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;
function denylistWarns(): string[] {
  return (stderrSpy?.mock.calls ?? [])
    .map((c) => String(c[0]))
    .filter((line) => /rejects toolDenylist/.test(line));
}

beforeEach(() => {
  mockStore.clear();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = null;
  vi.unstubAllEnvs();
});

describe("toolDenylist rides session/create and session/resume", () => {
  it("session/create carries ZCODE_DISALLOWED_TOOLS merged with the Cron* defaults", async () => {
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "Bash,Write");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "");
    const { server, calls } = makeServer();
    server.pendingSessions.set("sess_acp", { cwd: "/tmp/ws" });

    await expect(ensureRealSession(server, "sess_acp")).resolves.toBe("sess_created_1");

    expect(creates(calls)).toHaveLength(1);
    expect(creates(calls)[0].params).toMatchObject({
      workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" },
      toolDenylist: ["Bash", "Write", ...CRON_DEFAULTS],
    });
  });

  it("session/create carries the Cron* defaults alone when the env var is unset (#192 gap)", async () => {
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "");
    const { server, calls } = makeServer();
    server.pendingSessions.set("sess_acp", { cwd: "/tmp/ws" });

    await ensureRealSession(server, "sess_acp");

    expect(creates(calls)[0].params).toMatchObject({ toolDenylist: CRON_DEFAULTS });
  });

  it("session/create omits the key entirely when nothing is disallowed (strict zod)", async () => {
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "1");
    const { server, calls } = makeServer();
    server.pendingSessions.set("sess_acp", { cwd: "/tmp/ws" });

    await ensureRealSession(server, "sess_acp");

    expect(creates(calls)[0].params).not.toHaveProperty("toolDenylist");
  });

  it("session/resume carries the same list (cold recovery rebuilds the runtime from it)", async () => {
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "Bash");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "");
    const { server, calls } = makeServer();
    server.registerSession("sess_acp", "sess_zcode");
    server.sessionCwds.set("sess_acp", "/tmp/ws");

    await resumeSession(
      server,
      { sessionId: "sess_acp" } as acp.ResumeSessionRequest,
      mockContext(),
    );

    expect(resumes(calls)).toHaveLength(1);
    expect(resumes(calls)[0].params).toMatchObject({
      sessionId: "sess_zcode",
      toolDenylist: ["Bash", ...CRON_DEFAULTS],
    });
  });

  it("session/load's resume carries the list too (shared resumeParams builder)", async () => {
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "Bash");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "");
    const { server, calls } = makeServer();
    server.registerSession("sess_acp", "sess_zcode");
    server.sessionCwds.set("sess_acp", "/tmp/ws");

    await loadSession(server, { sessionId: "sess_acp" } as acp.LoadSessionRequest, mockContext());

    expect(resumes(calls)).toHaveLength(1);
    expect(resumes(calls)[0].params).toMatchObject({ toolDenylist: ["Bash", ...CRON_DEFAULTS] });
  });
});

describe("pre-toolDenylist backend (strict schema rejects the key)", () => {
  it("session/create drops the key, retries once, succeeds, and remembers the verdict", async () => {
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "Bash");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "");
    const { server, calls } = makeServer({ rejectDenylistOn: ["session/create"] });
    server.pendingSessions.set("sess_a", { cwd: "/tmp/ws" });

    await expect(ensureRealSession(server, "sess_a")).resolves.toBe("sess_created_1");

    const c = creates(calls);
    expect(c).toHaveLength(2);
    expect(c[0].params).toHaveProperty("toolDenylist");
    expect(c[1].params).not.toHaveProperty("toolDenylist");
    // The rest of the params survive the strip.
    expect(c[1].params).toMatchObject({ workspace: { workspacePath: "/tmp/ws" } });
    expect(server.toolDenylistRejected).toBe(true);
    expect(denylistWarns()).toHaveLength(1);
    expect(denylistWarns()[0]).toMatch(/NOT applied/);
  });

  it("after the verdict, the next session/create omits the key up front — one RPC, no new warn", async () => {
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "Bash");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "");
    const { server, calls } = makeServer({ rejectDenylistOn: ["session/create"] });
    server.pendingSessions.set("sess_a", { cwd: "/tmp/ws" });
    await ensureRealSession(server, "sess_a");
    calls.length = 0;
    stderrSpy?.mockClear();

    server.pendingSessions.set("sess_b", { cwd: "/tmp/ws" });
    await expect(ensureRealSession(server, "sess_b")).resolves.toBe("sess_created_2");

    expect(creates(calls)).toHaveLength(1);
    expect(creates(calls)[0].params).not.toHaveProperty("toolDenylist");
    expect(denylistWarns()).toHaveLength(0);
  });

  it("session/resume drops the key and retries once (bounded: the stripped params cannot re-match)", async () => {
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "Bash");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "");
    const { server, calls } = makeServer({ rejectDenylistOn: ["session/resume"] });
    server.registerSession("sess_acp", "sess_zcode");
    server.sessionCwds.set("sess_acp", "/tmp/ws");

    await resumeSession(
      server,
      { sessionId: "sess_acp" } as acp.ResumeSessionRequest,
      mockContext(),
    );

    const r = resumes(calls);
    expect(r).toHaveLength(2);
    expect(r[0].params).toHaveProperty("toolDenylist");
    expect(r[1].params).not.toHaveProperty("toolDenylist");
    expect(r[1].params).toMatchObject({ sessionId: "sess_zcode" });
    expect(server.toolDenylistRejected).toBe(true);
  });

  it("the guarded-mode fallback and the denylist fallback chain on the params actually sent", async () => {
    // Both rejections at once (an old backend): the second retry must not
    // resurrect the `mode` the first retry already dropped.
    vi.stubEnv("ZCODE_ACP_MODE", "guarded");
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "Bash");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "");
    const calls: Call[] = [];
    let created = 0;
    const backend = {
      isDead: false,
      request: async (id: number, method: string, params: unknown) => {
        const p = (params ?? {}) as Record<string, unknown>;
        calls.push({ method, params: p });
        if (method === "session/create" && p.mode === "guarded") {
          return {
            id,
            error: {
              code: -32602,
              message: "Invalid enum value. Expected 'plan' | 'yolo', received 'guarded'",
            },
          };
        }
        if (method === "session/create" && "toolDenylist" in p) {
          return { id, error: { code: -32602, message: "Unrecognized key: toolDenylist" } };
        }
        if (method === "session/create") {
          created += 1;
          return { id, result: { session: { sessionId: `sess_chain_${created}`, title: "" } } };
        }
        return { id, result: {} };
      },
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.pendingSessions.set("sess_chain", { cwd: "/tmp/ws" });

    await expect(ensureRealSession(server, "sess_chain")).resolves.toBe("sess_chain_1");

    const c = creates(calls);
    expect(c).toHaveLength(3);
    expect(c[0].params).toMatchObject({
      mode: "guarded",
      toolDenylist: ["Bash", ...CRON_DEFAULTS],
    });
    expect(c[1].params).not.toHaveProperty("mode");
    expect(c[1].params).toHaveProperty("toolDenylist");
    expect(c[2].params).not.toHaveProperty("mode");
    expect(c[2].params).not.toHaveProperty("toolDenylist");
  });

  it("an unrelated unrecognized key does NOT trigger the denylist strip (word-bounded match)", async () => {
    vi.stubEnv("ZCODE_DISALLOWED_TOOLS", "Bash");
    vi.stubEnv("ZCODE_ENABLE_AUTOMATION_TOOLS", "");
    const calls: Call[] = [];
    const backend = {
      isDead: false,
      request: async (id: number, method: string, params: unknown) => {
        calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
        if (method === "session/create") {
          return { id, error: { code: -32602, message: "Unrecognized key: toolDenylistExtra" } };
        }
        return { id, result: {} };
      },
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.pendingSessions.set("sess_x", { cwd: "/tmp/ws" });

    await expect(ensureRealSession(server, "sess_x")).rejects.toThrow(/toolDenylistExtra/);

    expect(creates(calls)).toHaveLength(1);
    expect(server.toolDenylistRejected).toBe(false);
  });

  it("a backend respawn voids the verdict (the new build may accept the key)", () => {
    const server = new ZcodeAcpServer();
    server.toolDenylistRejected = true;
    server.resetBackendGeneration();
    expect(server.toolDenylistRejected).toBe(false);
  });
});
