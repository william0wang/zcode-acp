/**
 * Regression coverage for a stale `projection.status === "running"` keeping
 * the event turn alive forever.  The public `prompt()` boundary is used so the
 * test covers the real listener, monitor, and timeout wiring together.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import "../src/handlers/slash.js";
import { prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

interface StaleBackendControl {
  backend: ZcodeBackend;
  emit: (event: ZcodeEvent) => void;
  goalProbes: ReturnType<typeof vi.fn>;
  setPromptLockHeld: (held: boolean) => void;
  sendRequests: ReturnType<typeof vi.fn>;
}

function staleRunningBackend(): StaleBackendControl {
  const listeners = new Set<{ handleEvent: (event: ZcodeEvent) => void }>();
  let promptLockHeld = false;
  const goalProbes = vi.fn(async () =>
    promptLockHeld
      ? { error: { message: "session goal: prompt is running" } }
      : { result: { goal: null } },
  );
  const sendRequests = vi.fn();
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
          return { result: {} };
        case "session/subscribe":
          return { result: { eventSeq: 1 } };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/read":
          return {
            result: {
              projection: { status: "running", contextUsed: 0 },
              settings: {},
            },
          };
        case "session/goal":
          return goalProbes();
        case "session/send":
          sendRequests();
          for (const listener of listeners) listener.handleEvent({ type: "turn.started" });
          return { result: { accepted: true } };
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: vi.fn(),
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, listener: { handleEvent: (event: ZcodeEvent) => void }) =>
      listeners.add(listener),
    unregisterEventListener: (
      _sid: string,
      listener: { handleEvent: (event: ZcodeEvent) => void },
    ) => listeners.delete(listener),
  } as unknown as ZcodeBackend;
  return {
    backend,
    emit: (event) => {
      for (const listener of listeners) listener.handleEvent(event);
    },
    goalProbes,
    setPromptLockHeld: (held) => {
      promptLockHeld = held;
    },
    sendRequests,
  };
}

function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_stale", "zs_stale");
  server.markBackendLoaded("sess_stale");
  return server;
}

const params = {
  sessionId: "sess_stale",
  prompt: [{ type: "text", text: "hello" }],
} as acp.PromptRequest;

const cx = {
  notify: vi.fn().mockResolvedValue(undefined),
  request: vi.fn().mockResolvedValue({}),
} as unknown as acp.AgentContext;

describe("stale running projection recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("bounds a silent turn when running is stale and the prompt lock is released", async () => {
    const { backend, goalProbes, sendRequests } = staleRunningBackend();
    const turn = prompt(setup(backend), params, cx, 1);
    let result: acp.PromptResponse | undefined;
    void turn.then((value) => {
      result = value;
    });

    // Let prompt() finish its immediate setup/subscribe/send chain before the
    // large time jump; otherwise fake time can advance before runEventTurn has
    // captured its initial deadline.
    for (let i = 0; i < 20 && sendRequests.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(sendRequests).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(121_000);

    expect(result).toEqual({ stopReason: "max_turn_requests" });
    expect(goalProbes).toHaveBeenCalled();
  });

  it("does not cancel an active tool while the prompt lock is still held", async () => {
    const control = staleRunningBackend();
    control.setPromptLockHeld(true);
    const turn = prompt(setup(control.backend), params, cx, 2);
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    for (let i = 0; i < 20 && control.sendRequests.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(control.sendRequests).toHaveBeenCalledOnce();
    control.emit({
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "tool-1",
        toolName: "Read",
        input: { file_path: "/tmp/example" },
      },
    });
    control.emit({
      type: "tool.updated",
      payload: { kind: "started", toolCallId: "tool-1", toolName: "Read" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(121_000);

    expect(control.goalProbes).toHaveBeenCalled();
    expect(settled).toBe(false);

    control.emit({ type: "turn.completed", payload: { resultType: "success" } });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(turn).resolves.toEqual({ stopReason: "end_turn" });
  });
});
