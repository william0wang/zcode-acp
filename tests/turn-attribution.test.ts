/**
 * Regression tests for the "compaction → UI shows nothing" bug.
 *
 * Root cause (sess_b3249788 incident, 2026-08-12): after a compaction the
 * backend auto-resumes the main-branch turn. A user send made while that turn
 * is still active is steered into it and produces NO new `turn.started`. The
 * old turn-attribution gate (commit f49eb91) dropped every event until a
 * `turn.started` arrived, silently swallowing the whole turn's output in the
 * UI. The gate now only fires when this send preempted another prompt (the
 * only case leftover residue exists), and the turn-completion replay re-emits
 * assistant text that never reached the live event stream (deduped per message
 * id so live-streamed content is not duplicated).
 */

import { describe, expect, it } from "vitest";

import { shouldDropEventForTurnAttribution } from "../src/handlers/session.js";
import { ProjectionDiffer } from "../src/translators/projection-differ.js";
import { EventTranslator } from "../src/translators/event-translator.js";
import type { ZcodeMessage } from "../src/backend/types.js";

function ev(type: string) {
  return { type };
}

describe("turn-attribution gate: steer into a backend-owned turn must NOT be dropped", () => {
  it("keeps events when the send did not preempt anything (steer into resumed turn)", () => {
    // Compression just finished; the backend resumed its main-branch turn and
    // this send was steered into it — no new turn.started will ever arrive.
    expect(
      shouldDropEventForTurnAttribution(ev("model.streaming"), /* turnStarted */ false, /* preempted */ false),
    ).toBe(false);
    expect(
      shouldDropEventForTurnAttribution(ev("tool.updated"), /* turnStarted */ false, /* preempted */ false),
    ).toBe(false);
    // Its natural completion must also pass so the loop terminates normally.
    expect(
      shouldDropEventForTurnAttribution(ev("turn.completed"), /* turnStarted */ false, /* preempted */ false),
    ).toBe(false);
  });

  it("drops preempt residue only when this send cancelled another prompt", () => {
    // User interrupted an in-flight prompt: leftover events of the cancelled
    // turn land in the new listener's queue and must not contaminate it.
    expect(
      shouldDropEventForTurnAttribution(ev("model.streaming"), /* turnStarted */ false, /* preempted */ true),
    ).toBe(true);
    expect(
      shouldDropEventForTurnAttribution(ev("turn.completed"), /* turnStarted */ false, /* preempted */ true),
    ).toBe(true);
  });

  it("never drops anything once this turn's own turn.started arrived", () => {
    expect(
      shouldDropEventForTurnAttribution(ev("model.streaming"), /* turnStarted */ true, /* preempted */ true),
    ).toBe(false);
    expect(
      shouldDropEventForTurnAttribution(ev("turn.completed"), /* turnStarted */ true, /* preempted */ true),
    ).toBe(false);
  });

  it("never drops a turn.started event itself", () => {
    expect(
      shouldDropEventForTurnAttribution(ev("turn.started"), /* turnStarted */ false, /* preempted */ true),
    ).toBe(false);
  });
});

describe("turn-completion replay: re-emit text never streamed live, dedup by message id", () => {
  function assistantMsg(id: string, text: string, reasoning?: string): ZcodeMessage {
    const parts: Array<Record<string, unknown>> = [{ type: "text", text }];
    if (reasoning) parts.push({ type: "reasoning", text: reasoning });
    return { info: { id, role: "assistant" }, parts };
  }

  it("tags replayed TextDelta/ReasoningDelta with the backend message id", () => {
    const differ = new ProjectionDiffer();
    const events = differ.diff({
      projection: { status: "idle" },
      messages: [assistantMsg("msg_missing_1", "output produced while no listener was attached")],
    });
    const text = events.find((e) => e.kind === "TextDelta");
    expect(text).toEqual({
      kind: "TextDelta",
      text: "output produced while no listener was attached",
      messageId: "msg_missing_1",
    });
  });

  it("translator records assistantMessageId from the live stream", () => {
    const t = new EventTranslator();
    t.translate({
      type: "model.streaming",
      payload: { kind: "text_delta", delta: "live text", assistantMessageId: "msg_live_1" },
    });
    expect(t.deliveredMessageIds.has("msg_live_1")).toBe(true);
  });

  it("streamed-then-replayed messages are skipped, missing ones are kept", () => {
    // Baseline: a message the differ has seen is never re-emitted.
    const differ = new ProjectionDiffer();
    differ.markSeen([assistantMsg("msg_old", "previous turn")]);

    const events = differ.diff({
      projection: { status: "idle" },
      messages: [
        assistantMsg("msg_live_1", "streamed live"),
        assistantMsg("msg_missing_2", "produced while no listener attached"),
      ],
    });

    // Turn-loop side of the dedup (mirrors runEventTurn): skip deltas whose
    // message id was already delivered via the event stream.
    const translator = new EventTranslator();
    translator.deliveredMessageIds.add("msg_live_1");
    const replayed = events.filter(
      (e) =>
        !(
          (e.kind === "TextDelta" || e.kind === "ReasoningDelta") &&
          e.messageId &&
          translator.deliveredMessageIds.has(e.messageId)
        ),
    );
    const texts = replayed.filter((e) => e.kind === "TextDelta");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ kind: "TextDelta", messageId: "msg_missing_2" });
  });
});
