/**
 * EventTranslator unit tests — ported from the Python test_event_translator.
 * Drives translate() with synthetic zcode events and asserts the internal
 * event dicts. No backend or ACP client required.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

  it("preserves the base mode and Plan flag from a SessionModeChanged event", () => {
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
    expect(out).toEqual([{ kind: "ConfigChanged", mode: "yolo", planEnabled: true }]);
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

/**
 * The LLM-only turn clock (ADR-0037): wall time from OUR turn.started arrival
 * to turn.completed arrival minus the UNION of tool-execution windows.
 * Driven under vitest fake timers so every Date.now() hop is deterministic.
 */
describe("EventTranslator llm clock (llmMs)", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  const scheduled = (id: string) =>
    ev("tool.updated", { kind: "scheduled", toolCallId: id, toolName: "Bash" });
  const result = (id: string) =>
    ev("tool.updated", { kind: "result", toolCallId: id, result: { content: "x" } });

  it("publishes wall − tool-window union; overlapping (parallel) tools are merged, not summed", () => {
    const t = new EventTranslator();
    vi.setSystemTime(1_000);
    t.translate(ev("turn.started", {}, "turn1"));
    vi.setSystemTime(2_000);
    t.translate(scheduled("a"));
    // b starts while a still runs: shared wall time, must not double-subtract.
    vi.setSystemTime(2_500);
    t.translate(scheduled("b"));
    vi.setSystemTime(3_500);
    t.translate(result("a"));
    t.translate(result("b"));
    vi.setSystemTime(5_000);
    t.translate(ev("turn.completed", { resultType: "success", usage: { outputTokens: 100 } }));
    // wall 4000; a=[2000,3500] b=[2500,3500] → union 1500 (a naive sum is 2500).
    expect(t.turnUsage?.["llmMs"]).toBe(2_500);
    // ACP-facing token fields stay untouched by the clock.
    expect(t.turnUsage?.["outputTokens"]).toBe(100);
  });

  it("clamps windows never closed by a terminal tool update at turn.completed", () => {
    const t = new EventTranslator();
    vi.setSystemTime(1_000);
    t.translate(ev("turn.started", {}, "turn1"));
    vi.setSystemTime(2_000);
    t.translate(scheduled("stuck"));
    vi.setSystemTime(6_000);
    t.translate(ev("turn.completed", { resultType: "success", usage: { outputTokens: 10 } }));
    // wall 5000; stuck clamped to [2000,6000] → llm 1000.
    expect(t.turnUsage?.["llmMs"]).toBe(1_000);
  });

  it("does not synthesize usage (or llmMs) when turn.completed carries none", () => {
    const t = new EventTranslator();
    vi.setSystemTime(1_000);
    t.translate(ev("turn.started", {}, "turn1"));
    vi.setSystemTime(3_000);
    t.translate(ev("turn.completed", { resultType: "success" }));
    expect(t.turnUsage).toBeNull();
  });

  it("publishes nothing on turn.failed and stops the clock", () => {
    const t = new EventTranslator();
    vi.setSystemTime(1_000);
    t.translate(ev("turn.started", {}, "turn1"));
    vi.setSystemTime(1_500);
    t.translate(scheduled("a"));
    vi.setSystemTime(2_000);
    t.translate(ev("turn.failed", { error: { code: "1308" } }));
    expect(t.turnUsage).toBeNull();
  });

  it("sums llmMs across a held-prompt chain; a late bg-card result does not pollute the next turn", () => {
    const t = new EventTranslator();
    // Chain turn 1: launches a background card that will outlive the turn.
    vi.setSystemTime(1_000);
    t.translate(ev("turn.started", {}, "turn1"));
    vi.setSystemTime(2_000);
    t.translate(ev("tool.updated", { kind: "scheduled", toolCallId: "bg1", toolName: "Agent" }));
    vi.setSystemTime(4_000);
    t.translate(ev("turn.completed", { resultType: "success", usage: { outputTokens: 10 } }));
    // bg1 window clamped to the turn end: llm = 3000 − 2000 = 1000.
    expect(t.turnUsage?.["llmMs"]).toBe(1_000);

    t.beginChainedTurn();
    // Chain turn 2: no new tools; the bg1 result lands mid-turn.
    vi.setSystemTime(5_000);
    t.translate(ev("turn.started", {}, "turn2"));
    vi.setSystemTime(5_500);
    t.translate(result("bg1"));
    vi.setSystemTime(7_000);
    t.translate(ev("turn.completed", { resultType: "success", usage: { outputTokens: 20 } }));
    // llm 2000 (bg1 is not a window of this turn) + chain 1000 = 3000.
    expect(t.turnUsage?.["llmMs"]).toBe(3_000);
    expect(t.turnUsage?.["outputTokens"]).toBe(30); // token fields still sum
  });

  it("skips tools of a foreign internal turn and clock events outside our turn", () => {
    const t = new EventTranslator();
    vi.setSystemTime(1_000);
    t.translate(ev("turn.started", {}, "turn1"));
    // A backend-internal (goal/compact) turn starts mid-turn: its tool events
    // belong to THAT turn and are dropped until it completes.
    vi.setSystemTime(2_000);
    t.translate(ev("turn.started", {}, "internal"));
    vi.setSystemTime(2_500);
    t.translate(scheduled("foreign-tool"));
    vi.setSystemTime(3_000);
    t.translate(ev("turn.completed", { resultType: "success" }, "internal"));
    vi.setSystemTime(4_000);
    t.translate(
      ev("turn.completed", { resultType: "success", usage: { outputTokens: 5 } }, "turn1"),
    );
    // wall 3000; foreign tool never opened a window → llm = 3000.
    expect(t.turnUsage?.["llmMs"]).toBe(3_000);
  });

  it("tool events of ANOTHER turn open no clock window (mirrored subagent tools)", () => {
    const t = new EventTranslator();
    // Chain turn 1 launches background subagents (4.0: always in the
    // background) and ends.
    vi.setSystemTime(1_000);
    t.translate(ev("turn.started", {}, "turn1"));
    vi.setSystemTime(2_000);
    t.translate(
      ev("turn.completed", { resultType: "success", usage: { outputTokens: 10 } }, "turn1"),
    );
    // Chain turn 2 (the adopted follow-up). The siblings' tool calls are
    // mirrored onto the parent stream under the LAUNCHING turn's id — they
    // still render as tool cards, but they are not this turn's work.
    t.beginChainedTurn();
    vi.setSystemTime(3_000);
    t.translate(ev("turn.started", {}, "turn2"));
    vi.setSystemTime(3_500);
    const mirrored = t.translate(
      ev(
        "tool.updated",
        { kind: "scheduled", toolCallId: "tool_subagent_a_1", toolName: "Bash" },
        "turn1",
      ),
    );
    expect(mirrored.some((r) => r.kind === "ToolCallNew")).toBe(true);
    vi.setSystemTime(6_000);
    t.translate(
      ev(
        "tool.updated",
        { kind: "result", toolCallId: "tool_subagent_a_1", result: { content: "x" } },
        "turn1",
      ),
    );
    // This turn's OWN tool still counts.
    vi.setSystemTime(6_500);
    t.translate(
      ev("tool.updated", { kind: "scheduled", toolCallId: "own", toolName: "Bash" }, "turn2"),
    );
    vi.setSystemTime(7_000);
    t.translate(
      ev("tool.updated", { kind: "result", toolCallId: "own", result: { content: "x" } }, "turn2"),
    );
    vi.setSystemTime(8_000);
    t.translate(
      ev("turn.completed", { resultType: "success", usage: { outputTokens: 20 } }, "turn2"),
    );
    // turn2: wall 5000, own window [6500,7000] → 4500; the mirrored
    // [3500,6000] is ignored (without the gate it would leave 2000). Chain:
    // 1000 + 4500.
    expect(t.turnUsage?.["llmMs"]).toBe(5_500);
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
