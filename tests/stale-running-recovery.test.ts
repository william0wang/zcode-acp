/**
 * Regression coverage for stall termination in `runEventTurn`.
 *
 * History: PR #85 killed a turn after 120s of stream silence whenever a
 * `session/goal show` probe answered without the 1308 lock error. Raw-backend
 * probes (Aug-28 app-server) proved that probe worthless — goal show succeeds
 * mid-turn, and even a probe `session/send` is accepted as steer input while
 * the turn runs — so live sub-agent turns behind a silent stream were being
 * murdered after 2 minutes. The replacement policy keys on the read-projection
 * watermark (contextUsed/totalTokenCount/turnCount/currentTurnId): advancing
 * watermark = alive (wait), watermark frozen past STALE_FREEZE_MS (10 min) =
 * stale (end gently, stop as last resort).
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
  sendRequests: ReturnType<typeof vi.fn>;
  /** "advance": every session/read bumps contextUsed (live sub-agent). "frozen": never changes. */
  setWatermarkMode: (mode: "advance" | "frozen") => void;
}

function staleRunningBackend(): StaleBackendControl {
  const listeners = new Set<{ handleEvent: (event: ZcodeEvent) => void }>();
  let watermarkMode: "advance" | "frozen" = "frozen";
  let contextUsed = 0;
  // Kept only to assert the goal channel is NEVER consulted again — it cannot
  // see turn liveness (verified against the real backend).
  const goalProbes = vi.fn(async () => ({ result: { goal: null } }));
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
        case "session/read": {
          if (watermarkMode === "advance") contextUsed += 1000;
          return {
            result: {
              projection: { status: "running", contextUsed, contextWindow: 1000000 },
              settings: {},
            },
          };
        }
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
    sendRequests,
    setWatermarkMode: (mode) => {
      watermarkMode = mode;
    },
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

/** Pump the micro-task queue until prompt() has fired its session/send. */
async function waitForSend(sendRequests: ReturnType<typeof vi.fn>) {
  for (let i = 0; i < 80 && sendRequests.mock.calls.length === 0; i++) {
    await Promise.resolve();
  }
  expect(sendRequests).toHaveBeenCalledOnce();
}

describe("stall termination policy (watermark-based)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps a silently-running sub-agent turn alive while the read watermark advances", async () => {
    // The user-visible bug: a sub-agent works behind a silent event stream for
    // minutes. The read watermark keeps moving (contextUsed grows on every
    // 15s stall-reconcile probe), so the turn must NOT be killed at the 120s
    // no-progress deadline — nor ever, while the watermark keeps advancing.
    const control = staleRunningBackend();
    control.setWatermarkMode("advance");
    const turn = prompt(setup(control.backend), params, cx, 1);
    let settled: acp.PromptResponse | undefined;
    void turn.then((value) => {
      settled = value;
    });
    await waitForSend(control.sendRequests);

    await vi.advanceTimersByTimeAsync(121_000);
    expect(settled).toBeUndefined(); // old goal-probe code killed the turn here

    // Still alive long past any single deadline window.
    await vi.advanceTimersByTimeAsync(700_000);
    expect(settled).toBeUndefined();

    control.emit({ type: "turn.completed", payload: { resultType: "success" } });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(turn).resolves.toEqual({ stopReason: "end_turn" });
    expect(control.goalProbes).not.toHaveBeenCalled();
    expect(control.backend.send).not.toHaveBeenCalled();
  });

  it("forwards evidence-backed progress during an ACP-visible silent window", async () => {
    // An upstream ACP client may enforce an idle deadline shorter than this
    // bridge's 10-minute stale-freeze budget.  The bridge's authoritative
    // session/read probes must therefore surface real progress before that
    // client gives up: usage when the watermark advances, or an in-progress
    // refresh for a known active tool.  Transcript text is not a heartbeat.
    const control = staleRunningBackend();
    control.setWatermarkMode("advance");
    const turn = prompt(setup(control.backend), params, cx, 4);
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await waitForSend(control.sendRequests);

    control.emit({
      type: "tool.updated",
      payload: { kind: "started", toolCallId: "tool-live", toolName: "Bash" },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(cx.notify).mockClear();

    // Omnigent's default ACP idle deadline is 300 seconds.  At least four
    // throttled, state-bearing updates over this interval leave comfortable
    // scheduling headroom without flooding clients.
    await vi.advanceTimersByTimeAsync(301_000);

    const updates = vi
      .mocked(cx.notify)
      .mock.calls.map(([, payload]) => (payload as { update?: acp.SessionUpdate }).update);
    const progress = updates.filter(
      (update) =>
        update?.sessionUpdate === "usage_update" ||
        (update?.sessionUpdate === "tool_call_update" && update.status === "in_progress"),
    );
    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(
      updates.some(
        (update) =>
          update?.sessionUpdate === "agent_message_chunk" ||
          update?.sessionUpdate === "agent_thought_chunk",
      ),
    ).toBe(false);
    expect(settled).toBe(false);

    control.emit({ type: "turn.completed", payload: { resultType: "success" } });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(turn).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("refreshes a known active tool while its watermark is inside the stale budget", async () => {
    // A long quiet tool may not consume tokens, so its watermark can remain
    // frozen legitimately for part of the 10-minute grace period.  Refreshing
    // the existing card is state-bearing and must keep a shorter upstream ACP
    // idle deadline alive without creating transcript rows.
    const control = staleRunningBackend();
    control.setWatermarkMode("frozen");
    const turn = prompt(setup(control.backend), params, cx, 5);
    await waitForSend(control.sendRequests);

    control.emit({
      type: "tool.updated",
      payload: { kind: "started", toolCallId: "tool-quiet", toolName: "Bash" },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(cx.notify).mockClear();

    await vi.advanceTimersByTimeAsync(301_000);

    const updates = vi
      .mocked(cx.notify)
      .mock.calls.map(([, payload]) => (payload as { update?: acp.SessionUpdate }).update);
    const refreshes = updates.filter(
      (update) =>
        update?.sessionUpdate === "tool_call_update" &&
        update.toolCallId === "tool-quiet" &&
        update.status === "in_progress",
    );
    expect(refreshes.length).toBeGreaterThanOrEqual(4);

    control.emit({ type: "turn.completed", payload: { resultType: "success" } });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(turn).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("ends a watermark-frozen turn after the stale-freeze budget (no output → stop)", async () => {
    // PR #85's original goal stays: a projection stuck at `running` whose
    // watermark never advances must eventually converge instead of hanging
    // forever. Nothing was emitted, no reply can be fetched → bounded stop.
    const control = staleRunningBackend();
    control.setWatermarkMode("frozen");
    const server = setup(control.backend);
    const turn = prompt(server, params, cx, 2);
    let result: acp.PromptResponse | undefined;
    void turn.then((value) => {
      result = value;
    });
    await waitForSend(control.sendRequests);

    await vi.advanceTimersByTimeAsync(121_000);
    expect(result).toBeUndefined(); // 120s freeze alone must not kill yet

    // 10-minute stale-freeze budget from the first watermark read (~15s in).
    await vi.advanceTimersByTimeAsync(700_000);

    expect(result).toEqual({ stopReason: "max_turn_requests" });
    expect(control.backend.send).toHaveBeenCalled(); // stopBackendTurn fired
    expect(control.goalProbes).not.toHaveBeenCalled();
  });

  it("ends a watermark-frozen turn gently when output was already delivered", async () => {
    // Same freeze, but a tool card was already streamed: the turn is treated
    // as completed-but-terminal-event-lost — end_turn, no backend stop.
    const control = staleRunningBackend();
    control.setWatermarkMode("frozen");
    const turn = prompt(setup(control.backend), params, cx, 3);
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await waitForSend(control.sendRequests);

    control.emit({
      type: "tool.updated",
      payload: { kind: "started", toolCallId: "tool-1", toolName: "Read" },
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(121_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(700_000);
    await expect(turn).resolves.toEqual({ stopReason: "end_turn" });
    expect(control.backend.send).not.toHaveBeenCalled();
  });
});
