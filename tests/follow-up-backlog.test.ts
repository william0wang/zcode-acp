/**
 * Follow-up turn backlog cut (regression): a backend-owned follow-up turn —
 * `turn.started` with payload `inputSource:"background_task"`, fired on the
 * parent session when a background task finishes — can END while a new
 * prompt's send is busy-retrying against the whole-turn lock (-32010). With
 * no preempt and no recent cancel the turn-attribution gate is unarmed, and a
 * fresh EventTranslator has activeTurnId === null until its first
 * turn.started, so the finished turn's queued tail was translated as THIS
 * prompt's output and its turn.completed flipped turnDone: the prompt
 * returned end_turn at once replaying the follow-up turn's text, while the
 * real reply ran with nobody listening. The fix cuts the listener queue
 * through the finished turn's terminal at send-accept
 * (EventStreamListener.dropBacklogBeforeOwnTurn).
 */

import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { EventStreamListener } from "../src/backend/listener.js";
import { prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

interface FakeOptions {
  busySends?: number;
  /** Also start+finish a second follow-up turn (F2) inside the busy window. */
  secondFollowUp?: boolean;
  /** Also inject a steer drain into turn F's tail (echoed user message). */
  steerDrain?: boolean;
}

/** Turn-id envelope-first event (the 0.16.9+ shape). */
function ev(
  seq: number,
  type: string,
  turnId: string,
  payload: Record<string, unknown>,
): ZcodeEvent {
  return { sessionId: "zs_fu", seq, type: type as ZcodeEvent["type"], turnId, payload };
}

/**
 * Recording fake backend: the first `busySends` session/send calls reject
 * busy AFTER pushing the follow-up turn's tail into every registered listener
 * (it streams into the freshly-subscribed listener while the send is
 * rejected); the accepted send pushes this prompt's own turn events.
 */
function fakeBackend(opts: FakeOptions = {}): {
  backend: ZcodeBackend;
  calls: string[];
  notify: Array<{ method: string; params: unknown }>;
} {
  const calls: string[] = [];
  const notify: Array<{ method: string; params: unknown }> = [];
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let sends = 0;
  let seq = 0;
  const followUpTail = (): ZcodeEvent[] => {
    const events = [
      ev(++seq, "model.streaming", "F", {
        kind: "text_delta",
        delta: "F tail",
        assistantMessageId: "m_f",
      }),
    ];
    if (opts.steerDrain) {
      // A drain that landed inside turn F: the injected text is a REAL user
      // message in the session history, echoed via echoSteeredInputs' payload
      // shape ({ drainedInputs: [{ text, messageId }] }).
      events.push(
        ev(++seq, "turn.steerDrained", "F", {
          drainedInputs: [{ text: "steered hello", messageId: "s9" }],
        }),
      );
    }
    events.push(ev(++seq, "turn.completed", "F", { resultType: "success" }));
    return events;
  };
  const secondFollowUp = (): ZcodeEvent[] => [
    // A second follow-up turn that STARTS inside the queue: its own
    // turn.started carries inputSource "background_task", which the
    // translator already defers to the session-scoped background listener.
    ev(++seq, "turn.started", "F2", { inputSource: "background_task" }),
    ev(++seq, "model.streaming", "F2", {
      kind: "text_delta",
      delta: "F2 text",
      assistantMessageId: "m_f2",
    }),
    ev(++seq, "turn.completed", "F2", { resultType: "success" }),
  ];
  const ownTurn = (): ZcodeEvent[] => [
    ev(++seq, "turn.started", "OURS", {}),
    ev(++seq, "model.streaming", "OURS", {
      kind: "text_delta",
      delta: "own reply",
      assistantMessageId: "m_o",
    }),
    ev(++seq, "turn.completed", "OURS", { resultType: "success" }),
  ];
  const push = (events: ZcodeEvent[]) => {
    for (const e of events) for (const l of listeners) l.handleEvent(e);
  };
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
        case "session/send": {
          sends += 1;
          if (sends <= (opts.busySends ?? 0)) {
            push(followUpTail());
            if (opts.secondFollowUp) push(secondFollowUp());
            return {
              error: { code: -32010, message: "A prompt is already running for this session" },
            };
          }
          push(ownTurn());
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: (method: string, params: unknown) => {
      notify.push({ method, params });
    },
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls, notify };
}

function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_fu", "zs_fu");
  server.markBackendLoaded("sess_fu");
  return server;
}

function promptParams(text: string): acp.PromptRequest {
  return { sessionId: "sess_fu", prompt: [{ type: "text", text }] } as acp.PromptRequest;
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

describe("follow-up turn backlog cut at send-accept", () => {
  it("does not replay a finished follow-up turn's tail as the new prompt's output", async () => {
    const f = fakeBackend({ busySends: 1 });
    const server = setup(f.backend);
    const { cx, updates } = recordingCx();

    const result = await prompt(server, promptParams("next"), cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    // The follow-up turn's tail must never reach the client as our output.
    expect(updatesContaining(updates, "F tail")).toBe(0);
    expect(updatesContaining(updates, "own reply")).toBe(1);
  });

  it("cuts only through the last terminal of an unannounced turn; a second follow-up turn stays deferred", async () => {
    const f = fakeBackend({ busySends: 1, secondFollowUp: true });
    const server = setup(f.backend);
    const { cx, updates } = recordingCx();

    const result = await prompt(server, promptParams("next"), cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(updatesContaining(updates, "F tail")).toBe(0);
    // The real session-scoped BackgroundTaskListener may legitimately forward
    // the F2 delta once while our send waits — that path is not the turn
    // loop. The turn loop itself must not dispatch it.
    expect(updatesContaining(updates, "F2 text")).toBeLessThanOrEqual(1);
    expect(updatesContaining(updates, "own reply")).toBe(1);
  });

  it("a steer drained inside the cut range still echoes its injected user message", async () => {
    const f = fakeBackend({ busySends: 1, steerDrain: true });
    const server = setup(f.backend);
    const { cx, updates } = recordingCx();
    // The echo fans out through the client registry (echoSteeredInputs →
    // clients.notifyExceptRoots), not the prompting cx — record it alongside
    // the cx updates (a bare test server has no registered clients, so the
    // real registry would drop it into the void).
    vi.spyOn(server.clients, "notifyExceptRoots").mockImplementation(
      async (_excludeRoots, _method, params) => {
        updates.push([params]);
      },
    );

    const result = await prompt(server, promptParams("next"), cx, 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    expect(updatesContaining(updates, "F tail")).toBe(0);
    // The drain echo is fire-and-forget enqueued; let its microtask land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updatesContaining(updates, "steered hello")).toBe(1);
    expect(updatesContaining(updates, "own reply")).toBe(1);
  });
});

describe("EventStreamListener.dropBacklogBeforeOwnTurn", () => {
  /** Listener over a bare object backend — the queue methods never call it. */
  function makeListener(): EventStreamListener {
    const fake = {
      isDead: false,
      request: async () => ({ result: {} }),
      send: () => {},
      pollServerRequests: () => [],
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    return new EventStreamListener(fake, "zs_fu");
  }

  function feed(listener: EventStreamListener, events: ZcodeEvent[]) {
    for (const e of events) listener.handleEvent(e);
  }

  it("cuts a finished unannounced turn's whole tail (delta + terminal)", () => {
    const listener = makeListener();
    feed(listener, [
      ev(1, "model.streaming", "F", { kind: "text_delta", delta: "x", assistantMessageId: "m" }),
      ev(2, "turn.completed", "F", { resultType: "success" }),
    ]);
    expect(listener.dropBacklogBeforeOwnTurn()).toBe(2);
    expect(listener.hasQueuedEvents()).toBe(false);
  });

  it("keeps a turn that announced itself in the queue; cuts only the earlier unannounced one", async () => {
    const listener = makeListener();
    feed(listener, [
      ev(1, "model.streaming", "F", { kind: "text_delta", delta: "x", assistantMessageId: "m" }),
      ev(2, "tool.updated", "F", { kind: "tool_started", toolCallId: "c1" }),
      ev(3, "turn.completed", "F", { resultType: "success" }),
      ev(4, "turn.started", "OURS", {}),
      ev(5, "model.streaming", "OURS", {
        kind: "text_delta",
        delta: "y",
        assistantMessageId: "m2",
      }),
      ev(6, "turn.completed", "OURS", { resultType: "success" }),
    ]);
    expect(listener.dropBacklogBeforeOwnTurn()).toBe(3);
    // Exactly our turn's three events remain, in order.
    const polled: string[] = [];
    while (listener.hasQueuedEvents()) {
      const e = (await listener.pollEvent(50)) as ZcodeEvent | null;
      if (e) polled.push(`${e.type}:${e.turnId}`);
    }
    expect(polled).toEqual(["turn.started:OURS", "model.streaming:OURS", "turn.completed:OURS"]);
  });

  it("keeps a turn.steerDrained from the cut range at the head, in order", async () => {
    const listener = makeListener();
    feed(listener, [
      ev(1, "model.streaming", "F", { kind: "text_delta", delta: "x", assistantMessageId: "m" }),
      ev(2, "turn.steerDrained", "F", { drainedInputs: [{ text: "hello", messageId: "s1" }] }),
      ev(3, "tool.updated", "F", { kind: "tool_started", toolCallId: "c1" }),
      ev(4, "turn.completed", "F", { resultType: "success" }),
      ev(5, "turn.started", "OURS", {}),
      ev(6, "turn.completed", "OURS", { resultType: "success" }),
    ]);
    // 6 events in, 3 survive (steerDrained + our turn's two) → 3 removed.
    expect(listener.dropBacklogBeforeOwnTurn()).toBe(3);
    const polled: string[] = [];
    while (listener.hasQueuedEvents()) {
      const e = (await listener.pollEvent(50)) as ZcodeEvent | null;
      if (e) polled.push(`${e.type}:${e.turnId}`);
    }
    expect(polled).toEqual(["turn.steerDrained:F", "turn.started:OURS", "turn.completed:OURS"]);
  });

  it("keeps a turn.steerQueued from the cut range the same way", async () => {
    const listener = makeListener();
    feed(listener, [
      ev(1, "model.streaming", "F", { kind: "text_delta", delta: "x", assistantMessageId: "m" }),
      ev(2, "turn.steerQueued", "F", {}),
      ev(3, "turn.completed", "F", { resultType: "success" }),
    ]);
    expect(listener.dropBacklogBeforeOwnTurn()).toBe(2);
    const polled: string[] = [];
    while (listener.hasQueuedEvents()) {
      const e = (await listener.pollEvent(50)) as ZcodeEvent | null;
      if (e) polled.push(`${e.type}:${e.turnId}`);
    }
    expect(polled).toEqual(["turn.steerQueued:F"]);
  });

  it("drops nothing when the finished turn announced itself (own turn, even completed)", () => {
    const listener = makeListener();
    feed(listener, [
      ev(1, "turn.started", "OURS", {}),
      ev(2, "model.streaming", "OURS", { kind: "text_delta", delta: "y", assistantMessageId: "m" }),
      ev(3, "turn.completed", "OURS", { resultType: "success" }),
    ]);
    expect(listener.dropBacklogBeforeOwnTurn()).toBe(0);
    expect(listener.hasQueuedEvents()).toBe(true);
  });

  it("drops nothing when no terminal is queued (follow-up turn still running)", () => {
    const listener = makeListener();
    feed(listener, [
      ev(1, "model.streaming", "F", { kind: "text_delta", delta: "x", assistantMessageId: "m" }),
      ev(2, "turn.started", "OURS", {}),
      ev(3, "model.streaming", "OURS", {
        kind: "text_delta",
        delta: "y",
        assistantMessageId: "m2",
      }),
    ]);
    expect(listener.dropBacklogBeforeOwnTurn()).toBe(0);
    expect(listener.hasQueuedEvents()).toBe(true);
  });

  it("treats turn.failed as a terminal", () => {
    const listener = makeListener();
    feed(listener, [
      ev(1, "model.streaming", "F", { kind: "text_delta", delta: "x", assistantMessageId: "m" }),
      ev(2, "turn.failed", "F", { resultType: "error", error: { code: "boom" } }),
    ]);
    expect(listener.dropBacklogBeforeOwnTurn()).toBe(2);
    expect(listener.hasQueuedEvents()).toBe(false);
  });

  it("leaves a terminal with no resolvable turn id alone (legacy steer-into-turn)", () => {
    const listener = makeListener();
    feed(listener, [
      ev(1, "model.streaming", "F", { kind: "text_delta", delta: "x", assistantMessageId: "m" }),
      { sessionId: "zs_fu", seq: 2, type: "turn.completed", payload: { resultType: "success" } },
    ]);
    expect(listener.dropBacklogBeforeOwnTurn()).toBe(0);
    expect(listener.hasQueuedEvents()).toBe(true);
  });
});
