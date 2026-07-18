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
): {
  type: string;
  payload: Record<string, unknown>;
} {
  return { type, payload };
}

describe("EventTranslator", () => {
  it("emits a TextDelta on model.streaming text_delta", () => {
    const t = new EventTranslator();
    const out = t.translate(ev("model.streaming", { kind: "text_delta", delta: "hello" }));
    expect(out).toEqual([{ kind: "TextDelta", text: "hello" }]);
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
});

describe("EventTranslator background-task turn deferral", () => {
  it("skips every event of a background_task turn (defers to BackgroundTaskListener)", () => {
    const t = new EventTranslator();
    // A background notification turn starts.
    t.translate(ev("turn.started", { inputSource: "background_task", turnId: "turn_bg" }));
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
    t.translate(ev("turn.started", { inputSource: "background_task", turnId: "turn_bg" }));
    t.translate(ev("model.streaming", { kind: "text_delta", delta: "bg" })); // dropped
    // A normal user turn starts → deferral cleared.
    t.translate(ev("turn.started", { turnId: "turn_user" }));
    expect(t.turnStarted).toBe(true);
    const out = t.translate(ev("model.streaming", { kind: "text_delta", delta: "user reply" }));
    expect(out).toEqual([{ kind: "TextDelta", text: "user reply" }]);
  });

  it("ignores background_task tool.updated events inside the deferred turn", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.started", { inputSource: "background_task", turnId: "turn_bg" }));
    const out = t.translate(
      ev("tool.updated", { kind: "scheduled", toolCallId: "c1", toolName: "Read" }),
    );
    expect(out).toEqual([]);
    expect(t.seenToolIds.has("c1")).toBe(false);
  });
});
