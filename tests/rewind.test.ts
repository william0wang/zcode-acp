/**
 * Rewind extension tests (session/edit_user_message · session/retry_turn):
 * the v4 command envelope the handlers emit (editUserQuery / retryTurn with
 * the CAS pair), target resolution against the rowsRange projection, the
 * stale retry, busy/claim lifecycle, and the post-rewind re-baseline.
 *
 * Harness mirrors tests/steering.test.ts: a scripted fake backend records
 * every v4 frame and answers from per-test queues.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { editUserMessage, retryTurn } from "../src/handlers/rewind.js";
import { ZcodeAcpServer } from "../src/server.js";
import type { ZcodeBackend } from "../src/backend/client.js";

/** Recorded v4/conversation/rowsRange + v4/command frames (the wire under test). */
const rowsCalls: Array<Record<string, unknown>> = [];
const commands: Array<Record<string, unknown>> = [];

/** Per-test script: rowsRange answers, then a per-command ack queue. */
let rowsResults: Array<Record<string, unknown> | { error: { message: string } }>;
let acks: Array<Record<string, unknown>>;

/** Messages session/messages answers (the re-baseline read). */
let storedMessages: Array<Record<string, unknown>>;

/** Captured turnState notifications (busy raise/settle). */
const turnStates: Array<{ sessionId: string; running: boolean }> = [];
/** Captured session/update notifications (claimed-turn forwarding). */
const updates: Array<Record<string, unknown>> = [];

const ROWS = [
  { rowId: 1, kind: "userInput", entityId: "msg_u1", actions: { canEdit: true } },
  { rowId: 2, kind: "assistantText", entityId: "msg_a1", actions: { canRetry: true } },
  { rowId: 3, kind: "userInput", entityId: "msg_u2", actions: { canEdit: false } },
  { rowId: 4, kind: "assistantText", entityId: "msg_a2", actions: { canRetry: false } },
];

/** Default snapshot the fake answers once its scripted queue runs dry —
 * multi-call tests don't need one entry per call. */
const DEFAULT_SNAPSHOT: Record<string, unknown> = {
  rows: ROWS,
  atRevision: 11,
  atLogEpoch: "epoch-1",
  hasMore: false,
  atSeq: 4,
};

function fakeBackend(): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string, params?: Record<string, unknown>) => {
      switch (method) {
        case "v4/conversation/rowsRange": {
          rowsCalls.push(params!);
          const next = rowsResults.shift() ?? DEFAULT_SNAPSHOT;
          if ("error" in next) return { error: next.error };
          return { result: next };
        }
        case "v4/command": {
          commands.push(params!);
          const ack = acks.shift() ?? { status: "accepted" };
          return { result: ack };
        }
        case "session/messages":
          return { result: { messages: storedMessages } };
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

function setup(): ZcodeAcpServer {
  rowsCalls.length = 0;
  commands.length = 0;
  turnStates.length = 0;
  updates.length = 0;
  rowsResults = [{ rows: ROWS, atRevision: 11, atLogEpoch: "epoch-1", hasMore: false, atSeq: 4 }];
  acks = [
    {
      status: "accepted",
      result: { type: "editUserQuery", disposition: "rewind", sessionId: "zs_rw" },
    },
  ];
  storedMessages = [
    { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "one" }] },
    { info: { id: "msg_a1", role: "assistant" }, parts: [{ type: "text", text: "A1" }] },
  ];
  const server = new ZcodeAcpServer();
  server.backend = fakeBackend();
  server.registerSession("sess_rw", "zs_rw");
  // Broadcast cx capture for turnState; direct stub for session/update
  // (notifyByZcodeSid) — mirrors tests/background-tasks.test.ts.
  (server as unknown as { clients: unknown }).clients = {
    size: 1,
    broadcast: () => ({
      notify: async (_method: string, params: Record<string, unknown>) => {
        turnStates.push({
          sessionId: params.sessionId as string,
          running: params.running as boolean,
        });
      },
    }),
  };
  server.notifyByZcodeSid = async (_sid: string, update: Record<string, unknown>) => {
    updates.push(update);
    return true;
  };
  return server;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/** turnState runs with TURN_STATE_METHODS' 2-method fan-out collapsed. */
function busyRuns(): boolean[] {
  return turnStates.map((t) => t.running).filter((v, i, a) => i === 0 || v !== a[i - 1]!);
}

describe("session/edit_user_message", () => {
  it("maps onto v4 editUserQuery with the CAS pair from rowsRange", async () => {
    const server = setup();
    const result = await editUserMessage(server, {
      sessionId: "sess_rw",
      messageId: "msg_u1",
      newText: "edited question",
    });
    expect(result).toEqual({ ok: true, rewoundMessageId: "msg_u1" });
    expect(commands).toHaveLength(1);
    const cmd = commands[0]!;
    expect(cmd["type"]).toBe("editUserQuery");
    expect(cmd["sessionId"]).toBe("zs_rw");
    expect(cmd["clientId"]).toBe("zcode-acp-server");
    expect(cmd["baseRevision"]).toBe(11);
    expect(cmd["baseLogEpoch"]).toBe("epoch-1");
    expect(typeof cmd["commandId"]).toBe("string");
    expect(cmd["payload"]).toEqual({
      target: { rowId: 1, entityId: "msg_u1" },
      newText: "edited question",
      workspaceMode: "preserve",
    });
  });

  it("rejects a non-editable / unknown mid before any command", async () => {
    const server = setup();
    await expect(
      editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_a1", newText: "x" }),
    ).rejects.toThrow(/only the latest user message/);
    await expect(
      editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_u2", newText: "x" }),
    ).rejects.toThrow(/only the latest user message/);
    await expect(
      editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_gone", newText: "x" }),
    ).rejects.toThrow(/not found in the current conversation/);
    await expect(
      editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_u1", newText: "  " }),
    ).rejects.toThrow(/non-empty newText/);
    expect(commands).toHaveLength(0);
  });

  it("rejects an unknown session", async () => {
    const server = setup();
    await expect(
      editUserMessage(server, { sessionId: "sess_nope", messageId: "msg_u1", newText: "x" }),
    ).rejects.toThrow();
    expect(commands).toHaveLength(0);
  });
});

describe("session/retry_turn", () => {
  it("maps onto v4 retryTurn with the exact assistant target", async () => {
    const server = setup();
    acks = [{ status: "accepted" }];
    const result = await retryTurn(server, { sessionId: "sess_rw", messageId: "msg_a1" });
    expect(result).toEqual({ ok: true, rewoundMessageId: "msg_a1" });
    expect(commands[0]!.payload).toEqual({ target: { rowId: 2, entityId: "msg_a1" } });
  });

  it("messageId omitted retries the newest retryable assistant row", async () => {
    const server = setup();
    // Newest retryable assistant row in ROWS is rowId 2 (rowId 4 lacks canRetry).
    const result = await retryTurn(server, { sessionId: "sess_rw" });
    expect(result).toEqual({ ok: true, rewoundMessageId: "msg_a1" });
    expect(commands[0]!.payload).toEqual({ target: { rowId: 2, entityId: "msg_a1" } });
  });

  it("rejects a non-retryable mid", async () => {
    const server = setup();
    await expect(retryTurn(server, { sessionId: "sess_rw", messageId: "msg_a2" })).rejects.toThrow(
      /only the latest assistant reply/,
    );
    expect(commands).toHaveLength(0);
  });
});

describe("ack classification", () => {
  it("refreshes the target once on a CAS-stale ack", async () => {
    const server = setup();
    acks = [{ status: "stale", reasonCode: "proto.staleRevision" }, { status: "accepted" }];
    rowsResults = [
      { rows: ROWS, atRevision: 11, atLogEpoch: "epoch-1" },
      { rows: ROWS, atRevision: 12, atLogEpoch: "epoch-2" },
    ];
    const result = await retryTurn(server, { sessionId: "sess_rw", messageId: "msg_a1" });
    expect(result.ok).toBe(true);
    expect(rowsCalls).toHaveLength(2);
    expect(commands).toHaveLength(2);
    expect(commands[0]!.baseRevision).toBe(11);
    expect(commands[1]!.baseRevision).toBe(12);
    expect(commands[1]!.baseLogEpoch).toBe("epoch-2");
    expect(commands[0]!.commandId).not.toBe(commands[1]!.commandId);
  });

  it("gives up after one stale retry", async () => {
    const server = setup();
    acks = [{ status: "stale" }, { status: "stale" }];
    rowsResults = [
      { rows: ROWS, atRevision: 11, atLogEpoch: "e1" },
      { rows: ROWS, atRevision: 12, atLogEpoch: "e2" },
    ];
    await expect(retryTurn(server, { sessionId: "sess_rw" })).rejects.toThrow(/stale/);
    expect(commands).toHaveLength(2);
  });

  it("surfaces a rejected ack verbatim and settles the busy state", async () => {
    const server = setup();
    acks = [
      { status: "rejected", reasonCode: "fault.command.session_busy", message: "backend busy" },
    ];
    await expect(
      editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_u1", newText: "x" }),
    ).rejects.toThrow(/backend busy/);
    // Busy raised then settled — the composer must unlock on failure.
    expect(busyRuns()).toEqual([true, false]);
  });

  it("treats an accepted-but-blocked edit as a failure", async () => {
    const server = setup();
    acks = [
      {
        status: "accepted",
        result: {
          type: "editUserQuery",
          disposition: "blocked",
          reasonCode: "guard.workspaceRewindUnsafeFiles",
          sessionId: "zs_rw",
        },
      },
    ];
    await expect(
      editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_u1", newText: "x" }),
    ).rejects.toThrow(/guard\.workspaceRewindUnsafeFiles/);
    expect(busyRuns()).toEqual([true, false]);
  });

  it("answers a clean error on a backend without the v4 face", async () => {
    const server = setup();
    rowsResults = [{ error: { message: "Method not found" } }];
    await expect(
      editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_u1", newText: "x" }),
    ).rejects.toThrow(/rewind unavailable on this backend/);
    expect(busyRuns()).toEqual([true, false]);
    expect(commands).toHaveLength(0);
  });
});

describe("post-rewind consistency", () => {
  it("re-baselines the hydration watermark and the differ", async () => {
    const server = setup();
    const result = await editUserMessage(server, {
      sessionId: "sess_rw",
      messageId: "msg_u1",
      newText: "x",
    });
    expect(result.ok).toBe(true);
    expect(server.hydrationWatermark.get("zs_rw")).toBe(0);
    const differ = server.differs.get("zs_rw");
    expect(differ).toBeDefined();
    // historyAnchor moved to the newest post-rewind message (markSeen).
    expect(differ!.historyAnchor).toBe("msg_a1");
  });

  it("keeps the busy state raised on the accepted path (the turn owns it)", async () => {
    const server = setup();
    await editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_u1", newText: "x" });
    expect(busyRuns()).toEqual([true]);
  });
});

describe("claimed replacement turn (BackgroundTaskListener integration)", () => {
  it("claims the first non-background turn.started and forwards its text", async () => {
    const server = setup();
    await editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_u1", newText: "x" });
    const listener = server.backgroundListeners.get("zs_rw")!;
    expect(listener).toBeDefined();

    // The replacement turn starts (v4-initiated: no background_task source).
    listener.handleEvent({ type: "turn.started", turnId: "turn_rep", payload: {} } as never);
    expect(server.notifyTurnActiveSince.has("zs_rw")).toBe(true);
    expect(server.foreignActiveTurns.get("zs_rw")).toBe("turn_rep");

    listener.handleEvent({
      type: "model.streaming",
      turnId: "turn_rep",
      payload: { kind: "text_delta", delta: "replacement ", assistantMessageId: "am_new" },
    } as never);
    listener.handleEvent({
      type: "model.streaming",
      turnId: "turn_rep",
      payload: { kind: "text_delta", delta: "reply", assistantMessageId: "am_new" },
    } as never);
    expect(updates).toHaveLength(2);
    expect(updates[0]!).toMatchObject({ sessionUpdate: "agent_message_chunk" });
    expect(updates[0]!.messageId).toBe("am_new");

    listener.handleEvent({ type: "turn.completed", turnId: "turn_rep", payload: {} } as never);
    expect(server.notifyTurnActiveSince.has("zs_rw")).toBe(false);
  });

  it("does NOT claim a foreign turn without a rewind in flight", async () => {
    const server = setup();
    const listener = server.backgroundListeners.get("zs_rw");
    expect(listener).toBeUndefined();
    await server.ensureBackgroundListener("zs_rw");
    const btl = server.backgroundListeners.get("zs_rw")!;
    btl.handleEvent({ type: "turn.started", turnId: "t_wake", payload: {} } as never);
    btl.handleEvent({
      type: "model.streaming",
      turnId: "t_wake",
      payload: { kind: "text_delta", delta: "stray" },
    } as never);
    expect(updates).toHaveLength(0);
  });

  it("claims even while a bridge turn is REGISTERED but not started (FIFO: replacement first)", async () => {
    const server = setup();
    await editUserMessage(server, { sessionId: "sess_rw", messageId: "msg_u1", newText: "x" });
    // Another client's prompt registered (send not yet accepted) when the
    // replacement turn starts — skipping the claim here would lose the
    // replacement text and strand the claim until the TTL misfires.
    server.pendingTurns.set(1, { zcodeSid: "zs_rw", cancelled: false });
    const listener = server.backgroundListeners.get("zs_rw")!;
    listener.handleEvent({ type: "turn.started", turnId: "turn_rep", payload: {} } as never);
    listener.handleEvent({
      type: "model.streaming",
      turnId: "turn_rep",
      payload: { kind: "text_delta", delta: "replacement", assistantMessageId: "am1" },
    } as never);
    expect(updates).toHaveLength(1);
    expect(updates[0]!).toMatchObject({ sessionUpdate: "agent_message_chunk" });
  });

  it("a failed concurrent rewind cannot drop a newer claim (token guard)", async () => {
    const server = setup();
    await server.ensureBackgroundListener("zs_rw");
    const listener = server.backgroundListeners.get("zs_rw")!;
    const stale = listener.claimRewindTurn();
    const live = listener.claimRewindTurn();
    listener.releaseRewindClaim(stale); // the superseded call fails
    listener.handleEvent({ type: "turn.started", turnId: "turn_rep", payload: {} } as never);
    listener.handleEvent({
      type: "model.streaming",
      turnId: "turn_rep",
      payload: { kind: "text_delta", delta: "still mine" },
    } as never);
    expect(updates).toHaveLength(1); // the newer claim still armed + forwarded
    listener.releaseRewindClaim(live);
    listener.handleEvent({ type: "turn.started", turnId: "t_late", payload: {} } as never);
    listener.handleEvent({
      type: "model.streaming",
      turnId: "t_late",
      payload: { kind: "text_delta", delta: "not claimed" },
    } as never);
    expect(updates).toHaveLength(1); // released → no forwarding
  });

  it("expires an unclaimed rewind and settles the busy state (TTL backstop)", async () => {
    vi.useFakeTimers();
    try {
      const server = setup();
      const done = await editUserMessage(server, {
        sessionId: "sess_rw",
        messageId: "msg_u1",
        newText: "x",
      });
      expect(done.ok).toBe(true);
      expect(busyRuns()).toEqual([true]);
      await vi.advanceTimersByTimeAsync(90_500);
      // Accepted-but-no-turn: the watchdog settles the busy window.
      expect(busyRuns()).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });
});
