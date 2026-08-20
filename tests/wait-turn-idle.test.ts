/**
 * Tests for waitForTurnIdle's lock-watching grace.
 *
 * expectLock exists to skip the "internal turn not started yet" window right
 * after session/compact — a probe that succeeds immediately is a false
 * "released". Previously, if the lock was NEVER observed (a turn that
 * finished between two probes, or a backend whose lock error message drifted
 * away from "prompt is running"), the loop spun the full 300s timeout and
 * reported a false failure. The grace bounds the lock-watching phase: past
 * graceMs, a successful probe (or a non-lock error) counts as released.
 */

import { describe, expect, it } from "vitest";

import type { ZcodeAcpServer } from "../src/server.js";
import { waitForTurnIdle } from "../src/handlers/extensions.js";

/** Probe response shape: { error: { message } } or {} for success. */
type Probe = { error?: { message: string } };

function makeServer(probes: Probe[]): ZcodeAcpServer {
  let i = 0;
  const backend = {
    request: () => Promise.resolve(probes[i++] ?? ({} as Probe)),
  };
  return {
    nextId: (() => {
      let n = 0;
      return () => ++n;
    })(),
    ensureBackend: () => backend,
  } as unknown as ZcodeAcpServer;
}

const LOCK_HELD = { error: { message: "session goal: prompt is running" } };

describe("waitForTurnIdle lock-watching grace", () => {
  it("classic path unchanged: lock observed once, later probe success releases", async () => {
    const server = makeServer([LOCK_HELD, {}]);
    const released = await waitForTurnIdle(server, "zs1", 10_000, "session/goal", true);
    expect(released).toBe(true);
  });

  it("non-lock error after lock seen releases (existing behaviour)", async () => {
    const server = makeServer([LOCK_HELD, { error: { message: "something else" } }]);
    const released = await waitForTurnIdle(server, "zs1", 10_000, "session/goal", true);
    expect(released).toBe(true);
  });

  it("lock never seen + grace expired → probe success counts as released", async () => {
    // Every probe succeeds (turn already done between probes, or too fast to
    // observe). Real timers: probe #1 inside the 50ms grace waits 500ms;
    // probe #2 is past the grace and releases.
    const server = makeServer([{}, {}, {}]);
    const released = await waitForTurnIdle(server, "zs1", 10_000, "session/goal", true, 50);
    expect(released).toBe(true);
  });

  it("lock never seen + drifted error message + grace expired → released", async () => {
    // Backend drift: the lock error no longer says "prompt is running".
    const drifted = { error: { message: "turn in progress (renamed)" } };
    const server = makeServer([drifted, drifted, drifted]);
    const released = await waitForTurnIdle(server, "zs1", 10_000, "session/goal", true, 50);
    expect(released).toBe(true);
  });

  it("lock never seen + grace not expired + timeout hit → false (no false success)", async () => {
    // Grace longer than the timeout: still waiting for the lock when the
    // timeout expires → false, preserving the expectLock guarantee.
    const server = makeServer([{}, {}, {}]);
    const released = await waitForTurnIdle(server, "zs1", 50, "session/goal", true, 10_000);
    expect(released).toBe(false);
  });
});
