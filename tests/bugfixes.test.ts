/**
 * Regression tests for bugs found during review.
 *
 * Bug A  — pollEvent must not deliver an event to a timed-out (settled) waiter.
 * Bug C  — cancel() flips the SAME turn object the loop reads (shared reference).
 * Bug D  — turn completion runs differ.diff() (emits PlanUpdate).
 * Bug G  — turn.completed(resultType:"cancelled") → stopReason cancelled.
 * Bug I  — stableStringify sorts keys (stable plan signature).
 */

import { describe, expect, it } from "vitest";

import { EventStreamListener } from "../src/backend/listener.js";
import { ZcodeBackend } from "../src/backend/client.js";
import { ProjectionDiffer } from "../src/translators/projection-differ.js";
import { flattenTodos } from "../src/handlers/session.js";
import { CONFIG_META } from "../src/utils.js";
import type { ZcodeEvent } from "../src/backend/types.js";

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
    const out = flattenTodos([], [
      { entries: [{ content: "a" }, { content: "b" }] },
      { entries: [{ content: "c" }] },
    ]);
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
