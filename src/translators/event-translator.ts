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

/**
 * Whether a tool input dict declared `run_in_background: true`. Used to tag
 * ToolCallNew/Update events so the dispatcher and BackgroundTaskListener can
 * keep the launch card in_progress and own its lifecycle via out-of-band
 * `session.updated` events (rather than closing it the instant the launch
 * acknowledgement returns).
 */
function isBackgroundInput(inp: unknown): boolean {
  if (!inp || typeof inp !== "object" || Array.isArray(inp)) return false;
  return (inp as Record<string, unknown>)["run_in_background"] === true;
}

export class EventTranslator {
  turnStarted = false;
  turnDone = false;
  turnFailed = false;
  turnResultType: string | null = null;
  turnError: Record<string, unknown> | null = null;
  /**
   * True while inside a background-task notification turn
   * (`turn.started {inputSource:"background_task"}`). Set on its turn.started,
   * cleared on the next user-initiated turn.started. While true, `translate`
   * drops all events — that turn is owned by BackgroundTaskListener.
   */
  private skippingBackgroundTurn = false;
  /**
   * Backend message ids (`assistantMessageId`) whose content reached this
   * translator via the live event stream. Used by the turn loop to dedup the
   * turn-completion fallback replay: a message already streamed live must not
   * be re-emitted by `ProjectionDiffer.diff()`, while messages produced while
   * no listener was attached (e.g. a backend turn resumed after compaction)
   * have no live deltas and must be replayed.
   */
  readonly deliveredMessageIds = new Set<string>();

  /** Tool call ids we've already emitted a ToolCallNew for. */
  readonly seenToolIds = new Set<string>();
  /** call_id → tool_name (result/error events omit toolName). */
  readonly toolNames = new Map<string, string>();
  /** call_id → input dict cached from model.streaming tool_call. */
  readonly toolInputs = new Map<string, unknown>();
  /** Tool call ids that reached a terminal state (result/error). */
  readonly finalToolIds = new Set<string>();
  /**
   * call_ids launched with `run_in_background: true`. Populated when the
   * scheduled event resolves the input (streaming cache or payload), so the
   * later `result` event — whose input is omitted — can still mark its
   * ToolCallUpdate as background. Read by `translateTool` to thread the flag
   * through to dispatch (which skips terminal_exit for background Bash).
   */
  readonly backgroundCallIds = new Set<string>();

  /** Translate one zcode event into 0..n internal events. */
  translate(event: ZcodeEventPayload): InternalEvent[] {
    const etype = event.type ?? "";
    const payload = event.payload ?? {};
    const results: InternalEvent[] = [];

    if (etype === "turn.started") {
      // Background-task completion triggers an automatic backend turn
      // (`inputSource:"background_task"`) whose text_delta is the task result.
      // That turn is owned by the BackgroundTaskListener (session-scoped), NOT
      // this per-prompt translator — if we consumed it we'd (a) double-forward
      // the result and (b) mis-set turnDone and exit the user's real turn loop.
      // So we skip every event of a background_task turn until the next
      // user-initiated turn.started clears the flag.
      const inputSource = payload["inputSource"];
      if (inputSource === "background_task") {
        this.skippingBackgroundTurn = true;
        log("  [event] turn.started (background_task) → deferring to bg listener");
        return results;
      }
      this.skippingBackgroundTurn = false;
      this.turnStarted = true;
      log("  [event] turn.started");
    } else if (this.skippingBackgroundTurn) {
      // Inside a deferred background_task turn: drop everything (the bg
      // listener handles it). turn.completed/turn.failed for the bg turn also
      // land here and are intentionally NOT used to set turnDone.
      return results;
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
    } else if (etype === "state.updated") {
      // Session settings changed (model/mode/thoughtLevel switch, incl.
      // mid-turn). The backend notification carries the authoritative full
      // settings patch — forward the new values so the editor UI follows the
      // switch immediately instead of at the next turn's completion.
      results.push(...this.translateStateUpdated(payload));
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

  /**
   * `state.updated` → one ConfigChanged event carrying the new settings values.
   * Payload shape (wrapped from the backend notification's params):
   *   { patch: { mode: {current}, model: {current:{providerId,modelId}},
   *              thoughtLevel: {current} }, reason, revision, sessionId }
   * Fields missing from the patch are omitted — the dispatcher only emits
   * updates for what actually changed.
   */
  private translateStateUpdated(payload: Record<string, unknown>): InternalEvent[] {
    const patch = (payload["patch"] as Record<string, unknown> | undefined) ?? {};
    const ev: InternalEvent = { kind: "ConfigChanged" };
    const mode = (patch["mode"] as Record<string, unknown> | undefined)?.current;
    if (typeof mode === "string") ev.mode = mode;
    const model = (patch["model"] as Record<string, unknown> | undefined)?.current as
      | Record<string, unknown>
      | undefined;
    if (model && typeof model["providerId"] === "string" && typeof model["modelId"] === "string") {
      ev.model = { providerId: model["providerId"], modelId: model["modelId"] };
    }
    const thought = (patch["thoughtLevel"] as Record<string, unknown> | undefined)?.current;
    if (typeof thought === "string") ev.thought = thought;
    return [ev];
  }

  private translateStreaming(payload: Record<string, unknown>): InternalEvent[] {
    const results: InternalEvent[] = [];
    const kind = (payload["kind"] as string) ?? "";
    const delta = (payload["delta"] as string) ?? "";
    // Record the owning assistant message so the turn loop can distinguish
    // "already streamed live" from "produced while no listener was attached"
    // when replaying missing content at turn completion.
    const msgId = payload["assistantMessageId"];
    if (typeof msgId === "string" && msgId) this.deliveredMessageIds.add(msgId);

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
        // Track background launches so the later `result` event (input omitted)
        // can still tag its ToolCallUpdate. The BackgroundTaskListener also
        // keys off this to know which callId owns the card.
        const isBackground = isBackgroundInput(inp);
        if (isBackground) this.backgroundCallIds.add(callId);
        const newEv: InternalEvent = {
          kind: "ToolCallNew",
          callId,
          tool: toolName,
          acpKind,
          status: "pending",
          title,
          ...(isBackground ? { background: true } : {}),
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
          ...(this.backgroundCallIds.has(callId) ? { background: true } : {}),
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
          ...(this.backgroundCallIds.has(callId) ? { background: true } : {}),
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
