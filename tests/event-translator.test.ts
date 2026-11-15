/**
 * EventTranslator unit tests — ported from the Python test_event_translator.
 * Drives translate() with synthetic zcode events and asserts the internal
 * event dicts. No backend or ACP client required.
 */

import { describe, expect, it } from "vitest";

import { EventTranslator } from "../src/translators/event-translator.js";
import type { InternalEvent } from "../src/translators/types.js";

function ev(
  type: string,
  payload: Record<string, unknown> = {},
  /**
   * turnId rides the event ENVELOPE in production (zcodeEventEnvelopeSchema,
   * zcode-protocol index.ts:1029-1041) — the turn.* payloads are strict and
   * carry no turnId. Pass it here, not inside the payload.
   */
  turnId?: string,
): {
  type: string;
  turnId?: string;
  payload: Record<string, unknown>;
} {
  return turnId === undefined ? { type, payload } : { type, turnId, payload };
}

describe("EventTranslator", () => {
  it("emits a TextDelta on model.streaming text_delta", () => {
    const t = new EventTranslator();
    const out = t.translate(ev("model.streaming", { kind: "text_delta", delta: "hello" }));
    expect(out).toEqual([{ kind: "TextDelta", text: "hello" }]);
  });

  it("carries assistantMessageId onto the emitted TextDelta", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("model.streaming", { kind: "text_delta", delta: "hello", assistantMessageId: "m1" }),
    );
    expect(out).toEqual([{ kind: "TextDelta", text: "hello", messageId: "m1" }]);
  });

  it("caches tool input from tool_call and reuses it on scheduled (inputOmitted)", () => {
    const t = new EventTranslator();
    // model.streaming tool_call carries the full input.
    t.translate(
      ev("model.streaming", {
        kind: "tool_call",
        toolCallId: "c1",
        toolName: "Bash",
        input: { command: "ls -la", description: "list files" },
      }),
    );
    // tool.updated scheduled arrives with input omitted → falls back to cached.
    const out = t.translate(
      ev("tool.updated", { kind: "scheduled", toolCallId: "c1", inputOmitted: true }),
    );
    expect(out).toHaveLength(1);
    const newEv = out[0] as Extract<InternalEvent, { kind: "ToolCallNew" }>;
    expect(newEv.callId).toBe("c1");
    expect(newEv.tool).toBe("Bash");
    expect(newEv.acpKind).toBe("execute");
    expect(newEv.title).toContain("ls -la"); // Bash command NOT truncated
    expect(newEv.input).toEqual({ command: "ls -la", description: "list files" });
  });

  it("dedupes ToolCallNew by call_id across scheduled events", () => {
    const t = new EventTranslator();
    t.translate(ev("tool.updated", { kind: "scheduled", toolCallId: "c2", toolName: "Read" }));
    const out2 = t.translate(
      ev("tool.updated", { kind: "scheduled", toolCallId: "c2", toolName: "Read" }),
    );
    expect(out2).toHaveLength(0);
  });

  it("creates a tool call before completing a result received without prior lifecycle events", () => {
    const t = new EventTranslator();
    t.translate(
      ev("model.streaming", {
        kind: "tool_call",
        toolCallId: "c3_missing_lifecycle",
        toolName: "Read",
        input: { file_path: "README.md" },
      }),
    );

    const out = t.translate(
      ev("tool.updated", {
        kind: "result",
        toolCallId: "c3_missing_lifecycle",
        result: { success: true, content: "file body" },
      }),
    );

    expect(out.map((event) => [event.kind, event.status])).toEqual([
      ["ToolCallNew", "in_progress"],
      ["ToolCallUpdate", "completed"],
    ]);
    expect(out[0]).toMatchObject({
      callId: "c3_missing_lifecycle",
      tool: "Read",
      input: { file_path: "README.md" },
    });
  });

  it("batch backfills only unseen/non-final ids (no content-less overwrite)", () => {
    const t = new EventTranslator();
    t.translate(ev("tool.updated", { kind: "scheduled", toolCallId: "c5", toolName: "Bash" }));
    // c5 already resulted → final.
    t.translate(ev("tool.updated", { kind: "result", toolCallId: "c5", result: { content: "x" } }));
    // batch includes c5 (final, skip) and c6 (unseen, skip — ghost prevention).
    const out = t.translate(
      ev("tool.updated", {
        kind: "batch",
        toolCallIds: ["c5", "c6"],
        successCount: 2,
        errorCount: 0,
      }),
    );
    expect(out).toHaveLength(0);
  });

  it("folds a SessionModeChanged session.updated into the effective mode (plan)", () => {
    // EnterPlanMode flips only the runtime plan flag — the payload's `mode`
    // stays the underlying session mode; the advertised mode must be "plan".
    const t = new EventTranslator();
    const out = t.translate(
      ev("session.updated", {
        mode: "yolo",
        planEnabled: true,
        previousMode: "yolo",
        previousPlanEnabled: false,
        source: "tool",
      }),
    );
    expect(out).toEqual([{ kind: "ConfigChanged", mode: "plan", planEnabled: true }]);
  });

  it("captures turn.failed error and does not treat it as resultType", () => {
    const t = new EventTranslator();
    t.translate(
      ev("turn.failed", { error: { type: "rate_limit", message: "quota exceeded", code: "1308" } }),
    );
    expect(t.turnFailed).toBe(true);
    expect(t.turnDone).toBe(true);
    expect(t.turnResultType).toBe("error");
    expect(t.turnError?.["code"]).toBe("1308");
  });

  it("treats turn.completed resultType=cancelled (not turn.failed)", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.completed", { resultType: "cancelled" }));
    expect(t.turnFailed).toBe(false);
    expect(t.turnResultType).toBe("cancelled");
  });

  it("captures turn.completed usage verbatim and emits NO UsageDelta (#228)", () => {
    const t = new EventTranslator();
    const usage = {
      source: "provider",
      modelRequestCount: 2,
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 60,
      cacheWriteTokens: 5,
      reasoningTokens: 12,
      webFetchRequests: 0,
      webSearchRequests: 1,
    };
    const out = t.translate(
      ev("turn.completed", { resultType: "success", tokenCount: 140, usage }),
    );
    // The usage block is CUMULATIVE turn consumption (multi-request turns can
    // exceed the window) — it must never reach the context meter. Occupancy
    // comes from the reconciliation diff; consumption from PromptResponse.
    expect(t.turnUsage).toEqual(usage);
    expect(out).toEqual([{ kind: "TurnInfo", resultType: "success" }]);
  });
});

describe("EventTranslator background-task turn deferral", () => {
  it("skips every event of a background_task turn (defers to BackgroundTaskListener)", () => {
    const t = new EventTranslator();
    // A background notification turn starts.
    t.translate(ev("turn.started", { inputSource: "background_task" }, "turn_bg"));
    // Its text deltas MUST NOT be emitted (else double-forwarded alongside the
    // bg listener) and MUST NOT set turnStarted.
    const out1 = t.translate(ev("model.streaming", { kind: "text_delta", delta: "bg result" }));
    expect(out1).toEqual([]);
    expect(t.turnStarted).toBe(false);
    // Its turn.completed MUST NOT set turnDone (else it'd exit the user's
    // still-running real turn).
    const out2 = t.translate(ev("turn.completed", { resultType: "success" }));
    expect(out2).toEqual([]);
    expect(t.turnDone).toBe(false);
  });
});

describe("EventTranslator foreign internal-turn attribution", () => {
  it("ignores a goal/compact internal turn started mid-turn (ghost-completed bug)", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.started", {}, "turn_user"));
    // session/goal(set) starts a backend-internal turn on the same session.
    expect(t.translate(ev("turn.started", {}, "turn_goal"))).toEqual([]);
    // Its output and terminal event MUST NOT touch this translator's state.
    expect(t.translate(ev("model.streaming", { kind: "text_delta", delta: "goal ack" }))).toEqual(
      [],
    );
    expect(t.translate(ev("turn.completed", { resultType: "success" }, "turn_goal"))).toEqual([]);
    expect(t.turnDone).toBe(false);
    // The user's own turn completes normally afterwards.
    t.translate(ev("turn.completed", { resultType: "success" }, "turn_user"));
    expect(t.turnDone).toBe(true);
  });

  it("reads turnId from the ENVELOPE, where 0.16.9 puts it", () => {
    // The attribution guard was dead code while it read the payload: the
    // turn.* payloads are strict and carry no turnId (source: zcode-protocol
    // index.ts:1166+, 1229+), so a payload-only read never armed it.
    const t = new EventTranslator();
    t.translate(ev("turn.started", {}, "turn_user"));
    // A control-only turn (session/goal set) lands mid-user-turn.
    expect(t.translate(ev("turn.started", {}, "turn_ctl"))).toEqual([]);
    expect(t.translate(ev("model.streaming", { kind: "text_delta", delta: "ctl" }))).toEqual([]);
    // Its terminal event names ITS turn on the envelope — dropped, and our
    // turn keeps running.
    expect(t.translate(ev("turn.completed", { resultType: "success" }, "turn_ctl"))).toEqual([]);
    expect(t.turnDone).toBe(false);
    t.translate(ev("turn.completed", { resultType: "success" }, "turn_user"));
    expect(t.turnDone).toBe(true);
  });

  it("accepts a turn.completed matching the active turnId", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.started", {}, "turn_user"));
    const out = t.translate(ev("turn.completed", { resultType: "success" }, "turn_user"));
    expect(t.turnDone).toBe(true);
    expect(out).toEqual([{ kind: "TurnInfo", resultType: "success" }]);
  });

  it("processes OUR turn.completed even while a foreign turn is still in flight", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.started", {}, "turn_user"));
    t.translate(ev("turn.started", {}, "turn_goal")); // foreign, skipping
    // The user turn completes FIRST (goal turn still running) — its terminal
    // event must NOT be swallowed as foreign, else the turn loop hangs until
    // the STALE_FREEZE_MS backstop.
    t.translate(ev("turn.completed", { resultType: "success" }, "turn_user"));
    expect(t.turnDone).toBe(true);
  });
});

describe("EventTranslator protocol-layer terminal broadcast (state.updated)", () => {
  // 0.16.9's protocol layer emits state.updated {reason:"prompt_completed"} in
  // runPromptTurnInBackground's finally (server-operations.ts:2469) and
  // "prompt_failed" when the turn threw (:2445). Unlike turn.completed it is
  // emitted by the protocol layer, so it survives a deaf event stream; the
  // turn loop's stall branch consults these flags to end a lost-terminal turn
  // in seconds instead of waiting out STALE_FREEZE_MS.
  it("ignores a terminal broadcast that arrives before our turn.started (previous turn's)", () => {
    const t = new EventTranslator();
    t.translate(ev("state.updated", { reason: "prompt_completed" }));
    expect(t.sawPromptCompleted).toBe(false);
  });
});
