/**
 * Held prompt turn (B-2): one session/prompt covers its background subagent
 * work. After a backend turn ends normally with outstanding subagent-kind
 * background tasks, runEventTurn stays in its loop (PendingTurn.holding)
 * instead of returning; the next backend turn (the backend's follow-up,
 * `inputSource:"background_task"`) is ADOPTED into the same prompt turn via
 * the translator's chained-turn mode and runs the full existing path. The
 * BackgroundTaskListener suppresses its own text forwarding for the adopted
 * turn (no double rendering) while still opening/closing the busy window, and
 * runOneTurn never re-sends the original prompt after the primary turn
 * completed.
 *
 * Harness: prompt-level fake backend modeled on follow-up-backlog.test.ts
 * (envelope-first events pushed to all registered listeners — the prompt path
 * registers the REAL BackgroundTaskListener, so `session.updated` task
 * statuses exercise the real tracking). The 2s grace makes chain tests take
 * ~2-3s: per-test timeouts are set, and fake timers are deliberately NOT used
 * (the loop mixes pollEvent timeouts, heartbeats and setImmediate replies).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundTaskListener } from "../src/handlers/background-tasks.js";
import { compact } from "../src/handlers/extensions.js";
import {
  cancel,
  HELD_PROMPT_GRACE_MS,
  prompt,
  setHeldPromptHeartbeatMsForTests,
} from "../src/handlers/session.js";
import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { ZcodeAcpServer } from "../src/server.js";
import { EventTranslator } from "../src/translators/event-translator.js";

// Asserted notices are English.
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
  setHeldPromptHeartbeatMsForTests(null);
});

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Let fire-and-forget async helpers (the listener's onTaskStatus) run. */
const flushAsync = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

type EvFactory = (
  type: string,
  turnId: string | undefined,
  payload?: Record<string, unknown>,
) => ZcodeEvent;

interface FakeOptions {
  /** Events pushed synchronously when the prompt's session/send is accepted. */
  onSend?: () => ZcodeEvent[];
  /** session/subagents reply (default: -32601 → the safety net never fires). */
  subagentsResult?: () => unknown;
}

function fakeBackend(opts: FakeOptions = {}): {
  backend: ZcodeBackend;
  calls: string[];
  sent: Array<{ method: string; params: unknown }>;
  push: (events: ZcodeEvent[]) => void;
  ev: EvFactory;
} {
  const calls: string[] = [];
  const sent: Array<{ method: string; params: unknown }> = [];
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let seq = 0;
  const push = (events: ZcodeEvent[]): void => {
    for (const e of events) for (const l of [...listeners]) l.handleEvent(e);
  };
  const ev: EvFactory = (type, turnId, payload = {}) => ({
    sessionId: "zs_held",
    seq: ++seq,
    type: type as ZcodeEvent["type"],
    ...(turnId !== undefined ? { turnId } : {}),
    payload,
  });
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      calls.push(method);
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/subscribe":
          return { result: {} };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/subagents":
          return opts.subagentsResult
            ? { result: opts.subagentsResult() }
            : { error: { code: -32601, message: "Method not found" } };
        case "session/compact":
          return { result: { compact: { state: "accepted" } } };
        case "session/goal":
          // compact's lock probe: the dead-reader wording makes
          // waitForTurnIdle return "not released" immediately (no sleeps).
          return { error: { message: "backend reader exited" } };
        case "session/send": {
          if (opts.onSend) push(opts.onSend());
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: (method: string, params: unknown) => {
      sent.push({ method, params });
    },
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      const idx = listeners.indexOf(l);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  } as unknown as ZcodeBackend;
  return { backend, calls, sent, push, ev };
}

function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_held", "zs_held");
  server.markBackendLoaded("sess_held");
  return server;
}

function promptParams(text: string): acp.PromptRequest {
  return { sessionId: "sess_held", prompt: [{ type: "text", text }] } as acp.PromptRequest;
}

function recordingCx(): { cx: acp.AgentContext; updates: unknown[][] } {
  const updates: unknown[][] = [];
  return {
    updates,
    cx: {
      notify: async (...args: unknown[]) => {
        updates.push(args);
      },
      request: async () => ({}),
    } as unknown as acp.AgentContext,
  };
}

function updatesContaining(updates: unknown[][], needle: string): number {
  return updates.filter((args) => JSON.stringify(args).includes(needle)).length;
}

/** Wait until the prompt turn for the session is registered AND holding. */
async function waitForHolding(server: ZcodeAcpServer, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const holding = [...server.pendingTurns.values()].some((t) => t.holding === true);
    if (holding) return true;
    await sleep(20);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scripted fragments (envelope-first; task events carry no turnId).
// ---------------------------------------------------------------------------

/** Own prompt turn that launches subagent task bg1 and completes. */
function ownTurn(ev: EvFactory, usage?: Record<string, unknown>): ZcodeEvent[] {
  return [
    ev("turn.started", "OURS"),
    ev("model.streaming", "OURS", {
      kind: "text_delta",
      delta: "own reply",
      assistantMessageId: "m_own",
    }),
    ev("session.updated", undefined, {
      taskId: "bg1",
      taskKind: "subagent",
      status: "running",
      description: "research",
    }),
    ev("turn.completed", "OURS", { resultType: "success", ...(usage ? { usage } : {}) }),
  ];
}

/** The backend's follow-up turn (background_task) with text, a tool card, terminal. */
function followUpTurn(ev: EvFactory, usage?: Record<string, unknown>): ZcodeEvent[] {
  return [
    ev("turn.started", "F1", { inputSource: "background_task" }),
    ev("model.streaming", "F1", {
      kind: "text_delta",
      delta: "follow-up reply",
      assistantMessageId: "m_f1",
    }),
    ev("tool.updated", "F1", {
      kind: "scheduled",
      toolCallId: "c1",
      toolName: "Read",
      input: { file_path: "/tmp/x" },
    }),
    ev("tool.updated", "F1", {
      kind: "result",
      toolCallId: "c1",
      toolName: "Read",
      result: "file body",
    }),
    ev("turn.completed", "F1", { resultType: "success", ...(usage ? { usage } : {}) }),
  ];
}

function taskTerminal(ev: EvFactory): ZcodeEvent {
  return ev("session.updated", undefined, {
    taskId: "bg1",
    taskKind: "subagent",
    status: "completed",
  });
}

// ---------------------------------------------------------------------------
// Prompt-level chain tests
// ---------------------------------------------------------------------------

describe("held prompt turn (prompt level)", () => {
  it("chain: own turn → hold → adopt follow-up → task terminal → grace → end_turn; follow-up text dispatched exactly once", async () => {
    const f = fakeBackend({ onSend: () => ownTurn(f.ev) });
    const server = setup(f.backend);
    const { cx, updates } = recordingCx();

    const p = prompt(server, promptParams("go"), cx, 1);
    expect(await waitForHolding(server)).toBe(true);

    // The backend's follow-up turn starts while the prompt holds, then the
    // subagent task finishes.
    setTimeout(() => f.push(followUpTurn(f.ev)), 60);
    setTimeout(() => f.push([taskTerminal(f.ev)]), 160);

    const t0 = Date.now();
    const result = await p;
    const elapsed = Date.now() - t0;

    expect(result.stopReason).toBe("end_turn");
    expect(updatesContaining(updates, "own reply")).toBe(1);
    // Exactly once: the turn loop dispatched it; the session-scoped
    // BackgroundTaskListener did NOT also forward it (no double render).
    expect(updatesContaining(updates, "follow-up reply")).toBe(1);
    // The adopted turn's tool card went through the normal path.
    expect(updatesContaining(updates, "c1")).toBeGreaterThanOrEqual(1);
    // The 2s grace is real waiting, not an instant return.
    expect(elapsed).toBeGreaterThanOrEqual(HELD_PROMPT_GRACE_MS - 300);
  }, 10_000);

  it("usage sums across the chain", async () => {
    const f = fakeBackend({
      onSend: () => ownTurn(f.ev, { inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
    });
    const server = setup(f.backend);
    const { cx } = recordingCx();

    const p = prompt(server, promptParams("go"), cx, 1);
    expect(await waitForHolding(server)).toBe(true);
    setTimeout(
      () =>
        f.push([
          ...followUpTurn(f.ev, { inputTokens: 50, outputTokens: 5, totalTokens: 55 }),
          taskTerminal(f.ev),
        ]),
      60,
    );

    const result = await p;

    expect(result.stopReason).toBe("end_turn");
    // Per-turn payloads summed by the translator's chain accumulator.
    expect(result.usage?.inputTokens).toBe(150);
    expect(result.usage?.outputTokens).toBe(15);
    expect(result.usage?.totalTokens).toBe(165);
  }, 10_000);

  it("no outstanding work → returns promptly without the grace", async () => {
    const f = fakeBackend({
      onSend: () => [
        f.ev("turn.started", "OURS"),
        f.ev("model.streaming", "OURS", {
          kind: "text_delta",
          delta: "plain reply",
          assistantMessageId: "m_p",
        }),
        f.ev("turn.completed", "OURS", { resultType: "success" }),
      ],
    });
    const server = setup(f.backend);
    const { cx, updates } = recordingCx();

    const t0 = Date.now();
    const result = await prompt(server, promptParams("go"), cx, 1);
    const elapsed = Date.now() - t0;

    expect(result.stopReason).toBe("end_turn");
    expect(updatesContaining(updates, "plain reply")).toBe(1);
    // No hold was ever entered → no 2s grace overrun (generous bound; the
    // real path returns in milliseconds).
    expect(elapsed).toBeLessThan(3_000);
  }, 10_000);

  it("cancel while holding → cancelled; the follow-up that later runs is NOT dispatched", async () => {
    const f = fakeBackend({ onSend: () => ownTurn(f.ev) });
    const server = setup(f.backend);
    const { cx, updates } = recordingCx();

    const p = prompt(server, promptParams("go"), cx, 1);
    expect(await waitForHolding(server)).toBe(true);

    await cancel(server, { sessionId: "sess_held" } as acp.CancelNotification);
    // The follow-up lands AFTER the cancel: the held loop must drain it
    // without adopting or dispatching (the listener suppresses forwarding
    // while the turn is still registered+holding).
    f.push(followUpTurn(f.ev));

    const result = await p;

    expect(result.stopReason).toBe("cancelled");
    expect(updatesContaining(updates, "follow-up reply")).toBe(0);
  }, 10_000);

  it("adopted turn fails → one notice + end_turn, and session/send is NOT called again", async () => {
    const f = fakeBackend({ onSend: () => ownTurn(f.ev) });
    const server = setup(f.backend);
    const { cx, updates } = recordingCx();

    const p = prompt(server, promptParams("go"), cx, 1);
    expect(await waitForHolding(server)).toBe(true);

    setTimeout(
      () =>
        f.push([
          f.ev("turn.started", "F1", { inputSource: "background_task" }),
          f.ev("turn.failed", "F1", {
            resultType: "error",
            error: { code: "MODEL_REQUEST_FAILED", message: "boom" },
          }),
        ]),
      60,
    );

    const result = await p;

    expect(result.stopReason).toBe("end_turn");
    expect(updatesContaining(updates, "background follow-up turn failed")).toBe(1);
    // The original prompt was delivered once; a failed chain member must
    // never re-enter the send ladder.
    expect(f.calls.filter((m) => m === "session/send")).toHaveLength(1);
  }, 10_000);

  it("controlOnly / compaction-internal / rewind-claimed turns are skipped; a follow-up after them is still adopted", async () => {
    const f = fakeBackend({ onSend: () => ownTurn(f.ev) });
    const server = setup(f.backend);
    const { cx, updates } = recordingCx();

    const p = prompt(server, promptParams("go"), cx, 1);
    expect(await waitForHolding(server)).toBe(true);

    const listener = server.backgroundListeners.get("zs_held");
    expect(listener).toBeDefined();
    // A rewind claim arms the forwarding path for its replacement turn —
    // the loop must not adopt that one either.
    const token = listener!.claimRewindTurn();

    // The compaction flag must be SET while the loop consumes the internal
    // turn's events; a synchronous batch is consumed within microtasks, so
    // arm → push everything → clear later.
    server.autoCompactInFlight.add("zs_held");
    f.push([
      // controlOnly turn (skipped)
      f.ev("turn.started", "SK1", { executionKind: "controlOnly" }),
      f.ev("model.streaming", "SK1", { kind: "text_delta", delta: "control text" }),
      f.ev("turn.completed", "SK1", { resultType: "success" }),
      // compaction-internal turn (non-background while the flag is set)
      f.ev("turn.started", "SK2", {}),
      f.ev("model.streaming", "SK2", { kind: "text_delta", delta: "compact text" }),
      f.ev("turn.completed", "SK2", { resultType: "success" }),
      // rewind-claimed replacement turn (skipped)
      f.ev("turn.started", "RW", {}),
      f.ev("model.streaming", "RW", { kind: "text_delta", delta: "rewind text" }),
      f.ev("turn.completed", "RW", { resultType: "success" }),
      // the real follow-up AFTER all the skipped turns → adopted
      ...followUpTurn(f.ev),
      taskTerminal(f.ev),
    ]);
    setTimeout(() => server.autoCompactInFlight.delete("zs_held"), 500);

    const result = await p;

    expect(result.stopReason).toBe("end_turn");
    expect(updatesContaining(updates, "control text")).toBe(0);
    expect(updatesContaining(updates, "compact text")).toBe(0);
    // The rewind text belongs to the notification-forwarding path (the
    // recording cx only sees turn-loop dispatches) — the LOOP must not
    // have sent it.
    expect(updatesContaining(updates, "rewind text")).toBe(0);
    expect(updatesContaining(updates, "follow-up reply")).toBe(1);
    listener!.releaseRewindClaim(token);
  }, 10_000);

  it("safety net: two consecutive empty rosters end the hold", async () => {
    setHeldPromptHeartbeatMsForTests(40);
    const f = fakeBackend({
      onSend: () => ownTurn(f.ev),
      // The roster says NOTHING is running while the tracked task still
      // says outstanding — a dropped task-terminal.
      subagentsResult: () => ({ running: [] }),
    });
    const server = setup(f.backend);
    const { cx } = recordingCx();

    const p = prompt(server, promptParams("go"), cx, 1);
    expect(await waitForHolding(server)).toBe(true);

    const result = await p;

    expect(result.stopReason).toBe("end_turn");
    // Both heartbeat rosters were consulted before the net fired.
    expect(f.calls.filter((m) => m === "session/subagents")).toHaveLength(2);
  }, 10_000);

  it("compact() keeps the running indicator while a prompt turn is registered", async () => {
    const f = fakeBackend();
    const server = setup(f.backend);
    const updates: unknown[][] = [];
    vi.spyOn(server.clients, "broadcast").mockReturnValue({
      notify: async (...args: unknown[]) => {
        updates.push(args);
      },
    } as never);
    // A bridge prompt turn is registered for the session (a held/running
    // prompt owns the running indicator).
    server.pendingTurns.set("req-x", { zcodeSid: "zs_held", cancelled: false });

    await compact(
      server,
      { sessionId: "sess_held" } as never,
      {
        notify: async () => {},
      } as unknown as acp.AgentContext,
    );

    const turnStates = updates.filter((args) => JSON.stringify(args).includes("turnState"));
    expect(turnStates.length).toBeGreaterThanOrEqual(1); // the running:true raise
    expect(
      turnStates.filter((args) => JSON.stringify(args).includes('"running":false')),
    ).toHaveLength(0);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Serve-idle busy predicate (the expression the idle check consults)
// ---------------------------------------------------------------------------

describe("serve-idle busy predicate: outstanding subagent work counts as busy", () => {
  function busyPredicate(server: ZcodeAcpServer): boolean {
    // Mirrors the inline check in src/index.ts serveIdle loop.
    return [...server.backgroundListeners.values()].some((l) => l.subagentWorkOutstanding());
  }

  it("flips busy on a subagent sighting and idle after its terminal", async () => {
    const server = new ZcodeAcpServer();
    const listener = new BackgroundTaskListener(server, "zs_idle");
    server.backgroundListeners.set("zs_idle", listener);
    listener.handleEvent({
      sessionId: "zs_idle",
      seq: 1,
      type: "session.updated",
      payload: { taskId: "t1", taskKind: "subagent", status: "running" },
    });
    await flushAsync();
    expect(busyPredicate(server)).toBe(true);
    listener.handleEvent({
      sessionId: "zs_idle",
      seq: 2,
      type: "session.updated",
      payload: { taskId: "t1", taskKind: "subagent", status: "completed" },
    });
    await flushAsync();
    expect(busyPredicate(server)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EventTranslator.beginChainedTurn unit tests
// ---------------------------------------------------------------------------

describe("EventTranslator.beginChainedTurn", () => {
  const textDelta = (turnId: string, delta: string, msgId: string) => ({
    type: "model.streaming",
    turnId,
    payload: { kind: "text_delta", delta, assistantMessageId: msgId },
  });

  it("arms adopt once: the next background turn is adopted, a later one is skipped again", () => {
    const t = new EventTranslator();
    t.translate({ type: "turn.started", turnId: "T1" });
    t.translate(textDelta("T1", "a", "m1"));
    t.translate({
      type: "turn.completed",
      turnId: "T1",
      payload: { resultType: "success", usage: { inputTokens: 10, outputTokens: 2 } },
    });
    expect(t.turnDone).toBe(true);
    // Default: a background turn is deferred to the bg listener.
    t.translate({
      type: "turn.started",
      turnId: "B0",
      payload: { inputSource: "background_task" },
    });
    expect(t.translate(textDelta("B0", "skipped", "m0"))).toEqual([]);

    t.beginChainedTurn();
    expect(t.turnDone).toBe(false);
    expect(t.turnStarted).toBe(false);
    // Adopt armed → the background turn.started is consumed as OUR turn.
    t.translate({
      type: "turn.started",
      turnId: "F1",
      payload: { inputSource: "background_task" },
    });
    expect(t.turnStarted).toBe(true);
    const out = t.translate(textDelta("F1", "adopted", "m2"));
    expect(out.some((e) => e.kind === "TextDelta")).toBe(true);

    // Complete the adopted turn; WITHOUT re-arming, the next background turn
    // is skipped again (adopt arms exactly one turn).
    t.translate({ type: "turn.completed", turnId: "F1", payload: { resultType: "success" } });
    t.translate({
      type: "turn.started",
      turnId: "B2",
      payload: { inputSource: "background_task" },
    });
    expect(t.translate(textDelta("B2", "skipped2", "m3"))).toEqual([]);
  });

  it("a non-background turn.started while armed adopts and disarms too", () => {
    const t = new EventTranslator();
    t.translate({ type: "turn.started", turnId: "T1" });
    t.translate({ type: "turn.completed", turnId: "T1", payload: { resultType: "success" } });
    t.beginChainedTurn();
    t.translate({ type: "turn.started", turnId: "U1", payload: {} });
    expect(t.turnStarted).toBe(true);
    // Disarmed: a following background turn is skipped again.
    t.translate({ type: "turn.completed", turnId: "U1", payload: { resultType: "success" } });
    t.translate({
      type: "turn.started",
      turnId: "B1",
      payload: { inputSource: "background_task" },
    });
    expect(t.translate(textDelta("B1", "x", "m9"))).toEqual([]);
  });

  it("keeps the dedup sets/maps across the chain", () => {
    const t = new EventTranslator();
    t.translate({ type: "turn.started", turnId: "T1" });
    t.translate(textDelta("T1", "a", "m1"));
    t.translate({
      type: "tool.updated",
      turnId: "T1",
      payload: { kind: "scheduled", toolCallId: "c9", toolName: "Read", input: {} },
    });
    t.beginChainedTurn();
    expect(t.deliveredMessageIds.has("m1")).toBe(true);
    expect(t.seenToolIds.has("c9")).toBe(true);
    expect(t.toolNames.get("c9")).toBe("Read");
  });

  it("usage sums across the chain (token fields); string extras come from the last turn", () => {
    const t = new EventTranslator();
    t.translate({ type: "turn.started", turnId: "T1" });
    t.translate({
      type: "turn.completed",
      turnId: "T1",
      payload: {
        resultType: "success",
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: "api" },
      },
    });
    expect(t.turnUsage?.["inputTokens"]).toBe(100);
    t.beginChainedTurn();
    expect(t.turnUsage).toBeNull();
    t.translate({
      type: "turn.started",
      turnId: "F1",
      payload: { inputSource: "background_task" },
    });
    t.translate({
      type: "turn.completed",
      turnId: "F1",
      payload: {
        resultType: "success",
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          totalTokens: 55,
          source: "agent",
          modelRequestCount: 3,
        },
      },
    });
    expect(t.turnUsage?.["inputTokens"]).toBe(150);
    expect(t.turnUsage?.["outputTokens"]).toBe(15);
    expect(t.turnUsage?.["totalTokens"]).toBe(165);
    expect(t.turnUsage?.["source"]).toBe("agent");
    expect(t.turnUsage?.["modelRequestCount"]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// BackgroundTaskListener unit tests
// ---------------------------------------------------------------------------

/** Minimal fake server recording session/updates (mirror of
 * background-tasks.test.ts's makeServer, plus holding-aware pendingTurns). */
function makeListenerServer(pendingTurns: Array<{ zcodeSid: string; holding?: boolean }> = []): {
  server: ZcodeAcpServer;
  calls: Array<{ update: Record<string, unknown> }>;
} {
  const calls: Array<{ update: Record<string, unknown> }> = [];
  const server = {
    pendingTurns: new Map(pendingTurns.map((t, i) => [`req${i}`, t])),
    notifyTurnActiveSince: new Map<string, number>(),
    foreignActiveTurns: new Map<string, string>(),
    terminalSentData: new Map<string, string>(),
    acpSidByZcodeSid: new Map<string, string>([["zs_held", "acp_held"]]),
    sessionMap: new Map<string, string>([["acp_held", "zs_held"]]),
    sessionPlanActive: new Set<string>(),
    steerEchoExclusions: () => new Set<unknown>(),
    clients: {
      size: 0,
      broadcast: () => ({ notify: async () => {} }),
      notifyExceptRoots: async () => {},
    },
    sessionAliases: (sid: string) => [sid],
    async notifyByZcodeSid(_zcodeSid: string, update: Record<string, unknown>) {
      calls.push({ update });
      return true;
    },
  } as unknown as ZcodeAcpServer;
  return { server, calls };
}

const bgEvent = (type: string, turnId: string, payload: Record<string, unknown>): ZcodeEvent => ({
  sessionId: "zs_held",
  seq: 1,
  type: type as ZcodeEvent["type"],
  turnId,
  payload,
});

describe("BackgroundTaskListener: outstanding subagent work", () => {
  it("flips on a subagent running sighting and its terminal; a bash task never counts", async () => {
    const { server } = makeListenerServer();
    const l = new BackgroundTaskListener(server, "zs_held");
    expect(l.subagentWorkOutstanding()).toBe(false);
    l.handleEvent(
      bgEvent("session.updated", "", { taskId: "t1", taskKind: "bash", status: "running" }),
    );
    await flushAsync();
    expect(l.subagentWorkOutstanding()).toBe(false);
    l.handleEvent(
      bgEvent("session.updated", "", { taskId: "t2", taskKind: "subagent", status: "running" }),
    );
    await flushAsync();
    expect(l.subagentWorkOutstanding()).toBe(true);
    l.handleEvent(
      bgEvent("session.updated", "", { taskId: "t2", taskKind: "subagent", status: "completed" }),
    );
    await flushAsync();
    expect(l.subagentWorkOutstanding()).toBe(false);
  });

  it("markOutstandingSubagentsTerminal flips running subagent tasks and returns the count", async () => {
    const { server } = makeListenerServer();
    const l = new BackgroundTaskListener(server, "zs_held");
    l.handleEvent(
      bgEvent("session.updated", "", { taskId: "t1", taskKind: "subagent", status: "running" }),
    );
    l.handleEvent(
      bgEvent("session.updated", "", { taskId: "t2", taskKind: "subagent", status: "running" }),
    );
    l.handleEvent(
      bgEvent("session.updated", "", { taskId: "t3", taskKind: "bash", status: "running" }),
    );
    await flushAsync();
    expect(l.markOutstandingSubagentsTerminal()).toBe(2);
    expect(l.subagentWorkOutstanding()).toBe(false);
    expect(l.markOutstandingSubagentsTerminal()).toBe(0);
  });
});

describe("BackgroundTaskListener: window vs forwarding under a held prompt", () => {
  const started = bgEvent("turn.started", "T1", { inputSource: "background_task" });
  const delta = bgEvent("model.streaming", "T1", {
    kind: "text_delta",
    delta: "bg result text",
    assistantMessageId: "m_bg",
  });
  const ended = bgEvent("turn.completed", "T1", { resultType: "success" });

  it("a held prompt suppresses forwarding while the busy window still opens and closes", async () => {
    const { server, calls } = makeListenerServer([{ zcodeSid: "zs_held", holding: true }]);
    const l = new BackgroundTaskListener(server, "zs_held");

    l.handleEvent(started);
    expect(server.notifyTurnActiveSince.has("zs_held")).toBe(true);
    l.handleEvent(delta);
    await flushAsync();
    expect(calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk")).toHaveLength(
      0,
    );

    l.handleEvent(ended);
    expect(server.notifyTurnActiveSince.has("zs_held")).toBe(false);
    // Forwarding never armed: a later delta of the same turn would not leak.
    l.handleEvent(delta);
    await flushAsync();
    expect(calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk")).toHaveLength(
      0,
    );
  });

  it("without a held prompt the window opens, text forwards, and the window closes", async () => {
    const { server, calls } = makeListenerServer();
    const l = new BackgroundTaskListener(server, "zs_held");

    l.handleEvent(started);
    expect(server.notifyTurnActiveSince.has("zs_held")).toBe(true);
    l.handleEvent(delta);
    await flushAsync();
    expect(calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk")).toHaveLength(
      1,
    );

    l.handleEvent(ended);
    expect(server.notifyTurnActiveSince.has("zs_held")).toBe(false);
    l.handleEvent(delta);
    await flushAsync();
    expect(calls.filter((c) => c.update["sessionUpdate"] === "agent_message_chunk")).toHaveLength(
      1,
    );
  });

  it("isForwardingTurn reads the forwarding arm only (rewind-claimed replacement)", async () => {
    const { server } = makeListenerServer();
    const l = new BackgroundTaskListener(server, "zs_held");
    expect(l.isForwardingTurn("RW")).toBe(false);
    const token = l.claimRewindTurn();
    // Claimed but not yet started: not forwarding yet.
    expect(l.isForwardingTurn("RW")).toBe(false);
    l.handleEvent(bgEvent("turn.started", "RW", {}));
    expect(l.isForwardingTurn("RW")).toBe(true);
    l.handleEvent(bgEvent("turn.completed", "RW", { resultType: "success" }));
    expect(l.isForwardingTurn("RW")).toBe(false);
    l.releaseRewindClaim(token);
  });
});
