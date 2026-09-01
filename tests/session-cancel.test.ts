/**
 * Regression tests for the cancel path.
 *
 * The backend (app-server 0.16.5, verified live) ignores `session/stop` — the
 * model stream runs to its natural end regardless. Cancel therefore only works
 * if the bridge acts on the flag itself: the turn loop returns immediately and
 * `cancel()` eagerly fires the stop + stamps the cancel time (fast-fail for a
 * prompt sent during the backend's recovery window).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventStreamListener, TurnMonitor } from "../src/backend/listener.js";
import type { ProjectionDiffer } from "../src/translators/projection-differ.js";
import { cancel, runEventTurn } from "../src/handlers/session.js";
import type { PendingTurn, ZcodeAcpServer } from "../src/server.js";

// These tests assert the Chinese message table.
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "zh");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface FakeTurn {
  zcodeSid: string;
  cancelled: boolean;
  stopSent: boolean;
}

function makeServer(turns: FakeTurn[], resolve: (sid: string) => string | undefined) {
  const sent: Array<{ method: string; params: unknown }> = [];
  const server = {
    resolveSid: resolve,
    pendingTurns: new Map(turns.map((t, i) => [`req${i}`, t])),
    lastCancelledAt: new Map<string, number>(),
    ensureBackend: () => ({
      send: (method: string, params: unknown) => {
        sent.push({ method, params });
      },
    }),
  } as unknown as ZcodeAcpServer;
  return { server, sent };
}

describe("session/cancel handler", () => {
  it("marks the matching turn cancelled and fires session/stop + v4 stop", async () => {
    const turn: FakeTurn = { zcodeSid: "sess_z", cancelled: false, stopSent: false };
    const { server, sent } = makeServer([turn], (sid) => (sid === "acp_a" ? "sess_z" : undefined));

    await cancel(server, { sessionId: "acp_a" } as acp.CancelNotification);

    expect(turn.cancelled).toBe(true);
    expect(turn.stopSent).toBe(true);
    // session/stop is the protocol formality; the v4/command stop (the
    // official app's own path) is what actually kills the generation on the
    // Aug-28 app-server, which ignores session/stop entirely.
    expect(sent.map((s) => s.method)).toEqual(["session/stop", "v4/command"]);
    expect(sent[1]?.params).toMatchObject({ sessionId: "sess_z", type: "stop" });
    expect(server.lastCancelledAt.get("sess_z")).toBeGreaterThan(0);
  });

  it("stops every turn of the session, not just the first match", async () => {
    const old: FakeTurn = { zcodeSid: "sess_z", cancelled: false, stopSent: true };
    const live: FakeTurn = { zcodeSid: "sess_z", cancelled: false, stopSent: false };
    const other: FakeTurn = { zcodeSid: "sess_o", cancelled: false, stopSent: false };
    const { server, sent } = makeServer([old, live, other], (sid) =>
      sid === "acp_a" ? "sess_z" : undefined,
    );

    await cancel(server, { sessionId: "acp_a" } as acp.CancelNotification);

    expect(old.cancelled).toBe(true);
    expect(live.cancelled).toBe(true);
    expect(other.cancelled).toBe(false);
    // The stale turn's stopSent guard skips its stop pair entirely; the live
    // turn's fires the session/stop + v4/command pair once.
    expect(sent.map((s) => s.method)).toEqual(["session/stop", "v4/command"]);
  });

  it("no-ops for an unknown session id", async () => {
    const send = vi.fn();
    const server = {
      resolveSid: () => undefined,
      pendingTurns: new Map(),
      lastCancelledAt: new Map<string, number>(),
      ensureBackend: () => ({ send }),
    } as unknown as ZcodeAcpServer;

    await cancel(server, { sessionId: "acp_ghost" } as acp.CancelNotification);

    expect(send).not.toHaveBeenCalled();
  });
});

/** Minimal fixtures for driving runEventTurn's cancel path in isolation. */
function makeTurnFixtures() {
  const sent: Array<{ method: string; params: unknown }> = [];
  const server = {
    ensureBackend: () => ({
      send: (method: string, params: unknown) => {
        sent.push({ method, params });
      },
      pollServerRequests: () => [],
    }),
    sessionAliases: (sid: string) => [sid],
  } as unknown as ZcodeAcpServer;
  const pollEvent = vi.fn();
  const listener = {
    pollEvent,
    hasQueuedEvents: () => false,
    resubscribe: vi.fn(),
  } as unknown as EventStreamListener;
  const monitor = { pollOnce: vi.fn() } as unknown as TurnMonitor;
  const differ = {
    resetTurn: vi.fn(),
    setLastUsage: vi.fn(),
    markToolSeen: vi.fn(),
  } as unknown as ProjectionDiffer;
  const cx = { notify: vi.fn().mockResolvedValue(undefined) } as unknown as acp.AgentContext;
  return { server, sent, pollEvent, listener, monitor, differ, cx };
}

describe("runEventTurn: cancel exits immediately (backend ignores session/stop)", () => {
  it("returns cancelled at once when the turn is already flagged", async () => {
    const f = makeTurnFixtures();
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: true, stopSent: false };
    f.pollEvent.mockResolvedValue({
      sessionId: "sess_z",
      seq: 1,
      type: "model.streaming",
      payload: {},
    });

    const resp = await runEventTurn(
      f.server,
      f.listener,
      f.monitor,
      f.differ,
      f.cx,
      "acp_a",
      "m1",
      turn,
      false,
    );

    expect(resp).toEqual({ stopReason: "cancelled" });
    // Guard-fired stop pair (stopSent was false), and NOT a single event consumed.
    expect(f.sent.map((s) => s.method)).toEqual(["session/stop", "v4/command"]);
    expect(f.pollEvent).not.toHaveBeenCalled();
  });

  it("returns cancelled on the next loop pass after a mid-stream cancel", async () => {
    const f = makeTurnFixtures();
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };
    // Pass 1: normal turn.started → loop keeps going. Pass 2 would block on a
    // null poll, but the flag flips first (as cancel() would) → early return.
    f.pollEvent.mockResolvedValueOnce({
      sessionId: "sess_z",
      seq: 1,
      type: "turn.started",
      payload: {},
    });
    f.pollEvent.mockImplementation(async () => {
      turn.cancelled = true; // cancel() lands while the loop polls
      return null;
    });

    const resp = await runEventTurn(
      f.server,
      f.listener,
      f.monitor,
      f.differ,
      f.cx,
      "acp_a",
      "m1",
      turn,
      false,
    );

    expect(resp).toEqual({ stopReason: "cancelled" });
    expect(f.sent.map((s) => s.method)).toEqual(["session/stop", "v4/command"]);
  });

  it("does not re-fire session/stop when the guard already sent one", async () => {
    const f = makeTurnFixtures();
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: true, stopSent: true };

    const resp = await runEventTurn(
      f.server,
      f.listener,
      f.monitor,
      f.differ,
      f.cx,
      "acp_a",
      "m1",
      turn,
      false,
    );

    expect(resp).toEqual({ stopReason: "cancelled" });
    expect(f.sent).toEqual([]);
  });

  it("reports a steered-and-dropped send at once instead of hanging (turn.steerQueued)", async () => {
    const f = makeTurnFixtures();
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };
    // The send landed mid-generation: the backend queued it as steer input
    // (silently dropped when the old turn ends) and emitted steerQueued. No
    // turn.started will ever arrive — report the swallow immediately rather
    // than hanging until the 120s watchdog.
    f.pollEvent.mockResolvedValue({
      sessionId: "sess_z",
      seq: 1,
      type: "turn.steerQueued",
      payload: {},
    });

    const resp = await runEventTurn(
      f.server,
      f.listener,
      f.monitor,
      f.differ,
      f.cx,
      "acp_a",
      "m1",
      turn,
      true, // gate armed: cancel/preempt window
    );

    expect(resp).toEqual({ stopReason: "max_turn_requests" });
    // Nothing of ours is generating — no stop pair; the visible note tells
    // the user to resend.
    expect(f.sent).toEqual([]);
    const note = f.cx.notify.mock.calls.find((c) => JSON.stringify(c).includes("重新发送"));
    expect(note).toBeDefined();
  });

  it("does not report a steerQueued event once the turn has started", async () => {
    const f = makeTurnFixtures();
    const turn: PendingTurn = { zcodeSid: "sess_z", cancelled: false };
    f.pollEvent.mockResolvedValueOnce({
      sessionId: "sess_z",
      seq: 1,
      type: "turn.started",
      payload: {},
    });
    f.pollEvent.mockImplementation(async () => {
      turn.cancelled = true; // end the loop via the cancel path
      return {
        sessionId: "sess_z",
        seq: 2,
        type: "turn.steerQueued",
        payload: {},
      };
    });

    const resp = await runEventTurn(
      f.server,
      f.listener,
      f.monitor,
      f.differ,
      f.cx,
      "acp_a",
      "m1",
      turn,
      true,
    );

    // turn.started already passed: a late steerQueued belongs to someone
    // else's send — the translator ignores it and the loop does NOT fire the
    // steer report; the cancel flag ends the turn instead.
    expect(resp).toEqual({ stopReason: "cancelled" });
    expect(f.sent.map((s) => s.method)).toEqual(["session/stop", "v4/command"]);
    expect(f.cx.notify.mock.calls.some((c) => JSON.stringify(c).includes("重新发送"))).toBe(false);
  });
});
