/**
 * Tests for drainBackendAfterCancel — the drain gate prompt() runs after a
 * recent cancel/preempt — and its two post-drain repairs:
 * - resubscribe after the close-escalation reload: the subscription died with
 *   the closed runtime; without re-arming, the next turn is deaf (no events
 *   at all, and stall recovery can't engage because it needs turn.started),
 * - differ re-baseline: the abandoned turn committed messages to the session
 *   history while we waited; without markSeen the completion diff replays
 *   that residue as the next reply's output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnMonitor } from "../src/backend/listener.js";
import { drainBackendAfterCancel } from "../src/handlers/session.js";
import type { PendingTurn, ZcodeAcpServer } from "../src/server.js";

// These tests assert the Chinese message table.
beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "zh");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const fetchMessagesMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../src/handlers/replay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/handlers/replay.js")>();
  return { ...actual, fetchMessages: fetchMessagesMock };
});

interface DrainFixtures {
  server: ZcodeAcpServer;
  sent: Array<{ method: string; params: unknown }>;
  pollOnce: ReturnType<typeof vi.fn>;
  listener: { resubscribe: ReturnType<typeof vi.fn> };
  differ: { markSeen: ReturnType<typeof vi.fn> };
  cx: { notify: ReturnType<typeof vi.fn> };
  deps: Parameters<typeof drainBackendAfterCancel>[1];
}

function makeFixtures(turn: PendingTurn, escalateAfterMs = 0): DrainFixtures {
  const sent: Array<{ method: string; params: unknown }> = [];
  const server = {
    ensureBackend: () => ({
      send: (method: string, params: unknown) => {
        sent.push({ method, params });
      },
      request: async () => ({ result: {} }), // session/resume for the reload
    }),
    nextId: () => 1,
    sessionCwds: new Map(),
    markBackendLoaded: () => {},
  } as unknown as ZcodeAcpServer;
  const pollOnce = vi.fn();
  const listener = { resubscribe: vi.fn(async () => true) };
  const differ = { markSeen: vi.fn() };
  const cx = { notify: vi.fn().mockResolvedValue(undefined) };
  const deps = {
    acpSid: "acp_a",
    zcodeSid: "sess_z",
    turn,
    listener,
    monitor: { pollOnce } as unknown as TurnMonitor,
    differ,
    cx,
    escalateAfterMs,
  } as unknown as Parameters<typeof drainBackendAfterCancel>[1];
  return {
    server,
    sent,
    pollOnce,
    listener: listener as unknown as DrainFixtures["listener"],
    differ: differ as unknown as DrainFixtures["differ"],
    cx: cx as unknown as DrainFixtures["cx"],
    deps,
  };
}

describe("drainBackendAfterCancel", () => {
  it("returns drained and re-baselines when the first probe already sees idle", async () => {
    const f = makeFixtures({ zcodeSid: "sess_z", cancelled: false });
    f.pollOnce.mockResolvedValue({ status: "idle" });

    const result = await drainBackendAfterCancel(f.server, f.deps);

    expect(result).toBe("drained");
    // Nothing to settle: no stop/close, no resubscribe.
    expect(f.sent).toEqual([]);
    expect(f.listener.resubscribe).not.toHaveBeenCalled();
    // Re-baseline always runs: the abandoned turn may have committed messages
    // between the prompt's own baseline and this probe.
    expect(f.differ.markSeen).toHaveBeenCalledTimes(1);
    expect(fetchMessagesMock).toHaveBeenCalledWith(f.server, "sess_z");
  });

  it("emits one wait note and keeps polling until idle (no close below the grace)", async () => {
    const f = makeFixtures(
      { zcodeSid: "sess_z", cancelled: false },
      60_000, // grace far away: the escalation must not fire
    );
    f.pollOnce.mockResolvedValueOnce({ status: "running" }).mockResolvedValue({ status: "idle" });

    const result = await drainBackendAfterCancel(f.server, f.deps);

    expect(result).toBe("drained");
    expect(f.sent).toEqual([]);
    const notes = f.cx.notify.mock.calls.filter((c) =>
      JSON.stringify(c).includes("等待结束后发送"),
    );
    expect(notes).toHaveLength(1);
  });

  it("escalates to session/close, reloads, and re-arms the subscription when the probe dies", async () => {
    const f = makeFixtures({ zcodeSid: "sess_z", cancelled: false });
    f.pollOnce
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValue(null); // probe fails: close tore down the runtime

    const result = await drainBackendAfterCancel(f.server, f.deps);

    expect(result).toBe("drained");
    expect(f.sent).toEqual([{ method: "session/close", params: { sessionId: "sess_z" } }]);
    // The reload alone leaves the turn deaf — resubscribe must re-arm the push.
    expect(f.listener.resubscribe).toHaveBeenCalledTimes(1);
    expect(f.differ.markSeen).toHaveBeenCalledTimes(1);
  });

  it("returns cancelled at once when the turn is flagged during the drain", async () => {
    const f = makeFixtures({ zcodeSid: "sess_z", cancelled: true });
    f.pollOnce.mockResolvedValue({ status: "running" });

    const result = await drainBackendAfterCancel(f.server, f.deps);

    expect(result).toBe("cancelled");
    expect(f.sent.map((s) => s.method)).toEqual(["session/stop", "v4/command"]);
    // Cancelled mid-drain: the next prompt's own drain re-baselines instead.
    expect(f.differ.markSeen).not.toHaveBeenCalled();
  });
});
