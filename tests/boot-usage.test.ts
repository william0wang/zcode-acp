/**
 * Initial usage_update after session/new (ADR-0021): martty-gated, deferred
 * past the response, and — unlike emitInitialUsage — NOT skipped when the
 * projection reports 0 tokens, so the TUI context window shows from boot.
 * Also covers the read-only `quota` config option no-op on set_config_option.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { buildConfigOptions } from "../src/config/options.js";
import { newSession, setConfigOptionHandler } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

// Keep the quota refresher offline in these tests (it starts on martty
// session/new): no hub, and a direct query that reports unavailable.
vi.mock("../src/quota/index.js", () => ({ queryQuota: async () => ({ kind: "unavailable" }) }));
vi.mock("../src/remote/config.js", () => ({ parseRemoteConfig: () => null }));

/** Fake backend answering the minimal session/read surface. */
function fakeBackend(contextUsed = 0): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      if (method === "session/read") {
        return { result: { projection: { status: "idle", contextUsed } } };
      }
      return { result: {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

interface RecordedUpdate {
  sessionId: string;
  update: Record<string, unknown>;
}

function recordingCx(connectionContext?: unknown): {
  cx: acp.AgentContext;
  updates: RecordedUpdate[];
} {
  const updates: RecordedUpdate[] = [];
  return {
    updates,
    cx: {
      connectionContext,
      notify: async (
        _method: string,
        params: { sessionId: string; update: Record<string, unknown> },
      ) => {
        updates.push({ sessionId: params.sessionId, update: params.update });
      },
    } as unknown as acp.AgentContext,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  delete process.env.ZCODE_ACP_RESUME_SESSION;
});

describe("boot usage_update", () => {
  it("emits an initial usage_update (used may be 0) for martty after session/new", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(0);
    server.marttyClientSeen = true;
    const { cx, updates } = recordingCx();
    vi.spyOn(server.clients, "broadcast").mockReturnValue(cx);

    const resp = await newSession(server, { cwd: "/tmp/proj" } as acp.NewSessionRequest, cx);
    expect(resp.sessionId).toBeTruthy();
    await flush();

    const usage = updates.filter((u) => u.update.sessionUpdate === "usage_update");
    expect(usage.length).toBe(1);
    // Lazy placeholder: no backend projection yet → used 0, size from config.
    expect(usage[0]!.update.used).toBe(0);
    expect(typeof usage[0]!.update.size).toBe("number");
  });

  it("is skipped for non-martty clients", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(0);
    const { cx, updates } = recordingCx();
    vi.spyOn(server.clients, "broadcast").mockReturnValue(cx);

    await newSession(server, { cwd: "/tmp/proj" } as acp.NewSessionRequest, cx);
    await flush();
    expect(updates.filter((u) => u.update.sessionUpdate === "usage_update")).toHaveLength(0);
  });

  it("covers the boot-resume interception path (used 0 is NOT skipped)", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(0);
    server.marttyClientSeen = true;
    server.registerSession("sess_boot", "zsess_boot");
    const { cx, updates } = recordingCx();
    vi.spyOn(server.clients, "broadcast").mockReturnValue(cx);
    process.env.ZCODE_ACP_RESUME_SESSION = "sess_boot";

    await newSession(server, { cwd: "/tmp/proj" } as acp.NewSessionRequest, cx);
    await flush();

    const usage = updates.filter(
      (u) => u.update.sessionUpdate === "usage_update" && u.sessionId === "sess_boot",
    );
    expect(usage.length).toBe(1);
    expect(usage[0]!.update.used).toBe(0);
  });
});

describe("per-connection martty gating (ADR-0021)", () => {
  it("initialize records the martty connection's root, not a process-wide flag", async () => {
    const server = new ZcodeAcpServer();
    const tuiRoot = { id: "tui" };
    const appRoot = { id: "app" };
    await server.initialize(
      { clientInfo: { name: "Martty" } } as acp.InitializeRequest,
      recordingCx(tuiRoot).cx,
    );
    await server.initialize(
      { clientInfo: { name: "Paseo iOS" } } as acp.InitializeRequest,
      recordingCx(appRoot).cx,
    );
    expect(server.marttyClientSeen).toBe(true);
    expect(server.marttyConnectionRoots.has(tuiRoot)).toBe(true);
    expect(server.marttyConnectionRoots.has(appRoot)).toBe(false);
  });

  it("session/new from a non-martty connection does not become a dock target", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(0);
    server.quotaDock = "5h 50%";
    // A TUI connected earlier in the process (sticky flag set, its root known).
    const tuiRoot = { id: "tui" };
    await server.initialize(
      { clientInfo: { name: "Martty" } } as acp.InitializeRequest,
      recordingCx(tuiRoot).cx,
    );
    const appRoot = { id: "app" };
    const { cx } = recordingCx(appRoot);
    vi.spyOn(server.clients, "broadcast").mockReturnValue(cx);

    const resp = await newSession(server, { cwd: "/tmp/proj" } as acp.NewSessionRequest, cx);
    expect(server.marttyConnectionRoots.has(appRoot)).toBe(false);
    // The app's response must not carry the spec-external quota pseudo-option.
    expect(resp.configOptions.some((o) => o.id === "quota")).toBe(false);
    expect(resp.configOptions.some((o) => o.id === "model")).toBe(true);
  });

  it("session/new from the martty connection keeps the quota option", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend(0);
    server.quotaDock = "5h 50%";
    const tuiRoot = { id: "tui" };
    await server.initialize(
      { clientInfo: { name: "Martty" } } as acp.InitializeRequest,
      recordingCx(tuiRoot).cx,
    );
    const { cx } = recordingCx(tuiRoot);
    vi.spyOn(server.clients, "broadcast").mockReturnValue(cx);

    const resp = await newSession(server, { cwd: "/tmp/proj" } as acp.NewSessionRequest, cx);
    expect(resp.configOptions.some((o) => o.id === "quota")).toBe(true);
  });

  it("buildConfigOptions appends quota only for a martty receiver root", async () => {
    const server = new ZcodeAcpServer();
    server.quotaDock = "5h 50%";
    const tuiRoot = { id: "tui" };
    server.marttyConnectionRoots.add(tuiRoot);
    const withMartty = await buildConfigOptions(server, null, tuiRoot);
    expect(withMartty.some((o) => o.id === "quota")).toBe(true);
    const withApp = await buildConfigOptions(server, null, { id: "app" });
    expect(withApp.some((o) => o.id === "quota")).toBe(false);
    const withNone = await buildConfigOptions(server, null);
    expect(withNone.some((o) => o.id === "quota")).toBe(false);
  });
});

describe("quota config option no-op", () => {
  it("set_config_option on quota returns the options without error", async () => {
    const server = new ZcodeAcpServer();
    const { cx } = recordingCx();
    const resp = await setConfigOptionHandler(
      server,
      { sessionId: "s", configId: "quota", value: "5h 99%" } as acp.SetSessionConfigOptionRequest,
      cx,
    );
    expect(Array.isArray(resp.configOptions)).toBe(true);
    expect(resp.configOptions.some((o) => o.id === "model")).toBe(true);
  });
});
