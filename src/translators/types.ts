/**
 * Internal event-dict shape — the seam between translators and the dispatcher.
 *
 * Both `EventTranslator` (event-stream path) and `ProjectionDiffer` (snapshot
 * path) emit these discriminated unions; `dispatchEvent` consumes them and
 * serialises each into an ACP `session/update` notification.
 */

import type {
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

export interface ToolCallNewEvent {
  kind: "ToolCallNew";
  callId: string;
  tool: string;
  acpKind: ToolKind;
  status: ToolCallStatus;
  title: string;
  input?: unknown;
  output?: string;
  content?: ToolCallContent[];
  diffContent?: ToolCallContent[];
  locations?: ToolCallLocation[];
  /**
   * True when the tool was launched with `run_in_background: true` (currently
   * only Bash). The dispatcher uses this to keep the card in_progress instead
   * of emitting a premature terminal_exit — the BackgroundTaskListener owns
   * the final status via out-of-band `session.updated` events.
   */
  background?: boolean;
}

export interface ToolCallUpdateEvent {
  kind: "ToolCallUpdate";
  callId: string;
  tool?: string;
  status: ToolCallStatus;
  output?: string;
  rawOutput?: unknown;
  rawResult?: unknown;
  content?: ToolCallContent[];
  diffContent?: ToolCallContent[];
  locations?: ToolCallLocation[];
  /**
   * Carries the background flag from the originating ToolCallNew through to
   * `result` updates so the dispatcher can skip terminal_exit for background
   * Bash. Resolved from a per-translator `backgroundCallIds` cache because
   * `tool.updated { kind:"result" }` omits the input.
   */
  background?: boolean;
}

export interface UsageDeltaEvent {
  kind: "UsageDelta";
  used: number;
  size: number;
}

export interface TextDeltaEvent {
  kind: "TextDelta";
  text: string;
  /**
   * Backend message id (assistantMessageId). Set by the projection-differ's
   * turn-completion fallback replay so the turn loop can dedup against
   * content already streamed via events this turn; absent on live stream deltas.
   */
  messageId?: string;
}

export interface ReasoningDeltaEvent {
  kind: "ReasoningDelta";
  text: string;
  /** See TextDeltaEvent.messageId. */
  messageId?: string;
}

export interface PlanUpdateEvent {
  kind: "PlanUpdate";
  entries: PlanEntry[];
}

/** A plan entry being built before dispatch (status/priority are normalised here). */
export function makePlanEntry(content: string, status: string, priority?: string): PlanEntry {
  return {
    content,
    status: normalisePlanStatus(status),
    priority: normalisePlanPriority(priority),
  };
}

function normalisePlanStatus(s: string): PlanEntryStatus {
  if (s === "completed" || s === "in_progress" || s === "pending") {
    return s;
  }
  return "pending";
}

function normalisePlanPriority(p: string | undefined): PlanEntryPriority {
  if (p === "high" || p === "medium" || p === "low") return p;
  return "medium";
}

export interface FilesChangedEvent {
  kind: "FilesChanged";
  files: string[];
}

/**
 * Session settings changed (model/mode/thoughtLevel switch). Carries the new
 * authoritative values from the backend's `state.updated` patch so the
 * dispatcher can push config_option_update / current_mode_update without a
 * `session/read` round-trip (and without waiting for turn completion).
 */
export interface ConfigChangedEvent {
  kind: "ConfigChanged";
  mode?: string;
  model?: { providerId: string; modelId: string };
  thought?: string;
}

export type InternalEvent =
  | ToolCallNewEvent
  | ToolCallUpdateEvent
  | UsageDeltaEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | PlanUpdateEvent
  | FilesChangedEvent
  | ConfigChangedEvent;
