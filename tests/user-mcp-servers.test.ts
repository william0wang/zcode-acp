/**
 * User-config MCP servers (`mcp.servers` in cli/config.json) on a
 * client-declared `mcpServers` list.
 *
 * The backend reads the user config's servers only when session/create and
 * session/resume carry NO `mcpServers`: a non-empty list is the session's
 * whole MCP config and displaces them, so a client that injects a server of
 * its own (paseo does) dropped every user-configured one. The bridge unions
 * them into a non-empty client list (a client entry wins a name clash), leaves
 * an empty list alone (the backend loads the user config itself there), and
 * when the backend rejects the union it retries with the client's own list,
 * remembers the verdict for the backend generation and warns once.
 *
 * The backend is a recording fake (as in tool-denylist.test.ts); the config
 * file lives in the hermetic HOME every test file gets.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import {
  clientServersOf,
  loadUserConfigMcpServers,
  mergeUserConfigMcpServers,
} from "../src/config/user-mcp-servers.js";
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
  recordAdvertisedModel: () => {},
  lookupLazySession: (acpSid: string) => mockStore.get(acpSid),
  lookupModelChoiceByZcodeSid: () => undefined,
}));

const cliConfigPath = path.join(process.env.HOME!, ".zcode", "cli", "config.json");

/** The user's cli/config.json `mcp.servers` in the hermetic HOME. */
function writeCliConfig(servers: Record<string, unknown>): void {
  mkdirSync(path.dirname(cliConfigPath), { recursive: true });
  writeFileSync(cliConfigPath, JSON.stringify({ mcp: { servers } }));
}

/** The server a host injects on its own behalf, e.g. paseo's `paseo` server. */
const HOST: acp.McpServer = {
  name: "host",
  command: "node",
  args: ["host.mjs"],
  env: [{ name: "HOST", value: "1" }],
};

const USER_SERVERS = {
  notes: {
    command: "npx",
    args: ["-y", "notes-mcp"],
    env: { NOTES_TOKEN: "t" },
    cwd: "/w",
    timeoutMs: 5000,
  },
  remote: {
    type: "http",
    url: "https://mcp.example.com/x",
    headers: { Authorization: "Bearer a" },
  },
  off: { command: "never-starts", enabled: false },
};
/** The two enabled entries of USER_SERVERS in the backend's wire shape. */
const NOTES = {
  name: "notes",
  command: "npx",
  args: ["-y", "notes-mcp"],
  env: [{ name: "NOTES_TOKEN", value: "t" }],
  cwd: "/w",
  timeoutMs: 5000,
};
const REMOTE = {
  name: "remote",
  type: "http",
  url: "https://mcp.example.com/x",
  headers: [{ name: "Authorization", value: "Bearer a" }],
};
const UNION = [HOST, NOTES, REMOTE];

/** The zod wording the backend uses for a bad element of the list. */
const REJECTION = 'Invalid params \u2014 mcpServers.1: Unrecognized key: "bogus"';

type Call = { method: string; params: Record<string, unknown> };

/** True when `mcpServers` carries an entry the bridge derived from the config. */
function carriesConfigServer(servers: unknown): boolean {
  return (
    Array.isArray(servers) &&
    servers.some((server) => ["notes", "remote"].includes((server as { name: string }).name))
  );
}

/**
 * Recording fake backend. `rejectUserServersOn` mimics a strict schema that
 * refuses the config-derived entries: any request of the listed methods whose
 * `mcpServers` carries one fails with the backend's zod wording.
 */
function fakeBackend(
  opts: { rejectUserServersOn?: Array<"session/create" | "session/resume"> } = {},
): { backend: ZcodeBackend; calls: Call[] } {
  const calls: Call[] = [];
  let created = 0;
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: p });
      if (
        (opts.rejectUserServersOn ?? []).includes(method as "session/create") &&
        carriesConfigServer(p.mcpServers)
      ) {
        return { id, error: { code: -32602, message: REJECTION } };
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

/** `warn()` writes to stderr (src/utils.ts); count only the user-server notice. */
let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;
function userMcpWarns(): string[] {
  return (stderrSpy?.mock.calls ?? [])
    .map((c) => String(c[0]))
    .filter((line) => /user-config MCP servers/.test(line));
}

beforeEach(() => {
  mockStore.clear();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = null;
  vi.unstubAllEnvs();
  rmSync(path.join(process.env.HOME!, ".zcode"), { recursive: true, force: true });
});

describe("loadUserConfigMcpServers (config entry to wire shape)", () => {
  it("emits stdio and http entries with the REQUIRED pair arrays and skips a disabled one", () => {
    writeCliConfig(USER_SERVERS);
    expect(loadUserConfigMcpServers()).toEqual([NOTES, REMOTE]);
  });

  it("keeps an sse type and omits optional keys the config does not carry", () => {
    writeCliConfig({
      stream: { type: "sse", url: "https://s.example.com/s" },
      bare: { command: "run" },
    });
    expect(loadUserConfigMcpServers()).toEqual([
      { name: "stream", type: "sse", url: "https://s.example.com/s", headers: [] },
      { name: "bare", command: "run", args: [], env: [] },
    ]);
  });

  it("reads a missing, malformed or misshapen config as no servers", () => {
    expect(loadUserConfigMcpServers()).toEqual([]);
    mkdirSync(path.dirname(cliConfigPath), { recursive: true });
    writeFileSync(cliConfigPath, "{ nope");
    expect(loadUserConfigMcpServers()).toEqual([]);
    // `mcp.servers` is not a map, and entries are not objects: none of it is a server.
    writeFileSync(cliConfigPath, JSON.stringify({ mcp: { servers: ["x"] } }));
    expect(loadUserConfigMcpServers()).toEqual([]);
    writeFileSync(
      cliConfigPath,
      JSON.stringify({ mcp: { servers: { a: 5, b: null, " ": { command: "run" } } } }),
    );
    expect(loadUserConfigMcpServers()).toEqual([]);
  });

  it("leaves out an entry the backend's strict schema would reject, rather than send a trimmed one", () => {
    writeCliConfig({
      blank: { command: "   ", url: "" },
      argless: { args: ["only-args"] },
      mixed: {
        command: "run",
        args: ["ok", 5, null],
        env: { A: "ok", B: 7 },
        cwd: "",
        timeoutMs: 0,
      },
      badenv: { command: "run", env: "PATH=/bin" },
      badheaders: { type: "http", url: "https://s.example.com", headers: { Authorization: 42 } },
    });
    expect(loadUserConfigMcpServers()).toEqual([]);
  });

  it("leaves out an entry with a key the backend does not know, but not for the keys it ignores", () => {
    writeCliConfig({
      tools: { command: "run", tools: ["*"] },
      legacy: { command: "run", timeout: 5, startup_timeout_sec: 3 },
    });
    expect(loadUserConfigMcpServers()).toEqual([
      { name: "legacy", command: "run", args: [], env: [] },
    ]);
  });

  it("folds the backend's legacy spellings the way its own loader does", () => {
    writeCliConfig({
      shell: { command: "run", environment: { A: "1" }, enable: true },
      off: { command: "run", enable: false },
      remote: { type: "remote", url: "https://r.example.com", http_headers: { A: "1" } },
      both: { command: "run", env: { A: "from-env" }, environment: { A: "from-environment" } },
      // With no type the backend looks at the command first.
      dual: { command: "run", url: "https://d.example.com" },
    });
    expect(loadUserConfigMcpServers()).toEqual([
      { name: "shell", command: "run", args: [], env: [{ name: "A", value: "1" }] },
      {
        name: "remote",
        type: "http",
        url: "https://r.example.com",
        headers: [{ name: "A", value: "1" }],
      },
      { name: "both", command: "run", args: [], env: [{ name: "A", value: "from-env" }] },
    ]);
  });

  it("carries every optional field the wire supports", () => {
    const clientCredentials = { type: "client_credentials", clientId: "id", clientSecret: "s" };
    writeCliConfig({
      local: {
        command: "run",
        alwaysLoad: true,
        isolation: "workspace",
        protocolVersion: "2026-07-28",
        timeoutMs: 2500,
      },
      cc: { type: "http", url: "https://c.example.com", oauth: clientCredentials },
      code: {
        type: "sse",
        url: "https://a.example.com",
        oauth: { type: "authorization_code", scope: "read" },
        alwaysLoad: false,
      },
      // Whole milliseconds only: a fractional timeout is dropped, not the server.
      fraction: { command: "run", timeoutMs: 1500.5 },
    });
    expect(loadUserConfigMcpServers()).toEqual([
      {
        name: "local",
        command: "run",
        args: [],
        env: [],
        alwaysLoad: true,
        isolation: "workspace",
        protocolVersion: "2026-07-28",
        timeoutMs: 2500,
      },
      {
        name: "cc",
        type: "http",
        url: "https://c.example.com",
        headers: [],
        oauth: clientCredentials,
      },
      {
        name: "code",
        type: "sse",
        url: "https://a.example.com",
        headers: [],
        oauth: { type: "authorization_code", scope: "read" },
        alwaysLoad: false,
      },
      { name: "fraction", command: "run", args: [], env: [] },
    ]);
  });

  it("leaves out an entry whose optional field or oauth block is malformed", () => {
    writeCliConfig({
      isolation: { command: "run", isolation: "global" },
      version: { command: "run", protocolVersion: "1999-01-01" },
      load: { command: "run", alwaysLoad: "yes" },
      grant: { type: "http", url: "https://g.example.com", oauth: { type: "password" } },
      incomplete: {
        type: "http",
        url: "https://g.example.com",
        oauth: { type: "client_credentials", clientId: "id" },
      },
    });
    expect(loadUserConfigMcpServers()).toEqual([]);
  });
});

describe("mergeUserConfigMcpServers", () => {
  it("unions the config servers after a non-empty client list", () => {
    writeCliConfig(USER_SERVERS);
    const hostList = [HOST];
    const merged = mergeUserConfigMcpServers(hostList, false);
    expect(merged).toEqual(UNION);
    // The origin survives for the rejection fallback.
    expect(clientServersOf(merged)).toBe(hostList);
  });

  it("leaves an empty or absent list alone (the backend loads the user config itself)", () => {
    writeCliConfig(USER_SERVERS);
    const empty: acp.McpServer[] = [];
    expect(mergeUserConfigMcpServers(empty, false)).toBe(empty);
    expect(mergeUserConfigMcpServers(undefined, false)).toBeUndefined();
    expect(clientServersOf(empty)).toBeNull();
    expect(clientServersOf(undefined)).toBeNull();
  });

  it("gives a same-name clash to the client entry", () => {
    writeCliConfig({ host: { command: "config-host" }, notes: USER_SERVERS.notes });
    const hostList = [HOST];
    expect(mergeUserConfigMcpServers(hostList, false)).toEqual([HOST, NOTES]);
  });

  it("returns the client list itself when there is nothing to add", () => {
    writeCliConfig({ host: { command: "config-host" } });
    const hostList = [HOST];
    expect(mergeUserConfigMcpServers(hostList, false)).toBe(hostList);
  });

  it("skips the union once the backend rejected it (no rejected round-trip per session)", () => {
    writeCliConfig(USER_SERVERS);
    const hostList = [HOST];
    expect(mergeUserConfigMcpServers(hostList, true)).toBe(hostList);
  });
});

describe("the union rides session/create and session/resume", () => {
  it("session/create sends the client server followed by the config servers", async () => {
    writeCliConfig(USER_SERVERS);
    const { server, calls } = makeServer();
    server.pendingSessions.set("sess_acp", { cwd: "/tmp/ws", mcpServers: [HOST] });

    await expect(ensureRealSession(server, "sess_acp")).resolves.toBe("sess_created_1");

    expect(creates(calls)).toHaveLength(1);
    expect(creates(calls)[0].params.mcpServers).toEqual(UNION);
  });

  it("session/create sends no mcpServers when the client declared none", async () => {
    // The backend then loads the user config itself; injecting here would only
    // replace its conversion with the bridge's.
    writeCliConfig(USER_SERVERS);
    for (const mcpServers of [undefined, []]) {
      const { server, calls } = makeServer();
      server.pendingSessions.set("sess_acp", { cwd: "/tmp/ws", mcpServers });

      await ensureRealSession(server, "sess_acp");

      expect(creates(calls)).toHaveLength(1);
      expect(creates(calls)[0].params).not.toHaveProperty("mcpServers");
    }
  });

  it("without a config file the client list is sent unchanged", async () => {
    const { server, calls } = makeServer();
    server.pendingSessions.set("sess_acp", { cwd: "/tmp/ws", mcpServers: [HOST] });

    await ensureRealSession(server, "sess_acp");

    expect(creates(calls)[0].params.mcpServers).toEqual([HOST]);
  });

  it("session/resume carries the union and never writes it back into the client list", async () => {
    writeCliConfig(USER_SERVERS);
    const { server, calls } = makeServer();
    server.registerSession("sess_acp", "sess_zcode");
    server.sessionCwds.set("sess_acp", "/tmp/ws");
    server.sessionMcpServers.set("sess_acp", [HOST]);

    await resumeSession(
      server,
      { sessionId: "sess_acp" } as acp.ResumeSessionRequest,
      mockContext(),
    );

    expect(resumes(calls)).toHaveLength(1);
    expect(resumes(calls)[0].params).toMatchObject({ sessionId: "sess_zcode", mcpServers: UNION });
    expect(server.sessionMcpServers.get("sess_acp")).toEqual([HOST]);
  });

  it("session/load's resume carries it too (shared resumeParams builder)", async () => {
    writeCliConfig(USER_SERVERS);
    const { server, calls } = makeServer();
    server.registerSession("sess_acp", "sess_zcode");
    server.sessionCwds.set("sess_acp", "/tmp/ws");
    server.sessionMcpServers.set("sess_acp", [HOST]);

    await loadSession(server, { sessionId: "sess_acp" } as acp.LoadSessionRequest, mockContext());

    expect(resumes(calls)).toHaveLength(1);
    expect(resumes(calls)[0].params.mcpServers).toEqual(UNION);
  });

  it("re-reads the config on every resume, so an edit reaches the next one", async () => {
    // Two sessions of one bridge: each resume reads the file as it is then.
    const { server, calls } = makeServer();
    for (const [acpSid, zcodeSid] of [
      ["sess_a", "sess_z_a"],
      ["sess_b", "sess_z_b"],
    ]) {
      server.registerSession(acpSid, zcodeSid);
      server.sessionCwds.set(acpSid, "/tmp/ws");
      server.sessionMcpServers.set(acpSid, [HOST]);
    }

    writeCliConfig({ notes: USER_SERVERS.notes });
    await resumeSession(server, { sessionId: "sess_a" } as acp.ResumeSessionRequest, mockContext());
    writeCliConfig({ remote: USER_SERVERS.remote });
    await resumeSession(server, { sessionId: "sess_b" } as acp.ResumeSessionRequest, mockContext());

    expect(resumes(calls).map((r) => r.params.mcpServers)).toEqual([
      [HOST, NOTES],
      [HOST, REMOTE],
    ]);
  });
});

describe("backend rejects the union (strict schema drift)", () => {
  it("session/create retries with the client list alone, latches the verdict, warns once", async () => {
    writeCliConfig(USER_SERVERS);
    const { server, calls } = makeServer({ rejectUserServersOn: ["session/create"] });
    server.pendingSessions.set("sess_a", { cwd: "/tmp/ws", mcpServers: [HOST] });

    await expect(ensureRealSession(server, "sess_a")).resolves.toBe("sess_created_1");

    const c = creates(calls);
    expect(c).toHaveLength(2);
    expect(c[0].params.mcpServers).toEqual(UNION);
    expect(c[1].params.mcpServers).toEqual([HOST]);
    // The rest of the params survive the strip.
    expect(c[1].params).toMatchObject({ workspace: { workspacePath: "/tmp/ws" } });
    expect(server.userMcpRejected).toBe(true);
    expect(userMcpWarns()).toHaveLength(1);
    expect(userMcpWarns()[0]).toMatch(/retrying with the client-provided ones only/);
  });

  it("after the verdict the next session/create sends the client list up front: one RPC, no new warn", async () => {
    writeCliConfig(USER_SERVERS);
    const { server, calls } = makeServer({ rejectUserServersOn: ["session/create"] });
    server.pendingSessions.set("sess_a", { cwd: "/tmp/ws", mcpServers: [HOST] });
    await ensureRealSession(server, "sess_a");
    calls.length = 0;
    stderrSpy?.mockClear();

    server.pendingSessions.set("sess_b", { cwd: "/tmp/ws", mcpServers: [HOST] });
    await expect(ensureRealSession(server, "sess_b")).resolves.toBe("sess_created_2");

    expect(creates(calls)).toHaveLength(1);
    expect(creates(calls)[0].params.mcpServers).toEqual([HOST]);
    expect(userMcpWarns()).toHaveLength(0);
  });

  it("session/resume drops the config servers and retries once (bounded: the client list cannot re-match)", async () => {
    writeCliConfig(USER_SERVERS);
    const { server, calls } = makeServer({ rejectUserServersOn: ["session/resume"] });
    server.registerSession("sess_acp", "sess_zcode");
    server.sessionCwds.set("sess_acp", "/tmp/ws");
    server.sessionMcpServers.set("sess_acp", [HOST]);

    await resumeSession(
      server,
      { sessionId: "sess_acp" } as acp.ResumeSessionRequest,
      mockContext(),
    );

    const r = resumes(calls);
    expect(r).toHaveLength(2);
    expect(r[0].params.mcpServers).toEqual(UNION);
    expect(r[1].params.mcpServers).toEqual([HOST]);
    expect(r[1].params).toMatchObject({ sessionId: "sess_zcode" });
    expect(server.userMcpRejected).toBe(true);
  });

  it("an unrelated rejection naming another key does NOT trigger the fallback", async () => {
    writeCliConfig(USER_SERVERS);
    const calls: Call[] = [];
    const backend = {
      isDead: false,
      request: async (id: number, method: string, params: unknown) => {
        calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
        if (method === "session/create") {
          return { id, error: { code: -32602, message: "Unrecognized key: mcpServersExtra" } };
        }
        return { id, result: {} };
      },
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.pendingSessions.set("sess_x", { cwd: "/tmp/ws", mcpServers: [HOST] });

    await expect(ensureRealSession(server, "sess_x")).rejects.toThrow(/mcpServersExtra/);

    expect(creates(calls)).toHaveLength(1);
    expect(server.userMcpRejected).toBe(false);
  });

  it("a rejection of the client's own entries alone gets no fallback (nothing was injected)", async () => {
    const calls: Call[] = [];
    const backend = {
      isDead: false,
      request: async (id: number, method: string, params: unknown) => {
        calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
        if (method === "session/create") {
          return { id, error: { code: -32602, message: REJECTION } };
        }
        return { id, result: {} };
      },
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.pendingSessions.set("sess_x", { cwd: "/tmp/ws", mcpServers: [HOST] });

    await expect(ensureRealSession(server, "sess_x")).rejects.toThrow(/mcpServers/);

    expect(creates(calls)).toHaveLength(1);
    expect(server.userMcpRejected).toBe(false);
    expect(userMcpWarns()).toHaveLength(0);
  });

  it("a backend respawn voids the verdict (the new build may accept them)", () => {
    const server = new ZcodeAcpServer();
    server.userMcpRejected = true;
    server.resetBackendGeneration();
    expect(server.userMcpRejected).toBe(false);
  });
});
