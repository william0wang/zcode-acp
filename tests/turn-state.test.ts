/**
 * Tests for the turn-state out-of-band running indicator emitted by
 * prompt(): running:true when a turn starts, running:false when it ends, and
 * running:true from a preempted turn's finally while the preempting turn is
 * still in flight.
 *
 * The indicator is dual-emitted (#311): the deprecated `$/zcode/turnState`
 * (LSP-style) and the spec-compliant `_zcode/turnState` — every transition
 * must arrive identically on BOTH names so old and new consumers coexist
 * during the migration window.
 *
 * The fake backend drives prompt() end-to-end: `session/send` accepts the
 * prompt and synchronously delivers scripted events to every registered
 * listener (mirroring the real backend's per-session fan-out).
 */

import type * as acp from "@agentclientprotocol/sdk";
import {} from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";
vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

type TurnStatePayload = { sessionId: string; running: boolean };

/** cx that records every turnState notification payload, per method name.
 * Registering it on the server mirrors production (every connection lives in
 * the ClientRegistry) — the lifecycle transitions broadcast to the registry,
 * not to the prompt() argument. */
function collectCx(server?: ZcodeAcpServer): {
  cx: acp.AgentContext;
  /** Deprecated `$/zcode/turnState` payloads. */
  turnStates: TurnStatePayload[];
  /** Spec-compliant `_zcode/turnState` payloads (#311). */
  turnStatesV2: TurnStatePayload[];
} {
  const turnStates: TurnStatePayload[] = [];
  const turnStatesV2: TurnStatePayload[] = [];
  const cx = {
    notify: async (method: string, params: Record<string, unknown>) => {
      if (method === "$/zcode/turnState") {
        turnStates.push(params as TurnStatePayload);
      } else if (method === "_zcode/turnState") {
        turnStatesV2.push(params as TurnStatePayload);
      }
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  if (server) server.clients.add(cx);
  return { cx, turnStates, turnStatesV2 };
}

/** Fake backend whose session/send delivers `events()` to all listeners. */
function scriptedBackend(events: () => ZcodeEvent[]): ZcodeBackend {
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/subscribe":
          return { result: {} };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/send": {
          for (const e of events()) {
            for (const l of listeners) l.handleEvent(e);
          }
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

/** Server with a pre-registered, backend-loaded session (no create/resume). */
function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_ts", "zs_ts");
  server.markBackendLoaded("sess_ts");
  return server;
}

function promptParams(): acp.PromptRequest {
  return { sessionId: "sess_ts", prompt: [{ type: "text", text: "hello" }] } as acp.PromptRequest;
}

describe("$/zcode/turnState emission", () => {
  it("emits running:true at turn start and running:false at completion", async () => {
    const server = setup(
      scriptedBackend(() => [
        { type: "turn.started" },
        {
          type: "model.streaming",
          payload: { kind: "text_delta", delta: "hi", assistantMessageId: "m1" },
        },
        { type: "turn.completed", payload: { resultType: "success" } },
      ]),
    );
    const { cx, turnStates } = collectCx(server);

    const result = await prompt(server, promptParams(), cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(turnStates).toEqual([
      { sessionId: "sess_ts", running: true },
      { sessionId: "sess_ts", running: false },
    ]);
  });

  it("dual-emits the spec-compliant _zcode/turnState identically (#311)", async () => {
    // The `$/` spelling is the LSP convention — ACP reserves `_`-prefixed
    // names for extension notifications, and strict routers (the Python
    // agent-client-protocol library) error on it. Both names must carry the
    // exact same transitions while consumers migrate.
    const server = setup(
      scriptedBackend(() => [
        { type: "turn.started" },
        { type: "turn.completed", payload: { resultType: "success" } },
      ]),
    );
    const { cx, turnStates, turnStatesV2 } = collectCx(server);

    await prompt(server, promptParams(), cx, 9);

    expect(turnStatesV2).toEqual(turnStates);
    expect(turnStatesV2).toEqual([
      { sessionId: "sess_ts", running: true },
      { sessionId: "sess_ts", running: false },
    ]);
  });

  it("emits running:false when the turn fails before starting (subscribe error)", async () => {
    const backend = scriptedBackend(() => []);
    // Force session/subscribe to fail — prompt() must clean up the pending
    // turn and emit running:false before rethrowing.
    (backend as { request: unknown }).request = async (_id: number, method: string) =>
      method === "session/subscribe"
        ? { error: { code: -32000, message: "boom" } }
        : { result: {} };
    const server = setup(backend);
    const { cx, turnStates } = collectCx(server);

    await expect(prompt(server, promptParams(), cx, 2)).rejects.toThrow();

    expect(turnStates).toEqual([
      { sessionId: "sess_ts", running: true },
      { sessionId: "sess_ts", running: false },
    ]);
    expect(server.pendingTurns.size).toBe(0);
  });

  it("emits running:false on an intercepted slash command", async () => {
    const server = setup(scriptedBackend(() => []));
    const { cx, turnStates } = collectCx();

    const result = await prompt(
      server,
      { sessionId: "sess_ts", prompt: [{ type: "text", text: "/help" }] } as acp.PromptRequest,
      cx,
      1,
    );

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(turnStates).toEqual([{ sessionId: "sess_ts", running: false }]);
  });

  it("resends a non-retryable gateway 400 and recovers when the resend succeeds", async () => {
    // 2026-10-28 observation: a relay gateway intermittently answers 400
    // invalid_request_error (marked retryable:false by the upstream
    // classifier) on a request the same session accepts on resend. The turn
    // loop must give it the bounded resend instead of failing the session —
    // the retry notice reaches the prompting connection as a text chunk.
    let sendCount = 0;
    const backend = scriptedBackend(() => {
      sendCount++;
      if (sendCount > 1) {
        return [
          { type: "turn.started" },
          { type: "turn.completed", payload: { resultType: "success" } },
        ];
      }
      return [
        { type: "turn.started" },
        {
          type: "turn.failed",
          payload: {
            error: {
              code: "UNKNOWN_ERROR",
              message: "Turn execution failed",
              cause: {
                code: "invalid_model_request",
                message: "Upstream request failed: [invalid_request_error] gateway blip",
                context: { providerCode: "server_error", retryable: false },
              },
            },
          },
        },
      ];
    });
    const request = vi.spyOn(backend, "request");
    const server = setup(backend);
    const texts: string[] = [];
    const cx = {
      notify: async (_method: string, params: Record<string, unknown>) => {
        texts.push(JSON.stringify(params));
      },
      request: async () => ({}),
    } as unknown as acp.AgentContext;
    server.clients.add(cx);

    const result = await prompt(server, promptParams(), cx, 3);

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(request.mock.calls.filter((call) => call[1] === "session/send")).toHaveLength(2);
    // The user saw the retry happen, not a hard error.
    expect(texts.join("\n")).toContain("(1/5)");
  });

  it("degrades gracefully when gateway-blip retries are exhausted", async () => {
    // The session must survive an exhausted retry ladder: a user-visible
    // "please resend" notice plus end_turn — never a hard error that stops
    // the conversation (the pre-fix code threw the raw TurnFailedError from
    // the final attempt, leaving the graceful-degrade block unreachable).
    const backend = scriptedBackend(() => [
      { type: "turn.started" },
      {
        type: "turn.failed",
        payload: {
          error: {
            code: "UNKNOWN_ERROR",
            message: "Turn execution failed",
            cause: {
              code: "invalid_model_request",
              message: "Upstream request failed: [invalid_request_error] gateway down",
              context: { providerCode: "server_error", retryable: false },
            },
          },
        },
      },
    ]);
    const request = vi.spyOn(backend, "request");
    const server = setup(backend);
    const texts: string[] = [];
    const cx = {
      notify: async (_method: string, params: Record<string, unknown>) => {
        texts.push(JSON.stringify(params));
      },
      request: async () => ({}),
    } as unknown as acp.AgentContext;
    server.clients.add(cx);

    vi.useFakeTimers();
    let result: acp.PromptResponse | undefined;
    try {
      const promise = prompt(server, promptParams(), cx, 4);
      // Retry backoffs: 1s, 2s, 4s, 4s, 4s (plus slack).
      await vi.advanceTimersByTimeAsync(20_000);
      result = await promise;
    } finally {
      vi.useRealTimers();
    }

    // 1 initial attempt + 5 bounded resends, then the graceful degrade.
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(request.mock.calls.filter((call) => call[1] === "session/send")).toHaveLength(6);
    const joined = texts.join("\n");
    expect(joined).toContain("(5/5)");
    expect(joined).toMatch(/会话仍可用|still usable/);
  });
});

describe("backend-loaded stamp after backend-lost turns", () => {
  it("a FAILED backend-lost recovery leaves no stamp — the respawned backend never loaded the session", async () => {
    // Ghost-stamp regression (2026-10 review): the turn's finally used to
    // stamp backend-loaded unconditionally. A backend dying mid-turn with a
    // failed recovery (reload rejected on the fresh process) left a fresh
    // stamp vouching for a session the NEW backend never loaded — every
    // session/load in the TTL window then skipped the resume RPC and
    // replayed empty.
    const server = new ZcodeAcpServer();
    const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
    // The respawned generation: answers the registry ping, refuses the reload.
    const b2 = {
      isDead: false,
      request: async (_id: number, method: string) => {
        if (method === "session/resume") {
          return { error: { code: -32004, message: "Session is not active: zs_ts" } };
        }
        return { result: {} };
      },
      send: () => {},
      pollServerRequests: () => [],
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    let flipped = false;
    const b1 = {
      isDead: false,
      request: async (_id: number, method: string) => {
        switch (method) {
          case "workspace/updateProviderRegistry":
          case "session/subscribe":
            return { result: {} };
          case "session/read":
            return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
          case "session/messages":
            return { result: { messages: [] } };
          case "session/send": {
            for (const e of [
              { type: "turn.started" },
              {
                type: "turn.failed",
                payload: {
                  error: {
                    code: "UNKNOWN_ERROR",
                    message: "Turn execution failed",
                    cause: { code: "ERR_INVALID_STATE", message: "database is not open" },
                  },
                },
              },
            ] as ZcodeEvent[]) {
              for (const l of listeners) l.handleEvent(e);
            }
            // The process dies with the turn: by the time the recovery runs,
            // the world has already moved to a respawned backend (stamps
            // voided, exactly as ensureBackend's spawn branch does).
            flipped = true;
            b1.isDead = true;
            server.backend = b2;
            server.resetBackendGeneration();
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
      unregisterEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      },
    } as unknown as ZcodeBackend;
    server.backend = b1;
    server.registerSession("sess_ts", "zs_ts");
    server.markBackendLoaded("sess_ts");
    const { cx } = collectCx();

    await expect(prompt(server, promptParams(), cx, 7)).rejects.toThrow();

    expect(flipped).toBe(true);
    // No ghost stamp: the load path must re-resume instead of replaying empty.
    expect(server.isBackendSessionLive("sess_ts")).toBe(false);
  });
});

/**
 * resetBackendGeneration's foreign-turn settle broadcast (review 2026-11):
 * a backend-lost recovery respawn happens INSIDE runOneTurn with the turn
 * still registered — the settle value must be the /status union, not a bare
 * false, or the recovering session reads idle for the whole recovery turn.
 */
describe("resetBackendGeneration foreign-turn settle", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps running:true for a session with a pendingTurn (backend-lost recovery)", async () => {
    const server = new ZcodeAcpServer();
    server.registerSession("sess_ts", "zs_ts");
    const { turnStates, turnStatesV2 } = collectCx(server);
    server.foreignActiveTurns.set("zs_ts", "turn_dead");
    // The recovering turn is still registered (respawn inside runOneTurn).
    server.pendingTurns.set(1, { zcodeSid: "zs_ts", cancelled: false });

    server.resetBackendGeneration();
    await flush();

    expect(turnStates.map((t) => t.running)).toEqual([true]);
    expect(turnStatesV2.map((t) => t.running)).toEqual([true]);
  });
});
