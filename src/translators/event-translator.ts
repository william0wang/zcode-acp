/**
 * EventTranslator: turn zcode `session/event` pushes into internal event dicts.
 *
 * The output shape matches `ProjectionDiffer.diff()` (the `InternalEvent` union)
 * so either can feed `dispatchEvent`. State held per-translator:
 *   - seenToolIds / toolNames / toolInputs / finalToolIds for tool lifecycle
 *   - turnStarted / turnDone / turnFailed / turnResultType / turnError for turn state
 *
 * A critical quirk: zcode streams tool input via `model.streaming tool_call`
 * BEFORE the `tool.updated scheduled` event, whose `input` is then omitted
 * (`inputOmitted:true`). So we cache input from `tool_call` and fall back to
 * it when `scheduled` arrives without input.
 */

import { log, warn } from "../utils.js";
import {
  buildResultContent,
  extractLocations,
  renderToolOutput,
  summarizeToolInput,
  TOOL_KIND_MAP,
} from "./tool-helpers.js";
import type { InternalEvent } from "./types.js";

interface ZcodeEventPayload {
  type?: string;
  payload?: Record<string, unknown>;
}

export class EventTranslator {
  turnStarted = false;
  turnDone = false;
  turnFailed = false;
  turnResultType: string | null = null;
  turnError: Record<string, unknown> | null = null;

  /** Tool call ids we've already emitted a ToolCallNew for. */
  readonly seenToolIds = new Set<string>();
  /** call_id → tool_name (result/error events omit toolName). */
  readonly toolNames = new Map<string, string>();
  /** call_id → input dict cached from model.streaming tool_call. */
  readonly toolInputs = new Map<string, unknown>();
  /** Tool call ids that reached a terminal state (result/error). */
  readonly finalToolIds = new Set<string>();

  /** Translate one zcode event into 0..n internal events. */
  translate(event: ZcodeEventPayload): InternalEvent[] {
    const etype = event.type ?? "";
    const payload = event.payload ?? {};
    const results: InternalEvent[] = [];

    if (etype === "turn.started") {
      this.turnStarted = true;
      log("  [event] turn.started");
    } else if (etype === "model.streaming") {
      results.push(...this.translateStreaming(payload));
    } else if (etype === "tool.updated") {
      results.push(...this.translateTool(payload));
    } else if (etype === "turn.completed") {
      this.turnDone = true;
      this.turnResultType = (payload["resultType"] as string) ?? "success";
      results.push(...this.translateTurnDone(payload));
      log(`  [event] turn.completed (resultType=${this.turnResultType})`);
    } else if (etype === "session.updated") {
      const usage = (payload["usage"] as Record<string, unknown>) ?? {};
      const used = usage["inputTokens"];
      const size = (payload["contextWindow"] as number) ?? 0;
      if (typeof used === "number") {
        results.push({ kind: "UsageDelta", used, size });
      }
    } else if (etype === "turn.failed") {
      this.turnDone = true;
      this.turnFailed = true;
      this.turnError = (payload["error"] as Record<string, unknown>) ?? {};
      this.turnResultType = (payload["resultType"] as string) ?? "error";
      const err = this.turnError;
      warn(`  [event] turn.failed (code=${err["code"] ?? err["type"] ?? "?"})`);
    }
    return results;
  }

  private translateStreaming(payload: Record<string, unknown>): InternalEvent[] {
    const results: InternalEvent[] = [];
    const kind = (payload["kind"] as string) ?? "";
    const delta = (payload["delta"] as string) ?? "";

    if (kind === "text_delta") {
      if (delta) results.push({ kind: "TextDelta", text: delta });
    } else if (kind === "reasoning_delta") {
      if (delta) results.push({ kind: "ReasoningDelta", text: delta });
    } else if (kind === "tool_call") {
      // Cache input + toolName for the later scheduled event.
      const callId = (payload["toolCallId"] as string) ?? "";
      if (callId) {
        if (payload["toolName"]) this.toolNames.set(callId, payload["toolName"] as string);
        if (payload["input"] !== undefined) this.toolInputs.set(callId, payload["input"]);
      }
    }
    return results;
  }

  private translateTool(payload: Record<string, unknown>): InternalEvent[] {
    const results: InternalEvent[] = [];
    const tkind = (payload["kind"] as string) ?? "";
    const callId = (payload["toolCallId"] as string) ?? "";
    let toolName = (payload["toolName"] as string) ?? "";

    if (tkind === "scheduled") {
      if (callId && !this.seenToolIds.has(callId)) {
        this.seenToolIds.add(callId);
        if (toolName) {
          this.toolNames.set(callId, toolName);
        } else {
          toolName = this.toolNames.get(callId) ?? "unknown";
        }
        const acpKind = TOOL_KIND_MAP[toolName] ?? "execute";
        // Input: scheduled payload first, fall back to cached tool_call input.
        let inp = payload["input"];
        if (inp === undefined) inp = this.toolInputs.get(callId);
        const summary = summarizeToolInput(toolName, inp);
        const title = summary ? `${toolName}: ${summary}` : toolName;
        const newEv: InternalEvent = {
          kind: "ToolCallNew",
          callId,
          tool: toolName,
          acpKind,
          status: "pending",
          title,
        };
        if (inp !== undefined) (newEv as { input?: unknown }).input = inp;
        const locs = extractLocations(toolName, inp);
        if (locs.length > 0) (newEv as { locations?: typeof locs }).locations = locs;
        results.push(newEv);
      }
    } else if (tkind === "started") {
      if (callId) {
        results.push({ kind: "ToolCallUpdate", callId, status: "in_progress" });
      }
    } else if (tkind === "progress") {
      if (callId) {
        const output = payload["stdoutTail"] ?? payload["stderrTail"] ?? "";
        const tn = (toolName || this.toolNames.get(callId)) ?? "";
        results.push({
          kind: "ToolCallUpdate",
          callId,
          tool: tn,
          status: "in_progress",
          output: renderToolOutput(output),
          rawOutput: output,
        });
      }
    } else if (tkind === "result") {
      if (callId) {
        const resultPayload = payload["result"];
        const tn = (toolName || this.toolNames.get(callId)) ?? "";
        const ev: InternalEvent = {
          kind: "ToolCallUpdate",
          callId,
          tool: tn,
          status: "completed",
          output: renderToolOutput(resultPayload),
          rawResult: resultPayload,
        };
        // Bash content handled by the terminal path in dispatch; skip here.
        if (tn !== "Bash" && tn !== "bash") {
          const content = buildResultContent(tn, resultPayload);
          if (content.length > 0) (ev as { content?: typeof content }).content = content;
        }
        results.push(ev);
        this.finalToolIds.add(callId);
      }
    } else if (tkind === "error") {
      if (callId) {
        const tn = (toolName || this.toolNames.get(callId)) ?? "";
        const errPayload = payload["error"];
        const ev: InternalEvent = {
          kind: "ToolCallUpdate",
          callId,
          tool: tn,
          status: "failed",
          output: renderToolOutput(errPayload),
        };
        const content = buildResultContent(tn, errPayload, true);
        if (content.length > 0) (ev as { content?: typeof content }).content = content;
        results.push(ev);
        this.finalToolIds.add(callId);
      }
    } else if (tkind === "batch") {
      // Multi-tool completion. Only backfill unseen or non-final ids, else a
      // content-less `completed` would overwrite a prior result event.
      const batchIds = (payload["toolCallIds"] as string[]) ?? [];
      const errorCount = (payload["errorCount"] as number) ?? 0;
      const finalStatus = errorCount > 0 ? "failed" : "completed";
      for (const bid of batchIds) {
        if (this.seenToolIds.has(bid) && !this.finalToolIds.has(bid)) {
          results.push({ kind: "ToolCallUpdate", callId: bid, status: finalStatus });
          this.finalToolIds.add(bid);
        }
      }
    }
    return results;
  }

  private translateTurnDone(payload: Record<string, unknown>): InternalEvent[] {
    const usage = (payload["usage"] as Record<string, unknown>) ?? {};
    // Use || (not ??) to match Python's `or` semantics: a falsy totalTokens
    // (0 / undefined) falls back to tokenCount, then to 0. With ?? a 0 would
    // be kept as-is and never fall back, diverging from the Python reference.
    const used = (usage["totalTokens"] as number) || (payload["tokenCount"] as number) || 0;
    const size = (usage["contextWindow"] as number) || 0;
    return [{ kind: "UsageDelta", used, size }];
  }
}
