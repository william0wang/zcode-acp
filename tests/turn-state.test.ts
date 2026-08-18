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
  server.backendLoadedSessions.add("sess_ts");
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
