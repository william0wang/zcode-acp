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
import { describe, expect, it, vi } from "vitest";

import type { EventStreamListener, TurnMonitor } from "../src/backend/listener.js";
import type { ProjectionDiffer } from "../src/translators/projection-differ.js";
import { cancel, runEventTurn } from "../src/handlers/session.js";
import type { PendingTurn, ZcodeAcpServer } from "../src/server.js";

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
  it("marks the matching turn cancelled and fires session/stop once", async () => {
    const turn: FakeTurn = { zcodeSid: "sess_z", cancelled: false, stopSent: false };
    const { server, sent } = makeServer([turn], (sid) => (sid === "acp_a" ? "sess_z" : undefined));

    await cancel(server, { sessionId: "acp_a" } as acp.CancelNotification);

    expect(turn.cancelled).toBe(true);
    expect(turn.stopSent).toBe(true);
    expect(sent).toEqual([{ method: "session/stop", params: { sessionId: "sess_z" } }]);
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
    // The already-stopped turn does not fire a second stop.
    expect(sent).toEqual([{ method: "session/stop", params: { sessionId: "sess_z" } }]);
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
    // Guard-fired stop (stopSent was false), and NOT a single event consumed.
    expect(f.sent).toEqual([{ method: "session/stop", params: { sessionId: "sess_z" } }]);
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
    expect(f.sent).toEqual([{ method: "session/stop", params: { sessionId: "sess_z" } }]);
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
});
