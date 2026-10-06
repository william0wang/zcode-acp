/**
 * Tests for the `$/zcode/turnState` out-of-band running indicator emitted by
 * prompt(): running:true when a turn starts, running:false when it ends, and
 * running:true from a preempted turn's finally while the preempting turn is
 * still in flight.
 *
 * The fake backend drives prompt() end-to-end: `session/send` accepts the
 * prompt and synchronously delivers scripted events to every registered
 * listener (mirroring the real backend's per-session fan-out).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

/** cx that records every $/zcode/turnState notification payload. */
function collectCx(): {
  cx: acp.AgentContext;
  turnStates: Array<{ sessionId: string; running: boolean }>;
} {
  const turnStates: Array<{ sessionId: string; running: boolean }> = [];
  const cx = {
    notify: async (method: string, params: Record<string, unknown>) => {
      if (method === "$/zcode/turnState") {
        turnStates.push(params as { sessionId: string; running: boolean });
      }
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, turnStates };
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
    const { cx, turnStates } = collectCx();

    const result = await prompt(server, promptParams(), cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(turnStates).toEqual([
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
    const { cx, turnStates } = collectCx();

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

  it("preserves a non-retryable model quota failure in the ACP error", async () => {
    const server = setup(
      scriptedBackend(() => [
        { type: "turn.started" },
        {
          type: "turn.failed",
          payload: {
            error: {
              code: "UNKNOWN_ERROR",
              message: "Turn execution failed",
              cause: {
                code: "model_rate_limited",
                message: "Usage limit reached; resets later",
                context: {
                  providerCode: "1308",
                  responseStatus: 429,
                  reason: "rate_limited",
                  retryable: false,
                  responseBodySummary: {
                    responseHeaders: { "retry-after": "1118", "set-cookie": "secret" },
                  },
                },
              },
            },
          },
        },
      ]),
    );
    const { cx, turnStates } = collectCx();

    const error = await prompt(server, promptParams(), cx, 3).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({
      name: "RequestError",
      code: -32603,
      message: "ZCode turn failed: model_rate_limited Usage limit reached; resets later",
      data: {
        type: "zcode_turn_failed",
        code: "model_rate_limited",
        reason: "rate_limited",
        statusCode: 429,
        providerCode: "1308",
        retryable: false,
        retryAfterMs: 1_118_000,
      },
    });
    expect(JSON.stringify((error as { data?: unknown }).data)).not.toContain("secret");
    expect(turnStates).toEqual([
      { sessionId: "sess_ts", running: true },
      { sessionId: "sess_ts", running: false },
    ]);
  });

  it("preempted turn's exit reports running:true while the preemptor is in flight", async () => {
    let sendCount = 0;
    const server = setup(
      scriptedBackend(() => {
        sendCount++;
        if (sendCount === 1) {
          // Turn 1 starts but never completes on its own — it stays parked in
          // its event loop until turn 2's events (fan-out to all listeners)
          // carry the terminal event.
          return [{ type: "turn.started" }];
        }
        return [
          { type: "turn.started" },
          {
            type: "model.streaming",
            payload: { kind: "text_delta", delta: "two", assistantMessageId: "m2" },
          },
          { type: "turn.completed", payload: { resultType: "success" } },
        ];
      }),
    );
    const { cx, turnStates } = collectCx();

    const p1 = prompt(server, promptParams(), cx, 101);
    // Wait until turn 1 has been accepted and parked in its event loop (its
    // turn.started is consumed on the first poll after send accepts).
    await vi.waitFor(() => expect(sendCount).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const p2 = prompt(server, promptParams(), cx, 102);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual({ stopReason: "cancelled" });
    expect(r2).toEqual({ stopReason: "end_turn" });
    expect(turnStates).toEqual([
      { sessionId: "sess_ts", running: true }, // turn 1 starts
      { sessionId: "sess_ts", running: true }, // turn 2 starts (preemptor)
      { sessionId: "sess_ts", running: true }, // turn 1 exits, still busy
      { sessionId: "sess_ts", running: false }, // turn 2 completes
    ]);
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

  it("a turn that runs to completion still refreshes the stamp", async () => {
    const server = setup(
      scriptedBackend(() => [
        { type: "turn.started" },
        { type: "turn.completed", payload: { resultType: "success" } },
      ]),
    );
    const { cx } = collectCx();

    const result = await prompt(server, promptParams(), cx, 8);

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(server.isBackendSessionLive("sess_ts")).toBe(true);
  });
});
