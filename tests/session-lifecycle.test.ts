/**
 * Tests for the session/lifecycle alignment (app-server >= 0.17.1).
 *
 * The backend's SessionLifecycleController exposes the resident-runtime
 * lifecycle over `session/lifecycle/getState` (authoritative query) and the
 * standalone `session/lifecycle/changed` notification (transition push). The
 * bridge consumes exactly those two:
 *   - ensureBackendResident settles a stale backend-loaded stamp via the
 *     getState probe — `ready` refreshes the stamp and skips the full resume
 *     reload; a not-found answer fails with the evicted error before any
 *     reload; everything else keeps the reload path (the reload's resume
 *     carries mcpServers/toolDenylist, which lifecycle ensureReady does not);
 *   - applyLifecycleSnapshot feeds `changed` pushes into the stamps as
 *     INVALIDATION only — a teardown transition voids every ACP alias of the
 *     backend session; `ready` never re-stamps (instance-ready ≠
 *     projection-applied, and a foreign activation lacks the bridge's
 *     per-load config — the getState probe is the only ready-verifier);
 *   - the getState availability verdict is pinned per backend generation
 *     (pre-0.17.1 builds answer method-not-found).
 */

import { describe, expect, it } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { ensureRealSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

type GetStateResult =
  { error: { code?: number; message: string } } | { result?: { state?: string } };

/** Fake backend with a scriptable session/lifecycle/getState. */
function lifecycleBackend(getState: () => GetStateResult): {
  backend: ZcodeBackend;
  calls: Call[];
} {
  const calls: Call[] = [];
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "session/lifecycle/getState") return getState();
      return { result: {} };
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
}

/** Server with a registered mapping whose backend-loaded stamp is stale. */
function staleSetup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_ts", "zs_ts");
  // No markBackendLoaded — the verification is stale by construction.
  expect(server.isBackendSessionLive("sess_ts")).toBe(false);
  return server;
}

const count = (calls: Call[], method: string) => calls.filter((c) => c.method === method).length;

describe("ensureBackendResident — session/lifecycle/getState probe", () => {
  it("a ready state refreshes the stamp without any resume reload", async () => {
    const { backend, calls } = lifecycleBackend(() => ({ result: { state: "ready" } }));
    const server = staleSetup(backend);

    await expect(ensureRealSession(server, "sess_ts")).resolves.toBe("zs_ts");

    expect(count(calls, "session/lifecycle/getState")).toBe(1);
    expect(count(calls, "session/resume")).toBe(0);
    expect(server.isBackendSessionLive("sess_ts")).toBe(true);
    expect(server.backendLifecycleApi).toBe(true);
  });

  it("an unloaded state keeps the reload path (resume carries mcpServers/toolDenylist)", async () => {
    const { backend, calls } = lifecycleBackend(() => ({ result: { state: "unloaded" } }));
    const server = staleSetup(backend);

    await expect(ensureRealSession(server, "sess_ts")).resolves.toBe("zs_ts");

    expect(count(calls, "session/resume")).toBe(1);
    expect(server.isBackendSessionLive("sess_ts")).toBe(true);
  });

  it("a not-found answer throws the evicted error before any reload", async () => {
    const { backend, calls } = lifecycleBackend(() => ({
      error: { code: -32004, message: "Session not found: zs_ts" },
    }));
    const server = staleSetup(backend);

    await expect(ensureRealSession(server, "sess_ts")).rejects.toThrow("sess_ts");
    expect(count(calls, "session/resume")).toBe(0);
  });

  it("method-not-found pins the verdict per generation — later staleness skips the probe", async () => {
    let state: GetStateResult = { error: { code: -32601, message: "Method not found" } };
    const { backend, calls } = lifecycleBackend(() => state);
    const server = staleSetup(backend);

    // First stale pass: the probe is paid once, then the reload runs.
    await expect(ensureRealSession(server, "sess_ts")).resolves.toBe("zs_ts");
    expect(count(calls, "session/lifecycle/getState")).toBe(1);
    expect(count(calls, "session/resume")).toBe(1);
    expect(server.backendLifecycleApi).toBe(false);

    // Second stale pass: no second getState — the pinned verdict short-circuits.
    server.backendLoadedSessions.delete("sess_ts");
    await expect(ensureRealSession(server, "sess_ts")).resolves.toBe("zs_ts");
    expect(count(calls, "session/lifecycle/getState")).toBe(1);
    expect(count(calls, "session/resume")).toBe(2);
  });

  it("a transient probe failure falls through to the reload (fail-safe)", async () => {
    const { backend, calls } = lifecycleBackend(() => ({ error: { message: "timeout" } }));
    const server = staleSetup(backend);

    await expect(ensureRealSession(server, "sess_ts")).resolves.toBe("zs_ts");
    expect(count(calls, "session/resume")).toBe(1);
  });

  it("a result without a state field reads as unknown and reloads (shape drift)", async () => {
    const { backend, calls } = lifecycleBackend(() => ({ result: {} }));
    const server = staleSetup(backend);

    await expect(ensureRealSession(server, "sess_ts")).resolves.toBe("zs_ts");
    expect(count(calls, "session/resume")).toBe(1);
  });

  it("skips the probe entirely while a turn for the session is in flight", async () => {
    const { backend, calls } = lifecycleBackend(() => ({ result: { state: "ready" } }));
    const server = staleSetup(backend);
    server.pendingTurns.set(1, { zcodeSid: "zs_ts", cancelled: false });

    await expect(ensureRealSession(server, "sess_ts")).resolves.toBe("zs_ts");
    expect(count(calls, "session/lifecycle/getState")).toBe(0);
    expect(count(calls, "session/resume")).toBe(0);
  });
});

describe("applyLifecycleSnapshot — session/lifecycle/changed feed", () => {
  it("ready never re-stamps — a foreign activation must not bless replay reads", () => {
    const server = new ZcodeAcpServer();
    server.registerSession("sess_a", "zs_x");
    server.registerSession("sess_b", "zs_x");

    // Foreign re-activation (v4 gateway cold-resume, automation wake): the
    // instance is ready but the projection may still be hydrating, and the
    // runtime lacks the bridge's per-load mcpServers/toolDenylist. A stamp
    // here would make session/load skip its resume flight + settle.
    server.applyLifecycleSnapshot({ sessionId: "zs_x", state: "ready" });

    expect(server.isBackendSessionLive("sess_a")).toBe(false);
    expect(server.isBackendSessionLive("sess_b")).toBe(false);
  });

  it("a teardown transition voids the stamps of every alias", () => {
    const server = new ZcodeAcpServer();
    server.registerSession("sess_a", "zs_x");
    server.registerSession("sess_b", "zs_x");
    server.markBackendLoaded("sess_a");
    server.markBackendLoaded("sess_b");

    // The resident pool deactivates the runtime (idle TTL / LRU).
    server.applyLifecycleSnapshot({ sessionId: "zs_x", state: "unloaded" });

    expect(server.isBackendSessionLive("sess_a")).toBe(false);
    expect(server.isBackendSessionLive("sess_b")).toBe(false);

    // Transient activation states are not residency proofs either.
    server.markBackendLoaded("sess_a");
    server.applyLifecycleSnapshot({ sessionId: "zs_x", state: "starting" });
    expect(server.isBackendSessionLive("sess_a")).toBe(false);
  });

  it("ignores backend sessions without an ACP mapping", () => {
    const server = new ZcodeAcpServer();
    server.registerSession("sess_a", "zs_x");
    server.markBackendLoaded("sess_a");

    server.applyLifecycleSnapshot({ sessionId: "zs_other", state: "unloaded" });

    expect(server.isBackendSessionLive("sess_a")).toBe(true);
  });
});

describe("backend generation reset", () => {
  it("resetBackendGeneration clears the lifecycle API verdict", () => {
    const server = new ZcodeAcpServer();
    server.backendLifecycleApi = false;
    server.resetBackendGeneration();
    expect(server.backendLifecycleApi).toBeNull();

    server.backendLifecycleApi = true;
    server.resetBackendGeneration();
    expect(server.backendLifecycleApi).toBeNull();
  });
});
