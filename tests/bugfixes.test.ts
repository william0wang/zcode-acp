/**
 * Regression tests for bugs found during review.
 *
 * Bug A  — pollEvent must not deliver an event to a timed-out (settled) waiter.
 * Bug C  — cancel() flips the SAME turn object the loop reads (shared reference).
 * Bug D  — turn completion runs differ.diff() (emits PlanUpdate).
 * Bug G  — turn.completed(resultType:"cancelled") → stopReason cancelled.
 * Bug I  — stableStringify sorts keys (stable plan signature).
 */

import { describe, expect, it, vi } from "vitest";

import { EventStreamListener } from "../src/backend/listener.js";
import { ZcodeBackend } from "../src/backend/client.js";
import { ProjectionDiffer } from "../src/translators/projection-differ.js";
import { flattenTodos } from "../src/handlers/session.js";
import { CONFIG_META } from "../src/utils.js";
import type { ZcodeEvent, ZcodeResponse } from "../src/backend/types.js";

/** Build a listener over a fake backend (no subprocess; we drive handleEvent). */
function makeListener(): EventStreamListener {
  const fake = new ZcodeBackend([process.execPath, "-e", "process.stdin.resume()"], process.env);
  return new EventStreamListener(fake, "sess_x");
}

function makeEvent(seq: number, type: string): ZcodeEvent {
  return { sessionId: "sess_x", seq, type: type as ZcodeEvent["type"], payload: {} };
}

describe("Bug A: pollEvent zombie waiter", () => {
  it("does not deliver an event to a timed-out waiter", async () => {
    const listener = makeListener();
    // First poll times out (no event). The waiter settles with null.
    const r1 = await listener.pollEvent(80);
    expect(r1).toBeNull();
    // Now a real event arrives. It must be QUEUED, not delivered to the dead waiter.
    const ev = makeEvent(1, "turn.started");
    listener.handleEvent(ev);
    // Next poll must return that event — proving it wasn't swallowed.
    const r2 = await listener.pollEvent(80);
    expect(r2).toEqual(ev);
  });

  it("delivers an event to an active waiter immediately", async () => {
    const listener = makeListener();
    const pollP = listener.pollEvent(500);
    listener.handleEvent(makeEvent(1, "turn.started"));
    const r = await pollP;
    expect(r?.type).toBe("turn.started");
  });
});

describe('subscribe error surfacing (no more misleading "0.14.8 required")', () => {
  // Before the fix, subscribe() returned null on ANY backend error and the
  // caller threw a hardcoded "session/subscribe failed (ZCode CLI 0.14.8+
  // required)" string. That misled users whose CLI was already new — the real
  // cause (backend dead / timeout / pipe broken / session error) was swallowed.
  // Now subscribe() throws with the backend's real error message.

  it("throws with the backend's real error message on reader-dead failure", async () => {
    const fake = new ZcodeBackend([process.execPath, "-e", "process.stdin.resume()"], process.env);
    const listener = new EventStreamListener(fake, "sess_x");
    vi.spyOn(fake, "request").mockResolvedValue({
      id: 1,
      error: { message: "zcode backend reader exited (backend dead)" },
    });
    await expect(listener.subscribe(() => 1)).rejects.toThrow(
      /session\/subscribe failed: zcode backend reader exited/,
    );
    // Crucially, the error must NOT blame the CLI version.
    await expect(listener.subscribe(() => 1)).rejects.toThrow(/^((?!0\.14\.8).)*$/s);
  });

  it("includes the error code when the backend provides one (old CLI method-not-found)", async () => {
    const fake = new ZcodeBackend([process.execPath, "-e", "process.stdin.resume()"], process.env);
    const listener = new EventStreamListener(fake, "sess_x");
    vi.spyOn(fake, "request").mockResolvedValue({
      id: 1,
      error: { message: "method not found", code: -32601 },
    });
    await expect(listener.subscribe(() => 1)).rejects.toThrow(
      /session\/subscribe failed: method not found \(code -32601\)/,
    );
  });

  it("returns the snapshot (not null) on success", async () => {
    const fake = new ZcodeBackend([process.execPath, "-e", "process.stdin.resume()"], process.env);
    const listener = new EventStreamListener(fake, "sess_x");
    const snap = { projection: { status: "idle" }, messages: [] };
    vi.spyOn(fake, "request").mockResolvedValue({
      id: 1,
      result: { eventSeq: 5, snapshot: snap },
    } as ZcodeResponse);
    const result = await listener.subscribe(() => 1);
    expect(result).toEqual(snap);
    expect(listener.subscribed).toBe(true);
    expect(listener.lastSeq).toBe(5);
  });
});

describe("subscribe retries transient timeout (preempt busy window)", () => {
  // After a preempt the backend can be briefly busy; a subscribe issued in that
  // window times out. subscribe() should retry transient timeouts and succeed
  // once the backend recovers, instead of failing the turn.

  it("retries on timeout and succeeds on a later attempt", async () => {
    const fake = new ZcodeBackend([process.execPath, "-e", "process.stdin.resume()"], process.env);
    const listener = new EventStreamListener(fake, "sess_x");
    const snap = { projection: { status: "idle" }, messages: [] };
    const requestSpy = vi.spyOn(fake, "request");
    requestSpy
      .mockResolvedValueOnce({ id: 1, error: { message: "timeout" } })
      .mockResolvedValueOnce({
        id: 2,
        result: { eventSeq: 5, snapshot: snap },
      } as ZcodeResponse);
    // Fake timers so the backoff sleeps don't slow the test.
    vi.useFakeTimers();
    const subP = listener.subscribe(() => 1);
    // Flush the backoff sleeps interleaved with the awaits.
    await vi.runAllTimersAsync();
    const result = await subP;
    vi.useRealTimers();
    expect(result).toEqual(snap);
    expect(listener.subscribed).toBe(true);
    expect(listener.lastSeq).toBe(5);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on non-transient errors (reader dead)", async () => {
    const fake = new ZcodeBackend([process.execPath, "-e", "process.stdin.resume()"], process.env);
    const listener = new EventStreamListener(fake, "sess_x");
    const requestSpy = vi.spyOn(fake, "request").mockResolvedValue({
      id: 1,
      error: { message: "zcode backend reader exited (backend dead)" },
    } as ZcodeResponse);
    await expect(listener.subscribe(() => 1)).rejects.toThrow(/reader exited/);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on method-not-found (old CLI)", async () => {
    const fake = new ZcodeBackend([process.execPath, "-e", "process.stdin.resume()"], process.env);
    const listener = new EventStreamListener(fake, "sess_x");
    const requestSpy = vi.spyOn(fake, "request").mockResolvedValue({
      id: 1,
      error: { message: "method not found", code: -32601 },
    } as ZcodeResponse);
    await expect(listener.subscribe(() => 1)).rejects.toThrow(/method not found \(code -32601\)/);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting all retries", async () => {
    const fake = new ZcodeBackend([process.execPath, "-e", "process.stdin.resume()"], process.env);
    const listener = new EventStreamListener(fake, "sess_x");
    vi.spyOn(fake, "request").mockResolvedValue({
      id: 1,
      error: { message: "timeout" },
    } as ZcodeResponse);
    vi.useFakeTimers();
    // Attach the rejection handler up front so the eventual rejection is never
    // "unhandled" during the timer flush window.
    const subP = listener.subscribe(() => 1).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await subP;
    vi.useRealTimers();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/session\/subscribe failed: timeout/);
  });
});

describe("Bug I: stableStringify / plan signature stability", () => {
  it("treats same todos with different key order as the same signature", () => {
    const d1 = new ProjectionDiffer();
    const d2 = new ProjectionDiffer();
    const snap1 = {
      projection: {},
      messages: [],
      todos: [{ content: "a", status: "pending", priority: "high", extra: 1 }],
    };
    const snap2 = {
      projection: {},
      messages: [],
      todos: [{ priority: "high", extra: 1, status: "pending", content: "a" }],
    };
    d1.diff(snap1);
    // d2 starts fresh; same logical todos, different key order → must NOT emit.
    const events = d2.diff(snap2);
    const hasPlan = events.some((e) => e.kind === "PlanUpdate");
    // d2's first diff always emits (initial __none__), so compare d1's second diff.
    d1.diff(snap1); // already seen signature
    const secondSnapDiff = d1.diff(snap2);
    const secondHasPlan = secondSnapDiff.some((e) => e.kind === "PlanUpdate");
    expect(hasPlan).toBe(true); // first diff emits (baseline)
    expect(secondHasPlan).toBe(false); // key-order difference must NOT re-emit
    void events;
  });
});

describe("diffPlan: standalone plan detection (mid-turn TODO sync)", () => {
  it("emits PlanUpdate on first call (baseline)", () => {
    const d = new ProjectionDiffer();
    const events = d.diffPlan([{ content: "task A", status: "pending", priority: "high" }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "PlanUpdate" });
  });

  it("does not re-emit when todos are unchanged", () => {
    const d = new ProjectionDiffer();
    d.diffPlan([{ content: "task A", status: "pending", priority: "high" }]);
    const events = d.diffPlan([{ content: "task A", status: "pending", priority: "high" }]);
    expect(events).toHaveLength(0);
  });

  it("emits when a todo status changes (pending → completed)", () => {
    const d = new ProjectionDiffer();
    d.diffPlan([{ content: "task A", status: "pending", priority: "high" }]);
    const events = d.diffPlan([{ content: "task A", status: "completed", priority: "high" }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "PlanUpdate",
      entries: [{ content: "task A", status: "completed", priority: "high" }],
    });
  });

  it("shares state with diff() so turn-completion does not re-emit", () => {
    const d = new ProjectionDiffer();
    const todos = [{ content: "task A", status: "pending", priority: "medium" }];
    d.diffPlan(todos);
    // Turn completion calls full diff() with the same todos — should NOT re-emit plan.
    const events = d.diff({ projection: {}, messages: [], todos });
    expect(events.filter((e) => e.kind === "PlanUpdate")).toHaveLength(0);
  });
});

describe("Bug 3: thought configOption metadata matches Python", () => {
  it("uses thought_level category, Thought Level name, lowercase option names", () => {
    expect(CONFIG_META.thought.category).toBe("thought_level");
    expect(CONFIG_META.thought.name).toBe("Thought Level");
    const names = CONFIG_META.thought.options.map((o) => o.name);
    expect(names).toEqual(["max", "high", "nothink"]);
  });

  it("uses lowercase mode option names", () => {
    const names = CONFIG_META.mode.options.map((o) => o.name);
    expect(names).toEqual(["plan", "build", "edit", "yolo", "auto"]);
  });
});

describe("Bug 5: usage fallback treats contextUsed=0 as falsy", () => {
  it("ProjectionDiffer falls back to totalTokenCount when contextUsed is 0", () => {
    const d = new ProjectionDiffer();
    const events = d.diff({
      projection: { contextUsed: 0, totalTokenCount: 5000, contextWindow: 200000 },
      messages: [],
      todos: [],
    });
    const usage = events.find((e) => e.kind === "UsageDelta") as
      { kind: "UsageDelta"; used: number; size: number } | undefined;
    expect(usage).toBeDefined();
    expect(usage?.used).toBe(5000); // contextUsed=0 falls back to totalTokenCount
  });
});

describe("Bug #4: flattenTodos flattens todoGroups list (not single object)", () => {
  it("prefers top-level todos when non-empty", () => {
    const out = flattenTodos([{ content: "a" }], [{ entries: [{ content: "b" }] }]);
    expect(out).toEqual([{ content: "a" }]);
  });

  it("flattens todoGroups[].entries when top-level todos is empty", () => {
    const out = flattenTodos(
      [],
      [{ entries: [{ content: "a" }, { content: "b" }] }, { entries: [{ content: "c" }] }],
    );
    expect(out).toEqual([{ content: "a" }, { content: "b" }, { content: "c" }]);
  });

  it("flattens todoGroups[].todos (alternate key) when entries absent", () => {
    const out = flattenTodos(undefined, [{ todos: [{ content: "x" }] }]);
    expect(out).toEqual([{ content: "x" }]);
  });

  it("returns empty when both todos and todoGroups are empty/absent", () => {
    expect(flattenTodos(undefined, undefined)).toEqual([]);
    expect(flattenTodos([], [])).toEqual([]);
    expect(flattenTodos([], undefined)).toEqual([]);
  });
});
