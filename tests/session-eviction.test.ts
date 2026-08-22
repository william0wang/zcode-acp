/**
 * Tests for recovery from backend resident eviction.
 *
 * The zcode backend evicts idle resident runtimes (~10min idle timeout, plus
 * an LRU cap). An evicted session fails every session-scoped RPC with code
 * -32004 "Session is not active" while the session file stays intact, and
 * `session/resume` reloads it. The bridge must self-heal instead of surfacing
 * the error:
 *   - prompt(): subscribe fails with "Session is not active" → resume →
 *     re-baseline the differ → re-subscribe once;
 *   - ensureRealSession(): a mapping whose backend-loaded verification went
 *     stale is reloaded before use (fail-safe on reload failure);
 *   - resolveResumeTarget(): stale verifications don't skip the resume RPC
 *     (otherwise the replay comes back empty — the "remote sees an empty
 *     session" symptom).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { ensureRealSession, loadSession, prompt } from "../src/handlers/session.js";
import { BACKEND_RESIDENT_TTL_MS, ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** Fake backend with per-method call recording and eviction scripting. */
function fakeBackend(opts: {
  /** First N session/subscribe calls fail with -32004 "Session is not active". */
  subscribeFailures?: number;
  /** session/resume responds with this error instead of success. */
  resumeError?: { code: number; message: string };
  /** History returned by session/messages. */
  history?: unknown[];
}): { backend: ZcodeBackend; calls: Call[] } {
  const calls: Call[] = [];
  let subscribeCount = 0;
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  const backend = {
    isDead: false,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      switch (method) {
        case "workspace/updateProviderRegistry":
          return { result: {} };
        case "session/subscribe": {
          subscribeCount++;
          if (subscribeCount <= (opts.subscribeFailures ?? 0)) {
            return {
              error: { code: -32004, message: "Session is not active: zs_ts" },
            };
          }
          return { result: { eventSeq: 0 } };
        }
        case "session/resume":
          return opts.resumeError ? { error: opts.resumeError } : { result: {} };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { result: { messages: opts.history ?? [] } };
        case "session/send": {
          const events: ZcodeEvent[] = [
            { type: "turn.started" },
            { type: "turn.completed", payload: { resultType: "success" } },
          ];
          for (const e of events) {
            for (const l of listeners) l.handleEvent(e);
          }
          return { result: { accepted: true } };
        }
        default:
          return { result: {} };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
}

function stubCx(): acp.AgentContext {
  return { notify: async () => {}, request: async () => ({}) } as unknown as acp.AgentContext;
}

function promptParams(): acp.PromptRequest {
  return { sessionId: "sess_ts", prompt: [{ type: "text", text: "hello" }] } as acp.PromptRequest;
}

/** Server with a registered mapping + fresh backend-loaded verification. */
function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_ts", "zs_ts");
  server.markBackendLoaded("sess_ts");
  return server;
}

const count = (calls: Call[], method: string) => calls.filter((c) => c.method === method).length;

describe("prompt() eviction recovery", () => {
  it("reloads an evicted session via session/resume and completes the turn", async () => {
    const { backend, calls } = fakeBackend({ subscribeFailures: 1 });
    const server = setup(backend);

    const result = await prompt(server, promptParams(), stubCx(), 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    const resume = calls.find((c) => c.method === "session/resume");
    expect(resume?.params).toMatchObject({ sessionId: "zs_ts", workspace: {} });
    expect(count(calls, "session/subscribe")).toBe(2);
    // Baseline fetch ran once against the evicted session and again after the
    // reload (differ re-baseline) — turn completion must not replay history.
    expect(count(calls, "session/messages")).toBeGreaterThanOrEqual(2);
    expect(server.pendingTurns.size).toBe(0);
  });

  it("propagates non-eviction subscribe errors without attempting a resume", async () => {
    const calls: Call[] = [];
    const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
    const backend = {
      isDead: false,
      request: async (_id: number, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "session/subscribe") {
          return { error: { code: -32001, message: "zcode backend reader exited" } };
        }
        return { result: {} };
      },
      send: () => {},
      pollServerRequests: () => [],
      registerEventListener: (_s: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
        listeners.push(l);
      },
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    const server = setup(backend);

    await expect(prompt(server, promptParams(), stubCx(), 2)).rejects.toThrow(/reader exited/);
    expect(calls.some((c) => c.method === "session/resume")).toBe(false);
    expect(server.pendingTurns.size).toBe(0);
  });

  it("propagates when the recovery resume itself fails", async () => {
    const { backend, calls } = fakeBackend({
      subscribeFailures: 1,
      resumeError: { code: -32004, message: "Session is not active: zs_ts" },
    });
    const server = setup(backend);

    await expect(prompt(server, promptParams(), stubCx(), 3)).rejects.toThrow(/resume failed/);
    expect(count(calls, "session/subscribe")).toBe(1);
    expect(server.pendingTurns.size).toBe(0);
  });
});

describe("ensureRealSession() eviction guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reloads a stale mapping into the backend before returning it", async () => {
    const { backend, calls } = fakeBackend({});
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.registerSession("sess_ts", "zs_ts");
    // No markBackendLoaded → verification is stale.

    const sid = await ensureRealSession(server, "sess_ts");

    expect(sid).toBe("zs_ts");
    expect(calls.some((c) => c.method === "session/resume")).toBe(true);
    expect(server.isBackendSessionLive("sess_ts")).toBe(true);
  });

  it("skips the reload while a turn for the session is in flight", async () => {
    const { backend, calls } = fakeBackend({});
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.registerSession("sess_ts", "zs_ts");
    server.pendingTurns.set(1, { zcodeSid: "zs_ts", cancelled: false });

    const sid = await ensureRealSession(server, "sess_ts");

    expect(sid).toBe("zs_ts");
    expect(calls.some((c) => c.method === "session/resume")).toBe(false);
  });

  it("is fail-safe when the reload RPC fails", async () => {
    const { backend, calls } = fakeBackend({
      resumeError: { code: -32004, message: "Session is not active: zs_ts" },
    });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.registerSession("sess_ts", "zs_ts");

    const sid = await ensureRealSession(server, "sess_ts");

    expect(sid).toBe("zs_ts");
    expect(calls.some((c) => c.method === "session/resume")).toBe(true);
  });
});

describe("backend-loaded verification TTL", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expires after BACKEND_RESIDENT_TTL_MS", () => {
    const server = new ZcodeAcpServer();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    server.markBackendLoaded("s");
    expect(server.isBackendSessionLive("s")).toBe(true);
    now += BACKEND_RESIDENT_TTL_MS - 1;
    expect(server.isBackendSessionLive("s")).toBe(true);
    now += 2;
    expect(server.isBackendSessionLive("s")).toBe(false);
  });

  it("session/load re-issues the resume RPC once the verification went stale", async () => {
    const { backend, calls } = fakeBackend({ history: [] });
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.registerSession("s-old", "sess_old");
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    server.markBackendLoaded("s-old");

    // Fresh verification → resume skipped.
    await loadSession(server, { sessionId: "s-old" } as acp.LoadSessionRequest, stubCx());
    expect(count(calls, "session/resume")).toBe(0);

    // Same bridge lifetime, but the resident was evicted in between (idle
    // timeout passed while nobody used the session) → resume re-issued.
    now += 6 * 60_000;
    await loadSession(server, { sessionId: "s-old" } as acp.LoadSessionRequest, stubCx());
    expect(count(calls, "session/resume")).toBe(1);
  });
});
