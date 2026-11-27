/**
 * EventTranslator: turn zcode `session/event` pushes into internal event dicts.
 *
 * The output shape matches `ProjectionDiffer.diff()` (the `InternalEvent` union)
 * so either can feed `dispatchEvent`. State held per-translator:
 *   - seenToolIds / toolNames / toolInputs / finalToolIds for tool lifecycle
 *   - turnStarted / turnDone / turnFailed / turnResultType / turnError for turn state
 *     (plus turnUsage / turnCacheStats captured from the same terminal event)
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
import type { InternalEvent, TurnCacheStats } from "./types.js";

interface ZcodeEventPayload {
  type?: string;
  payload?: Record<string, unknown>;
  /**
   * Turn attribution from the event ENVELOPE (0.16.9 puts turnId there, not
   * in the payload — see ZcodeEvent). The payload spelling remains as a
   * fallback for builds that carried it inside.
   */
  turnId?: string;
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

/**
 * Numeric token fields of the backend's merged usage block — the only fields
 * SUMMED across a held-prompt chain. Everything else (source,
 * modelRequestCount, web request counts) is per-turn metadata and comes from
 * the LAST turn of the chain.
 */
const USAGE_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
];

/**
 * Fold a finished turn's usage into the chain accumulator. `acc` carries the
 * chain's prior turns (null before the first), `last` the freshly-completed
 * turn (null when the backend sent no usage — the accumulator survives).
 */
function mergeChainUsage(
  acc: Record<string, unknown> | null,
  last: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!last) return acc;
  if (!acc) return { ...last };
  const merged: Record<string, unknown> = { ...acc };
  for (const [k, v] of Object.entries(last)) {
    if (USAGE_TOKEN_FIELDS.includes(k)) {
      const prev = typeof acc[k] === "number" ? (acc[k] as number) : 0;
      merged[k] = prev + (typeof v === "number" ? v : 0);
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

export class EventTranslator {
  turnStarted = false;
  turnDone = false;
  turnFailed = false;
  turnResultType: string | null = null;
  turnError: Record<string, unknown> | null = null;
  /**
   * Usage object from this turn's `turn.completed` payload, verbatim from the
   * backend. The backend merges every model call's usage into one billing-
   * grade object ({source, modelRequestCount, inputTokens, outputTokens,
   * totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
   * webFetchRequests, webSearchRequests}); it is omitted when no model call
   * reported usage. Per-turn scope, not session-cumulative. Consumed by the
   * prompt loop to fill the ACP `PromptResponse.usage` field.
   */
  turnUsage: Record<string, unknown> | null = null;
  /**
   * cacheStats from this turn's `turn.completed` payload (prompt-cache hit
   * counts; `cacheReadTokens` optional). Null when the backend sent none —
   * pre-cacheStats builds omit the field. Consumed by the dispatcher to render
   * the turn-end status line alongside the TurnInfo event.
   */
  turnCacheStats: TurnCacheStats | null = null;
  /**
   * The protocol layer's authoritative terminal broadcast for a session/send
   * turn: `state.updated {reason:"prompt_completed"}` from
   * runPromptTurnInBackground's finally (server-operations.ts:2469), and
   * `"prompt_failed"` when the turn threw (:2445). Unlike `turn.completed` it
   * is emitted by the protocol layer, so it survives a deaf event stream — the
   * turn loop consults these flags in its stall branch to end a
   * lost-terminal turn in seconds instead of waiting out STALE_FREEZE_MS
   * (10 min).
   *
   * Deliberately NOT a primary terminal: the notification carries no turnId,
   * and a prompt accepted during the previous turn's post-clear snapshot build
   * (`afterStateMutation` awaits real I/O before emitting) could deliver a
   * stale one to the next turn's translator. Only set after OUR
   * `turn.started`, and only acted on after 15s of stream silence.
   */
  sawPromptCompleted = false;
  sawPromptFailed = false;
  /**
   * True while inside a background-task notification turn
   * (`turn.started {inputSource:"background_task"}`). Set on its turn.started,
   * cleared on the next user-initiated turn.started. While true, `translate`
   * drops all events — that turn is owned by BackgroundTaskListener.
   */
  private skippingBackgroundTurn = false;
  /**
   * Armed by {@link beginChainedTurn} (held prompt turn): the NEXT
   * `turn.started` — normally a follow-up with `inputSource:"background_task"`
   * — is adopted as THIS translator's own turn instead of being deferred to
   * the session-scoped BackgroundTaskListener. Disarms on the first adopted
   * turn; a later background turn is skipped again unless the loop re-arms.
   */
  private adoptNextTurn = false;
  /**
   * Usage accumulated over the chain's ALREADY-COMPLETED backend turns (held
   * prompt). Each `turn.completed` merges it into `turnUsage`, so the final
   * PromptResponse.usage sums the whole chain; string extras (source,
   * modelRequestCount, …) come from the LAST turn.
   */
  private chainUsage: Record<string, unknown> | null = null;
  /**
   * LLM-only turn clock (published as `llmMs`): wall time from OUR
   * turn.started event arrival to turn.completed arrival, MINUS the union of
   * tool-execution windows (first `tool.updated` sight → terminal). Clients
   * divide the turn's outputTokens by it for a generation rate that tool
   * calls do not dilute. Measured per chain turn; the turn.completed write
   * adds it ON TOP of turnUsage.llmMs, which beginChainedTurn's
   * mergeChainUsage fold carries across the chain (llmMs is deliberately NOT
   * in USAGE_TOKEN_FIELDS — the backend usage payload never carries it, and
   * listing a chain-summed value as a summing field would double-count).
   */
  private turnLlmStartedAt: number | null = null;
  private toolWindows = new Map<string, { start: number; end: number | null }>();

  /** Open the tool-execution window for a call on its first tool.updated. */
  private openToolWindow(callId: string): void {
    if (!callId || this.turnLlmStartedAt == null || this.toolWindows.has(callId)) return;
    this.toolWindows.set(callId, { start: Date.now(), end: null });
  }

  /** Close a call's window (its terminal tool.updated); no-op when unopened. */
  private closeToolWindow(callId: string): void {
    const w = this.toolWindows.get(callId);
    if (w && w.end == null) w.end = Date.now();
  }

  /**
   * Stop the clock at turn.completed: clamp every open window to now (a
   * background launch card may outlive the turn), merge the windows into
   * their wall-clock union (parallel/concurrent tools share real time and
   * must not double-subtract), and return wall − union. Null when this
   * translator never saw its own turn.started — nothing to publish.
   */
  private finishLlmClock(): number | null {
    if (this.turnLlmStartedAt == null) return null;
    const end = Date.now();
    for (const w of this.toolWindows.values()) {
      if (w.end == null || w.end > end) w.end = end;
    }
    const spans = [...this.toolWindows.values()]
      .map((w) => [w.start, w.end as number] as const)
      .sort((a, b) => a[0] - b[0]);
    let busy = 0;
    let curStart = Number.NaN;
    let curEnd = Number.NaN;
    for (const [s, e] of spans) {
      if (Number.isNaN(curStart) || s > curEnd) {
        if (!Number.isNaN(curStart)) busy += curEnd - curStart;
        curStart = s;
        curEnd = e;
      } else if (e > curEnd) {
        curEnd = e;
      }
    }
    if (!Number.isNaN(curStart)) busy += curEnd - curStart;
    return Math.max(0, end - this.turnLlmStartedAt - busy);
  }

  /** Stop the clock without publishing (turn.failed / between chain turns). */
  private dropLlmClock(): void {
    this.turnLlmStartedAt = null;
    this.toolWindows.clear();
  }
  /**
   * turnId of the user turn this translator owns (from its `turn.started`).
   * Backend-internal turns (`session/goal` set, `session/compact`) emit their
   * own turn.started/turn.completed on the SAME session mid-turn: without
   * attribution, their turn.completed flipped turnDone and the bridge ended
   * the user's turn while the backend kept generating (the "ghost completed"
   * remote-status bug). turnId-less backends keep the old behavior (both ids
   * must be present for a mismatch to drop an event).
   *
   * Read from the event ENVELOPE (`event.turnId`) — 0.16.9's turn.* payloads
   * are strict and carry no turnId; a payload-only read silently nulled this
   * and the whole attribution below was dead code (fixed 2026-09-21).
   */
  private activeTurnId: string | null = null;
  private skippingForeignTurn = false;
  /**
   * Backend message ids (`assistantMessageId`) whose TEXT reached this
   * translator via the live event stream. Used by the turn loop to dedup the
   * turn-completion fallback replay: a message already streamed live must not
   * be re-emitted by `ProjectionDiffer.diff()`, while messages produced while
   * no listener was attached (e.g. a backend turn resumed after compaction)
   * have no live deltas and must be replayed.
   *
   * TEXT-only by contract. Text and reasoning share one assistant message id
   * (the differ tags both replays with `m.info.id`), and GLM-style backends
   * stream the text live while the CoT reaches us only via the completion
   * snapshot — a shared set would let the streamed text suppress the reasoning
   * replay entirely.
   */
  readonly deliveredMessageIds = new Set<string>();
  /**
   * Same contract as `deliveredMessageIds`, for REASONING content. Kept
   * separate so live-streamed reasoning never suppresses the differ's
   * reasoning replay (and vice versa: streamed text must not).
   */
  readonly deliveredReasoningMessageIds = new Set<string>();

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

  /**
   * Arm chained-turn adoption (held prompt turn): the prompt loop keeps this
   * translator alive across consecutive backend turns while background
   * subagent work is outstanding, and the next `turn.started` is adopted as
   * this translator's own turn. Clears the sticky PER-TURN state and folds
   * the finished turn's usage into the chain accumulator; KEEPS every dedup
   * set/map — the completion-replay dedup must survive across the chain so
   * content streamed by an earlier chain turn is never re-emitted.
   */
  beginChainedTurn(): void {
    this.chainUsage = mergeChainUsage(this.chainUsage, this.turnUsage);
    this.turnStarted = false;
    this.turnDone = false;
    this.turnFailed = false;
    this.turnResultType = null;
    this.turnError = null;
    this.turnUsage = null;
    this.turnCacheStats = null;
    this.sawPromptCompleted = false;
    this.sawPromptFailed = false;
    this.skippingBackgroundTurn = false;
    this.skippingForeignTurn = false;
    this.activeTurnId = null;
    this.dropLlmClock();
    this.adoptNextTurn = true;
    log("  [event] chained-turn adopt armed (held prompt waiting for subagent work)");
  }

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
      //
      // EXCEPT when chained-turn adoption is armed (held prompt): the prompt
      // loop deliberately keeps itself open across the chain and hands the
      // follow-up turn to THIS translator — the adopt below falls through to
      // the normal handling (activeTurnId + turnStarted), arming once.
      const inputSource = payload["inputSource"];
      // Any adoption disarms: one beginChainedTurn arms exactly ONE turn.
      const adopting = this.adoptNextTurn;
      this.adoptNextTurn = false;
      if (inputSource === "background_task") {
        if (!adopting) {
          this.skippingBackgroundTurn = true;
          log("  [event] turn.started (background_task) → deferring to bg listener");
          return results;
        }
        log("  [event] turn.started (background_task) → adopted into held prompt");
      }
      this.skippingBackgroundTurn = false;
      // Envelope-first (0.16.9 shape); a payload-carried turnId stays valid
      // for builds that spelled it that way.
      const turnId = event.turnId ?? (payload["turnId"] as string) ?? null;
      if (!this.turnStarted) {
        this.activeTurnId = turnId;
        this.skippingForeignTurn = false;
      } else if (turnId && this.activeTurnId && turnId !== this.activeTurnId) {
        // A second, different turn started mid-turn: a backend-internal turn
        // (goal set / compact). Its events belong to that turn — drop them
        // until it completes and our own turn's events resume.
        this.skippingForeignTurn = true;
        log(`  [event] turn.started (foreign turn ${turnId.slice(-8)}) → skipping its events`);
        return results;
      }
      this.turnStarted = true;
      this.turnLlmStartedAt = Date.now();
      this.toolWindows.clear();
      log("  [event] turn.started");
    } else if (this.skippingBackgroundTurn) {
      // Inside a deferred background_task turn: drop everything (the bg
      // listener handles it). turn.completed/turn.failed for the bg turn also
      // land here and are intentionally NOT used to set turnDone.
      return results;
    } else if (etype === "turn.completed" || etype === "turn.failed") {
      const evTurnId = event.turnId ?? (payload["turnId"] as string) ?? null;
      if (this.skippingForeignTurn) {
        // A turn ended while a foreign (internal) turn was in flight. When it
        // provably belongs to the foreign turn, drop it and resume normal
        // processing. When it names OUR turn (the user turn can complete
        // before the internal one), fall through — swallowing it here would
        // leave turnDone unset and the turn loop waiting out STALE_FREEZE_MS.
        this.skippingForeignTurn = false;
        if (!(evTurnId && this.activeTurnId && evTurnId === this.activeTurnId)) {
          log(`  [event] ${etype} (foreign turn) → ignored`);
          return results;
        }
      }
      if (evTurnId && this.activeTurnId && evTurnId !== this.activeTurnId) {
        log(`  [event] ${etype} (turnId mismatch) → ignored`);
        return results;
      }
      if (etype === "turn.completed") {
        this.turnDone = true;
        this.turnResultType = (payload["resultType"] as string) ?? "success";
        // Merge with the chain accumulator: for a held-prompt chain the final
        // PromptResponse.usage must SUM the chain's backend turns (numeric
        // token fields); single-turn prompts merge over null = verbatim.
        this.turnUsage = mergeChainUsage(
          this.chainUsage,
          (payload["usage"] as Record<string, unknown>) ?? null,
        );
        this.turnCacheStats = parseCacheStats(payload["cacheStats"]);
        // LLM-only clock for THIS chain turn, added on top of the chain's
        // already-summed llmMs (see the field docs). Only when usage exists:
        // synthesizing a usage object from the clock alone would publish
        // zero-filled ACP counters from turnResult.
        const llmMs = this.finishLlmClock();
        if (llmMs != null && this.turnUsage) {
          const prev =
            typeof this.turnUsage["llmMs"] === "number" ? (this.turnUsage["llmMs"] as number) : 0;
          this.turnUsage = { ...this.turnUsage, llmMs: prev + llmMs };
        }
        this.dropLlmClock();
        results.push(...this.translateTurnDone());
        log(`  [event] turn.completed (resultType=${this.turnResultType})`);
      } else {
        this.turnDone = true;
        this.turnFailed = true;
        this.turnError = (payload["error"] as Record<string, unknown>) ?? {};
        this.turnResultType = (payload["resultType"] as string) ?? "error";
        this.dropLlmClock();
        const err = this.turnError;
        warn(`  [event] turn.failed (code=${err["code"] ?? err["type"] ?? "?"})`);
      }
    } else if (this.skippingForeignTurn) {
      return results;
    } else if (etype === "model.streaming") {
      // A stream whose envelope names ANOTHER turn is not this turn's output:
      // a background notification turn (or subagent stream) that was already
      // in flight when this translator subscribed had its turn.started BEFORE
      // the subscription, so neither skippingBackgroundTurn nor
      // skippingForeignTurn caught it — forwarding it here would duplicate
      // text the session-scoped background listener already owns (#393).
      // Events without any turnId (legacy backends) keep flowing.
      const streamTurnId = event.turnId ?? (payload["turnId"] as string) ?? null;
      if (streamTurnId && this.activeTurnId && streamTurnId !== this.activeTurnId) {
        log(`  [event] model.streaming (foreign turn ${streamTurnId.slice(-8)}) → ignored`);
        return results;
      }
      results.push(...this.translateStreaming(payload));
    } else if (etype === "tool.updated") {
      // The envelope turnId rides along for the clock only (see translateTool).
      results.push(
        ...this.translateTool(payload, event.turnId ?? (payload["turnId"] as string) ?? null),
      );
    } else if (etype === "session.updated") {
      const usage = (payload["usage"] as Record<string, unknown>) ?? {};
      const used = usage["inputTokens"];
      const size = (payload["contextWindow"] as number) ?? 0;
      if (typeof used === "number") {
        results.push({ kind: "UsageDelta", used, size });
      }
      // SessionModeChanged rides the generic session.updated with its RAW
      // payload (the v3 mapper has no dedicated wire type). Discriminator:
      // both `mode` and `planEnabled` present (background-task payloads carry
      // taskId instead). `mode` is the UNDERLYING session mode — the runtime's
      // plan tools flip only `planEnabled`. Both fields are needed to
      // reconstruct the effective mode when that flag changes.
      if (typeof payload["mode"] === "string" && typeof payload["planEnabled"] === "boolean") {
        results.push({
          kind: "ConfigChanged",
          mode: payload["mode"],
          planEnabled: payload["planEnabled"] === true,
        });
      }
    } else if (etype === "state.updated") {
      // Session settings changed (model/mode/thoughtLevel switch, incl.
      // mid-turn). The backend notification carries the authoritative full
      // settings patch — forward the new values so the editor UI follows the
      // switch immediately instead of at the next turn's completion.
      const reason = payload["reason"];
      if (
        (reason === "prompt_completed" || reason === "prompt_failed") &&
        this.turnStarted &&
        !this.turnDone
      ) {
        // Authoritative terminal broadcast for OUR turn (see the field
        // docstrings for why this is not a primary terminal).
        if (reason === "prompt_failed") this.sawPromptFailed = true;
        else this.sawPromptCompleted = true;
        log(`  [event] state.updated (${reason}) → terminal broadcast recorded`);
      }
      results.push(...this.translateStateUpdated(payload));
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
      Record<string, unknown> | undefined;
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
    // when replaying missing content at turn completion. Per-content-kind:
    // text and reasoning share one assistantMessageId, and the completion
    // replay must stay able to deliver the kind that did NOT stream live
    // (GLM: text streams, reasoning arrives only via the snapshot).
    const msgId = payload["assistantMessageId"];
    if (typeof msgId === "string" && msgId) {
      if (kind === "reasoning_delta") this.deliveredReasoningMessageIds.add(msgId);
      else if (kind === "text_delta") this.deliveredMessageIds.add(msgId);
    }

    // Carry the owning backend message id onto the emitted delta so the ACP
    // chunk keeps one messageId per assistant message instead of one per turn.
    const ownerId = typeof msgId === "string" && msgId ? msgId : undefined;

    if (kind === "text_delta") {
      if (delta)
        results.push({
          kind: "TextDelta",
          text: delta,
          ...(ownerId ? { messageId: ownerId } : {}),
        });
    } else if (kind === "reasoning_delta") {
      if (delta)
        results.push({
          kind: "ReasoningDelta",
          text: delta,
          ...(ownerId ? { messageId: ownerId } : {}),
        });
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

  private translateTool(
    payload: Record<string, unknown>,
    toolTurnId: string | null,
  ): InternalEvent[] {
    const results: InternalEvent[] = [];
    const tkind = (payload["kind"] as string) ?? "";
    const callId = (payload["toolCallId"] as string) ?? "";
    const toolName = (payload["toolName"] as string) ?? "";

    // First sight of this call in OUR turn: its execution window opens here.
    // Tool events whose envelope names ANOTHER turn are not this turn's work:
    // 4.0 mirrors sibling background subagents' tool calls onto the parent
    // stream under the LAUNCHING turn's id, and a background notification
    // turn already in flight at subscribe time leaks in the same way (#393
    // filters model.streaming for it). They still render as tool cards; only
    // the clock ignores them — their windows would otherwise be clamped to
    // our turn end and eat the LLM time of a multi-subagent chain.
    const foreignTurn =
      toolTurnId !== null && this.activeTurnId !== null && toolTurnId !== this.activeTurnId;
    if (callId && !foreignTurn && !this.seenToolIds.has(callId)) {
      this.openToolWindow(callId);
    }

    if (tkind === "scheduled") {
      const newEv = this.createToolCall(callId, toolName, payload["input"], "pending");
      if (newEv) results.push(newEv);
    } else if (tkind === "started") {
      if (callId) {
        const newEv = this.createToolCall(callId, toolName, payload["input"], "in_progress");
        if (newEv) {
          results.push(newEv);
        } else {
          results.push({ kind: "ToolCallUpdate", callId, status: "in_progress" });
        }
      }
    } else if (tkind === "progress") {
      if (callId) {
        const newEv = this.createToolCall(callId, toolName, payload["input"], "in_progress");
        if (newEv) results.push(newEv);
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
        const newEv = this.createToolCall(callId, toolName, payload["input"], "in_progress");
        if (newEv) results.push(newEv);
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
        this.closeToolWindow(callId);
      }
    } else if (tkind === "error") {
      if (callId) {
        const newEv = this.createToolCall(callId, toolName, payload["input"], "in_progress");
        if (newEv) results.push(newEv);
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
        this.closeToolWindow(callId);
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
          this.closeToolWindow(bid);
        }
      }
    }
    return results;
  }

  /** Create the first ACP tool event, even if the backend omitted `scheduled`. */
  private createToolCall(
    callId: string,
    eventToolName: string,
    eventInput: unknown,
    status: "pending" | "in_progress",
  ): Extract<InternalEvent, { kind: "ToolCallNew" }> | null {
    if (!callId || this.seenToolIds.has(callId)) return null;
    this.seenToolIds.add(callId);

    const toolName = eventToolName || this.toolNames.get(callId) || "unknown";
    this.toolNames.set(callId, toolName);
    const input = eventInput === undefined ? this.toolInputs.get(callId) : eventInput;
    const summary = summarizeToolInput(toolName, input);
    const isBackground = isBackgroundInput(input);
    if (isBackground) this.backgroundCallIds.add(callId);
    const newEv: Extract<InternalEvent, { kind: "ToolCallNew" }> = {
      kind: "ToolCallNew",
      callId,
      tool: toolName,
      acpKind: TOOL_KIND_MAP[toolName] ?? "execute",
      status,
      title: summary ? `${toolName}: ${summary}` : toolName,
      ...(isBackground ? { background: true } : {}),
    };
    if (input !== undefined) newEv.input = input;
    const locations = extractLocations(toolName, input);
    if (locations.length > 0) newEv.locations = locations;
    return newEv;
  }

  private translateTurnDone(): InternalEvent[] {
    // Terminal info line ONLY — no UsageDelta. turn.completed's usage block
    // is the turn's CUMULATIVE consumption (billing-grade, summed across
    // every model request of the turn); reporting it as the context meter
    // made a multi-request turn read >100% of the window (#228). The
    // authoritative occupancy (projection.contextUsed) reaches clients via
    // the turn-completion reconciliation diff and the mid-turn watermark
    // forwarder, both of which read session/read's projection; the per-turn
    // consumption itself still surfaces through PromptResponse.usage
    // (turnResult ← this.turnUsage) — a different, per-turn field.
    const info: InternalEvent = { kind: "TurnInfo", resultType: this.turnResultType ?? "success" };
    if (this.turnCacheStats) info.cacheStats = this.turnCacheStats;
    return [info];
  }
}

/**
 * Parse `turn.completed` cacheStats. Returns undefined on absent/malformed
 * input — an unreadable stats block must never break the turn-end flow.
 */
function parseCacheStats(raw: unknown): TurnCacheStats | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const totalMessages = o["totalMessages"];
  const cachedMessages = o["cachedMessages"];
  if (typeof totalMessages !== "number" || typeof cachedMessages !== "number") return null;
  const stats: TurnCacheStats = {
    totalMessages,
    cachedMessages,
    lastCacheHit: o["lastCacheHit"] === true,
  };
  const read = o["cacheReadTokens"];
  if (typeof read === "number") stats.cacheReadTokens = read;
  return stats;
}
