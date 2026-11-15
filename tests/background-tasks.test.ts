/**
 * BackgroundTaskListener unit tests.
 *
 * Drives handleEvent() with synthetic zcode events (the shapes captured by the
 * real app-server probe — see docs/PROTOCOL.md "Background Tasks") and asserts
 * the session/update notifications it pushes back via the server. No real
 * backend or ACP client — `notifyByZcodeSid` is stubbed to record calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundTaskListener } from "../src/handlers/background-tasks.js";
import type { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeEvent } from "../src/backend/types.js";

// Pin the language: asserted card titles are English and fs is not mocked.
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A minimal fake server: records every session/update it would send. */
interface FakeServer {
  calls: Array<{ zcodeSid: string; update: Record<string, unknown> }>;
  /** Broadcast session/updates (echoSteeredInputs path) recorded here. */
  echoes: Array<{ sessionId: string; update: Record<string, unknown> }>;
  /** Broadcast turnState notifications (foreign-turn tracking) recorded here. */
  turnStates: Array<{ method: string; sessionId: string; running: boolean }>;
  /** Mirrors ZcodeAcpServer.terminalSentData — set by tests to simulate a
   *  tracked launch card so BackgroundTaskListener reuses it. */
  terminalSentData: Map<string, string>;
  /** Mirrors ZcodeAcpServer.notifyTurnActiveSince (notification busy window). */
  notifyTurnActiveSince: Map<string, number>;
  /** Mirrors ZcodeAcpServer.foreignActiveTurns (foreign-turn running state). */
  foreignActiveTurns: Map<string, string>;
  /** Mirrors ZcodeAcpServer.pendingTurns (steer-echo turn-loop gate). */
  pendingTurns: Map<number, { zcodeSid: string }>;
  /** Mirrors ZcodeAcpServer.acpSidByZcodeSid (zcode → acp id reverse index). */
  acpSidByZcodeSid: Map<string, string>;
}
type TestServer = FakeServer & Pick<ZcodeAcpServer, "notifyByZcodeSid">;

function makeServer(): TestServer {
  const calls: TestServer["calls"] = [];
  const echoes: TestServer["echoes"] = [];
  const turnStates: TestServer["turnStates"] = [];
  const acpSidByZcodeSid = new Map<string, string>([["sess_test", "acp_test"]]);
  const server = {
    calls,
    echoes,
    turnStates,
    terminalSentData: new Map<string, string>(),
    notifyTurnActiveSince: new Map<string, number>(),
    foreignActiveTurns: new Map<string, string>(),
    pendingTurns: new Map<number, { zcodeSid: string }>(),
    acpSidByZcodeSid,
    // Mirrors ZcodeAcpServer.sessionPlanActive (out-of-turn mode transitions).
    sessionPlanActive: new Set<string>(),
    // Mirrors ZcodeAcpServer.sessionMap + steer-echo exclusion (echoSteeredInputs).
    sessionMap: new Map<string, string>([["acp_test", "sess_test"]]),
    steerEchoExclusions: () => new Set<unknown>(),
    // pushTaskTerminal reads the live client count (offline-push gate);
    // notifyExceptRoots serves the steer-echo fan-out.
    clients: {
      size: 0,
      broadcast: () => ({
        notify: async (method: string, params: unknown) => {
          const p = params as {
            sessionId: string;
            update?: Record<string, unknown>;
            running?: boolean;
          };
          if (method.endsWith("turnState")) {
            turnStates.push({ method, sessionId: p.sessionId, running: p.running === true });
          } else {
            echoes.push({ sessionId: p.sessionId, update: p.update ?? {} });
          }
        },
      }),
      notifyExceptRoots: async (
        _exclude: Set<unknown>,
        _method: string,
        params: unknown,
      ): Promise<void> => {
        const p = params as { sessionId: string; update: Record<string, unknown> };
        echoes.push({ sessionId: p.sessionId, update: p.update });
      },
    },
    sessionAliases: (acpSid: string) => [acpSid],
    async notifyByZcodeSid(zcodeSid: string, update: Record<string, unknown>): Promise<boolean> {
      calls.push({ zcodeSid, update });
      return true;
    },
  };
  return server as unknown as TestServer;
}

function zcodeEvent(
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<ZcodeEvent> = {},
): ZcodeEvent {
  return {
    sessionId: "sess_test",
    seq: 0,
    type: type as ZcodeEvent["type"],
    payload,
    ...extra,
  };
}

describe("BackgroundTaskListener", () => {
  it("forwards background_task turn text_delta as agent_message_chunk", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    // A notification turn starts.
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "turn_bg1" }),
    );
    await Promise.resolve();
    // The notification busy window opens with the turn.
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(true);
    // Its text deltas are forwarded.
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "result part 1 " }));
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "part 2" }));
    await Promise.resolve();
    // turn.completed ends the notification turn.
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await Promise.resolve();
    // ...and the busy window closes with it.
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(false);
    // Subsequent text_delta (no active bg turn) is NOT forwarded.
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "leak" }));
    await Promise.resolve();
    const chunks = server.calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk");
    expect(chunks).toHaveLength(2);
    expect((chunks[0]!.update["content"] as { text: string }).text).toBe("result part 1 ");
    expect((chunks[1]!.update["content"] as { text: string }).text).toBe("part 2");
    // All chunks share one messageId (the bg result message).
    expect(chunks[0]!.update["messageId"]).toBe(chunks[1]!.update["messageId"]);
  });

  it("turn.failed also closes the notification busy window", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "turn_bg2" }),
    );
    await Promise.resolve();
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(true);
    l.handleEvent(zcodeEvent("turn.failed", { error: { code: "x" } }));
    await Promise.resolve();
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(false);
  });

  it("allocates a fresh messageId per background task (no cross-task reuse)", async () => {
    // Regression guard: firstMessageId must be reset when a background
    // notification turn ends, else two tasks in the same session share one
    // messageId and the editor merges/overwrites their output.
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    // Task 1's notification turn.
    l.handleEvent(zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "t1" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "task1 result" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await Promise.resolve();
    // Task 2's notification turn (same session, same listener instance).
    l.handleEvent(zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "t2" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("model.streaming", { kind: "text_delta", delta: "task2 result" }));
    await Promise.resolve();
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await Promise.resolve();
    const chunks = server.calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk");
    expect(chunks).toHaveLength(2);
    // Distinct messageIds — the second task does NOT reuse the first's id.
    expect(chunks[0]!.update["messageId"]).not.toBe(chunks[1]!.update["messageId"]);
  });

  // ---- #351: stale notification state must not duplicate foreground text ----

  it("a normal turn started after a terminal-less notification clears the stale state (#351)", async () => {
    // The notification turn's terminal event was never observed (dropped
    // stream). When the user's turn then starts, the stale marker must be
    // cleared — otherwise this listener forwards the user reply's deltas as
    // a second, bg_msg_*-identified copy of what the prompt translator
    // already emits.
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "turn_bg" }),
    );
    await Promise.resolve();
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(true);
    // No terminal for turn_bg; the user's foreground turn starts.
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "user_prompt" }, { turnId: "turn_user" }),
    );
    await Promise.resolve();
    // Stale busy window closed with the stale state.
    expect(server.notifyTurnActiveSince.has("sess_test")).toBe(false);
    // The user turn's deltas (which the prompt translator forwards) are NOT
    // re-forwarded here — not even without envelope turnIds.
    l.handleEvent(
      zcodeEvent(
        "model.streaming",
        { kind: "text_delta", delta: "user reply" },
        { turnId: "turn_user" },
      ),
    );
    await Promise.resolve();
    expect(server.calls).toHaveLength(0);
  });

  it("foreign-turn streaming events are not forwarded while a notification is active (#351)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "turn_bg" }),
    );
    await Promise.resolve();
    // A delta explicitly attributed to another turn.
    l.handleEvent(
      zcodeEvent(
        "model.streaming",
        { kind: "text_delta", delta: "user reply" },
        { turnId: "turn_user" },
      ),
    );
    await Promise.resolve();
    // The notification's own delta (matching turnId) still flows.
    l.handleEvent(
      zcodeEvent(
        "model.streaming",
        { kind: "text_delta", delta: "bg result" },
        { turnId: "turn_bg" },
      ),
    );
    await Promise.resolve();
    const chunks = server.calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk");
    expect(chunks).toHaveLength(1);
    expect((chunks[0]!.update["content"] as { text: string }).text).toBe("bg result");
  });

  it("markCancelled emits a failed update with cancelled flag and clears state", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    await l.markCancelled("agent_abc");
    expect(server.calls).toHaveLength(2);
    const cancel = server.calls[1]!.update;
    expect(cancel["sessionUpdate"]).toBe("tool_call_update");
    expect(cancel["status"]).toBe("failed");
    expect(
      (cancel["_meta"] as { backgroundTask: { cancelled: boolean } }).backgroundTask.cancelled,
    ).toBe(true);
    // State cleared: a subsequent status event re-creates the card (new callId).
    l.handleEvent(zcodeEvent("session.updated", { taskId: "agent_abc", status: "running" }));
    await Promise.resolve();
    expect(server.calls).toHaveLength(3);
  });

  it("never throws on a malformed payload (best-effort)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    expect(() =>
      l.handleEvent(zcodeEvent("session.updated", { taskId: "x" } as never)),
    ).not.toThrow();
    expect(() => l.handleEvent(zcodeEvent("unknown.type", {}))).not.toThrow();
    await Promise.resolve();
  });
});

describe("BackgroundTaskListener: steer-drain echo (no-turn-loop window)", () => {
  it("echoes a drained steer when no turn loop is live (zombie after cancel)", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");

    l.handleEvent(
      zcodeEvent("turn.steerDrained", {
        pendingInputIds: ["pi1"],
        targetTurnId: "t1",
        injectedMessageIds: ["m1"],
        drainedInputs: [{ pendingInputId: "pi1", messageId: "m1", text: "steered mid-zombie" }],
      }),
    );
    await Promise.resolve();

    expect(server.echoes).toHaveLength(1);
    expect(server.echoes[0]!.sessionId).toBe("acp_test");
    expect(server.echoes[0]!.update.sessionUpdate).toBe("user_message_chunk");
    expect(server.echoes[0]!.update.content).toEqual({ type: "text", text: "steered mid-zombie" });
    expect(server.echoes[0]!.update.messageId).toBe("steer_m1");
  });
});

describe("emitShutdownRecords (#194)", () => {
  it("emits a failed shutdown record for an in-flight task and skips terminal ones", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(zcodeEvent("session.updated", { taskId: "exec_live", status: "running" }));
    l.handleEvent(zcodeEvent("session.updated", { taskId: "exec_done", status: "completed" }));
    await Promise.resolve();
    server.calls.length = 0;

    await l.emitShutdownRecords();

    // Only the still-running task gets a record; the completed one is skipped.
    expect(server.calls).toHaveLength(1);
    const rec = server.calls[0]!.update;
    expect(rec["sessionUpdate"]).toBe("tool_call_update");
    expect(rec["status"]).toBe("failed");
    const meta = rec["_meta"] as { backgroundTask: { shutdown: boolean } };
    expect(meta.backgroundTask.shutdown).toBe(true);

    // Idempotent: a second sweep finds nothing in flight.
    server.calls.length = 0;
    await l.emitShutdownRecords();
    expect(server.calls).toHaveLength(0);
  });
});

/**
 * Foreign-turn running state (upstream taskActivityTracker parity).
 *
 * The app-server's taskActivityTracker keys its running-session set off
 * turn.started / turn.terminal facts regardless of origin; the bridge mirrors
 * that via server.foreignActiveTurns + turnState broadcasts, because the turn
 * loop only exists while a bridge-driven prompt is registered. Without this,
 * a background-subagent wake turn streams messages into a session every
 * consumer reports as idle (observed live 2026-11-12, the mapon session).
 */
describe("BackgroundTaskListener foreign turn running state", () => {
  /** Flush the async turnState broadcast (Promise.allSettled chain). */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("tracks a background_task notification turn and broadcasts running:true/false", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    l.handleEvent(
      zcodeEvent("turn.started", { inputSource: "background_task" }, { turnId: "turn_f1" }),
    );
    await flush();
    expect(server.foreignActiveTurns.get("sess_test")).toBe("turn_f1");
    // Both spellings, running:true, addressed per alias.
    expect(server.turnStates).toEqual([
      { method: "$/zcode/turnState", sessionId: "acp_test", running: true },
      { method: "_zcode/turnState", sessionId: "acp_test", running: true },
    ]);
    l.handleEvent(zcodeEvent("turn.completed", { resultType: "success" }));
    await flush();
    expect(server.foreignActiveTurns.has("sess_test")).toBe(false);
    expect(server.turnStates.slice(2)).toEqual([
      { method: "$/zcode/turnState", sessionId: "acp_test", running: false },
      { method: "_zcode/turnState", sessionId: "acp_test", running: false },
    ]);
  });

  it("defers to the turn loop while a bridge-driven turn is registered", async () => {
    const server = makeServer();
    const l = new BackgroundTaskListener(server as unknown as ZcodeAcpServer, "sess_test");
    // A bridge-driven turn owns the session (the turn loop emits its own
    // turnState and its finally re-checks this map).
    server.pendingTurns.set(1, { zcodeSid: "sess_test" });
    l.handleEvent(zcodeEvent("turn.started", {}, { turnId: "turn_loop" }));
    await flush();
    // OWNERSHIP AT START: a loop-owned turn is NOT tracked at all — writing
    // it would poison the loop's stillBusy re-check after an ESC cancel
    // whose terminal never arrives (review 2026-11: a [true,true] sequence
    // and a permanent running entry). No map write, no broadcast.
    expect(server.foreignActiveTurns.has("sess_test")).toBe(false);
    expect(server.turnStates).toHaveLength(0);
    // The loop exits (cancel/finalize) WITHOUT a terminal event ever
    // arriving: the map stays clean — /status, turnActive and stillBusy all
    // correctly read idle.
    server.pendingTurns.delete(1);
    await flush();
    expect(server.foreignActiveTurns.has("sess_test")).toBe(false);
    // A LATE terminal (straggler after the loop exited) settles the clients
    // with a harmless running:false — the value matches reality.
    l.handleEvent(zcodeEvent("turn.completed", {}, { turnId: "turn_loop" }));
    await flush();
    expect(server.foreignActiveTurns.has("sess_test")).toBe(false);
    expect(server.turnStates.map((t) => t.running)).toEqual([false, false]);
  });
});
