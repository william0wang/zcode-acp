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

  it("omits messageId when the streaming payload carries no assistantMessageId", () => {
    const t = new EventTranslator();
    const out = t.translate(ev("model.streaming", { kind: "text_delta", delta: "hello" }));
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty("messageId");
  });

  it("carries assistantMessageId onto the emitted ReasoningDelta", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("model.streaming", {
        kind: "reasoning_delta",
        delta: "thinking",
        assistantMessageId: "m2",
      }),
    );
    expect(out).toEqual([{ kind: "ReasoningDelta", text: "thinking", messageId: "m2" }]);
  });

  it("emits a ReasoningDelta on reasoning_delta", () => {
    const t = new EventTranslator();
    const out = t.translate(ev("model.streaming", { kind: "reasoning_delta", delta: "thinking" }));
    expect(out).toEqual([{ kind: "ReasoningDelta", text: "thinking" }]);
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

  it("creates an in-progress tool call when started arrives without scheduled", () => {
    const t = new EventTranslator();
    t.translate(
      ev("model.streaming", {
        kind: "tool_call",
        toolCallId: "c2_missing_scheduled",
        toolName: "Bash",
        input: { command: "sleep 140" },
      }),
    );

    const out = t.translate(
      ev("tool.updated", { kind: "started", toolCallId: "c2_missing_scheduled" }),
    );

    expect(out).toEqual([
      expect.objectContaining({
        kind: "ToolCallNew",
        callId: "c2_missing_scheduled",
        tool: "Bash",
        status: "in_progress",
        title: "Bash: sleep 140",
        input: { command: "sleep 140" },
      }),
    ]);
    expect(t.seenToolIds.has("c2_missing_scheduled")).toBe(true);
    expect(
      t.translate(
        ev("tool.updated", {
          kind: "scheduled",
          toolCallId: "c2_missing_scheduled",
          toolName: "Bash",
        }),
      ),
    ).toEqual([]);
  });

  it("translates tool.updated result → completed ToolCallUpdate with content for Read", () => {
    const t = new EventTranslator();
    t.translate(ev("tool.updated", { kind: "scheduled", toolCallId: "c3", toolName: "Read" }));
    const out = t.translate(
      ev("tool.updated", {
        kind: "result",
        toolCallId: "c3",
        result: { success: true, content: "file body" },
      }),
    );
    expect(out).toHaveLength(1);
    const u = out[0] as Extract<InternalEvent, { kind: "ToolCallUpdate" }>;
    expect(u.status).toBe("completed");
    expect(u.content?.[0]).toMatchObject({
      type: "content",
      content: { type: "text", text: "file body" },
    });
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

  it("skips content for Bash result (terminal path handles it)", () => {
    const t = new EventTranslator();
    t.translate(ev("tool.updated", { kind: "scheduled", toolCallId: "c4", toolName: "Bash" }));
    const out = t.translate(
      ev("tool.updated", {
        kind: "result",
        toolCallId: "c4",
        result: { success: true, content: "stdout", perf: { exitCode: 0 } },
      }),
    );
    const u = out[0] as Extract<InternalEvent, { kind: "ToolCallUpdate" }>;
    expect(u.status).toBe("completed");
    expect(u.content).toBeUndefined();
    expect(u.rawResult).toEqual({ success: true, content: "stdout", perf: { exitCode: 0 } });
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

  it("emits UsageDelta on session.updated with inputTokens", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("session.updated", {
        usage: { inputTokens: 1234 },
        contextWindow: 200000,
      }),
    );
    expect(out).toEqual([{ kind: "UsageDelta", used: 1234, size: 200000 }]);
  });

  it("translates state.updated patch → ConfigChanged (mode/model/thought)", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("state.updated", {
        patch: {
          mode: { current: "plan" },
          model: { current: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.2" } },
          thoughtLevel: { current: "max" },
        },
        reason: "mode_changed",
      }),
    );
    expect(out).toEqual([
      {
        kind: "ConfigChanged",
        mode: "plan",
        model: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.2" },
        thought: "max",
      },
    ]);
  });

  it("omits fields missing from the state.updated patch", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("state.updated", {
        patch: { model: { current: { providerId: "anthropic", modelId: "GLM-5.2" } } },
        reason: "model_changed",
      }),
    );
    expect(out).toEqual([
      { kind: "ConfigChanged", model: { providerId: "anthropic", modelId: "GLM-5.2" } },
    ]);
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

  it("captures turn.completed usage payload verbatim (and still emits UsageDelta)", () => {
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
    expect(t.turnUsage).toEqual(usage);
    expect(out).toEqual([
      { kind: "UsageDelta", used: 140, size: 0 },
      { kind: "TurnInfo", resultType: "success" },
    ]);
  });

  it("leaves turnUsage null when turn.completed carries no usage", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.completed", { resultType: "cancelled", tokenCount: 7 }));
    expect(t.turnUsage).toBeNull();
  });

  it("does not set turnUsage on turn.failed", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.failed", { error: { code: "1308" }, usage: { totalTokens: 9 } }));
    expect(t.turnUsage).toBeNull();
  });
});

describe("EventTranslator turn.completed resultType + cacheStats", () => {
  const cacheStats = {
    totalMessages: 45,
    cachedMessages: 42,
    lastCacheHit: true,
    cacheReadTokens: 12300,
  };

  it("captures cacheStats verbatim and carries it on the TurnInfo event", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("turn.completed", { resultType: "success", tokenCount: 140, cacheStats }),
    );
    expect(t.turnCacheStats).toEqual(cacheStats);
    const info = out.find((e) => e.kind === "TurnInfo") as Extract<
      InternalEvent,
      { kind: "TurnInfo" }
    >;
    expect(info.resultType).toBe("success");
    expect(info.cacheStats).toEqual(cacheStats);
  });

  it("leaves cacheStats absent (null field) when turn.completed carries none", () => {
    const t = new EventTranslator();
    const out = t.translate(ev("turn.completed", { resultType: "success", tokenCount: 140 }));
    expect(t.turnCacheStats).toBeNull();
    const info = out.find((e) => e.kind === "TurnInfo") as Extract<
      InternalEvent,
      { kind: "TurnInfo" }
    >;
    expect(info.cacheStats).toBeUndefined();
  });

  it("accepts cacheStats without the optional cacheReadTokens", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("turn.completed", {
        resultType: "success",
        cacheStats: { totalMessages: 10, cachedMessages: 4, lastCacheHit: false },
      }),
    );
    expect(t.turnCacheStats).toEqual({
      totalMessages: 10,
      cachedMessages: 4,
      lastCacheHit: false,
    });
    expect(t.turnCacheStats).not.toHaveProperty("cacheReadTokens");
    expect(out).toHaveLength(2);
  });

  it("carries a non-success resultType verbatim on the TurnInfo event", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("turn.completed", { resultType: "error_max_budget", tokenCount: 140, cacheStats }),
    );
    const info = out.find((e) => e.kind === "TurnInfo") as Extract<
      InternalEvent,
      { kind: "TurnInfo" }
    >;
    expect(info.resultType).toBe("error_max_budget");
    // Non-success still carries the cache stats — the line renderer decides.
    expect(info.cacheStats).toEqual(cacheStats);
  });

  it("ignores a malformed cacheStats block (never breaks the turn end)", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("turn.completed", {
        resultType: "success",
        cacheStats: { totalMessages: "many", cachedMessages: 4 },
      }),
    );
    expect(t.turnCacheStats).toBeNull();
    const info = out.find((e) => e.kind === "TurnInfo") as Extract<
      InternalEvent,
      { kind: "TurnInfo" }
    >;
    expect(info.cacheStats).toBeUndefined();
    // The UsageDelta still emitted.
    expect(out[0]?.kind).toBe("UsageDelta");
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

  it("resumes normal handling after the next user-initiated turn.started", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.started", { inputSource: "background_task" }, "turn_bg"));
    t.translate(ev("model.streaming", { kind: "text_delta", delta: "bg" })); // dropped
    // A normal user turn starts → deferral cleared.
    t.translate(ev("turn.started", {}, "turn_user"));
    expect(t.turnStarted).toBe(true);
    const out = t.translate(ev("model.streaming", { kind: "text_delta", delta: "user reply" }));
    expect(out).toEqual([{ kind: "TextDelta", text: "user reply" }]);
  });

  it("ignores background_task tool.updated events inside the deferred turn", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.started", { inputSource: "background_task" }, "turn_bg"));
    const out = t.translate(
      ev("tool.updated", { kind: "scheduled", toolCallId: "c1", toolName: "Read" }),
    );
    expect(out).toEqual([]);
    expect(t.seenToolIds.has("c1")).toBe(false);
  });
});

describe("EventTranslator run_in_background flag threading", () => {
  it("tags ToolCallNew as background when input.run_in_background=true (cached from streaming)", () => {
    const t = new EventTranslator();
    // model.streaming tool_call declares the background launch.
    t.translate(
      ev("model.streaming", {
        kind: "tool_call",
        toolCallId: "c1",
        toolName: "Bash",
        input: { command: "sleep 3", run_in_background: true },
      }),
    );
    const out = t.translate(
      ev("tool.updated", { kind: "scheduled", toolCallId: "c1", inputOmitted: true }),
    );
    const newEv = out[0] as Extract<InternalEvent, { kind: "ToolCallNew" }>;
    expect(newEv.background).toBe(true);
    // Cached for later result lookup.
    expect(t.backgroundCallIds.has("c1")).toBe(true);
  });

  it("tags ToolCallNew as background when scheduled payload carries input directly", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("tool.updated", {
        kind: "scheduled",
        toolCallId: "c2",
        toolName: "Bash",
        input: { command: "echo hi", run_in_background: true },
      }),
    );
    const newEv = out[0] as Extract<InternalEvent, { kind: "ToolCallNew" }>;
    expect(newEv.background).toBe(true);
  });

  it("does NOT tag as background when run_in_background is absent or false", () => {
    const t = new EventTranslator();
    const out = t.translate(
      ev("tool.updated", {
        kind: "scheduled",
        toolCallId: "c3",
        toolName: "Bash",
        input: { command: "ls" },
      }),
    );
    const newEv = out[0] as Extract<InternalEvent, { kind: "ToolCallNew" }>;
    expect(newEv.background).toBeUndefined();
  });

  it("threads background flag through to the result ToolCallUpdate (input omitted on result)", () => {
    const t = new EventTranslator();
    t.translate(
      ev("model.streaming", {
        kind: "tool_call",
        toolCallId: "c4",
        toolName: "Bash",
        input: { command: "sleep 3", run_in_background: true },
      }),
    );
    t.translate(ev("tool.updated", { kind: "scheduled", toolCallId: "c4", inputOmitted: true }));
    const out = t.translate(
      ev("tool.updated", {
        kind: "result",
        toolCallId: "c4",
        result: { success: true, content: "Command running in background with ID: exec_…" },
      }),
    );
    const u = out[0] as Extract<InternalEvent, { kind: "ToolCallUpdate" }>;
    expect(u.background).toBe(true);
    expect(u.status).toBe("completed");
  });

  it("does not tag a foreground Bash result as background", () => {
    const t = new EventTranslator();
    t.translate(ev("tool.updated", { kind: "scheduled", toolCallId: "c5", toolName: "Bash" }));
    const out = t.translate(
      ev("tool.updated", { kind: "result", toolCallId: "c5", result: { content: "done" } }),
    );
    const u = out[0] as Extract<InternalEvent, { kind: "ToolCallUpdate" }>;
    expect(u.background).toBeUndefined();
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

  it("drops a mismatched turn.completed even without a foreign turn.started", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.started", {}, "turn_user"));
    t.translate(ev("turn.completed", { resultType: "success" }, "turn_other"));
    expect(t.turnDone).toBe(false);
    t.translate(ev("turn.completed", { resultType: "success" }, "turn_user"));
    expect(t.turnDone).toBe(true);
  });

  it("drops a mismatched turn.failed too", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.started", {}, "turn_user"));
    t.translate(ev("turn.failed", { error: { code: "x" } }, "turn_goal"));
    expect(t.turnFailed).toBe(false);
    expect(t.turnDone).toBe(false);
  });

  it("keeps legacy behavior when turnId is absent (old backends)", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.started", {}));
    t.translate(ev("turn.completed", { resultType: "success" }));
    expect(t.turnDone).toBe(true);
  });

  it("falls back to a payload-carried turnId (legacy builds)", () => {
    // 0.16.9 carries turnId on the envelope only; the payload spelling was
    // the original (bundle-era) read and must keep working on builds that
    // put it there.
    const t = new EventTranslator();
    t.translate(ev("turn.started", { turnId: "turn_user" }));
    t.translate(ev("turn.completed", { turnId: "turn_other", resultType: "success" }));
    expect(t.turnDone).toBe(false);
    t.translate(ev("turn.completed", { turnId: "turn_user", resultType: "success" }));
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
    expect(out).toEqual([
      { kind: "UsageDelta", used: 0, size: 0 },
      { kind: "TurnInfo", resultType: "success" },
    ]);
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
