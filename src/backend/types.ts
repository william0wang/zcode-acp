/**
 * ZCode app-server protocol type definitions.
 *
 * ZCode speaks a line-delimited JSON protocol over stdio. It is JSON-RPC-like
 * but deliberately omits the `jsonrpc` field. Messages are classified by the
 * presence of `id` and `method`:
 *   - id + no method        → response to a request we sent
 *   - id + method           → either our response (id registered) or a server→client request
 *   - method + no id        → notification (e.g. `session/event`)
 *
 * Only the fields we actually consume are typed; the rest pass through as
 * `unknown`/`Record<string, unknown>` to stay resilient to ZCode schema drift.
 */

// ---------- envelope ----------

export interface ZcodeRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface ZcodeNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface ZcodeResponse {
  id: number;
  result?: unknown;
  error?: { message: string; code?: number | string; detail?: unknown };
}

/** Any inbound message from the ZCode subprocess. */
export type ZcodeInbound = Partial<ZcodeRequest> &
  Partial<ZcodeResponse> &
  Partial<ZcodeNotification>;

// ---------- session lifecycle ----------

export interface ZcodeSessionInfo {
  sessionId: string;
  title?: string;
  traceId?: string;
}

export interface ZcodeCreateResult {
  session: ZcodeSessionInfo;
  /**
   * Session settings snapshot. `model.available` is the FULL registry listing
   * (with per-model reasoning metadata) — only create/resume return it;
   * `session/read` answers with the current model alone. See
   * `server.modelAvailability`.
   */
  settings?: {
    model?: {
      current?: { providerId?: string; modelId?: string };
      available?: Array<{
        ref?: { providerId?: string; modelId?: string };
        reasoning?: { defaultLevel?: string; levels?: Array<{ value?: string }> };
      }>;
    };
    thoughtLevel?: { current?: string; defaultLevel?: string };
  };
}

export interface ZcodeSessionListItem {
  sessionId: string;
  workspace?: { workspacePath?: string };
  title?: string;
  updatedAt?: number;
}

export interface ZcodeListResult {
  sessions: ZcodeSessionListItem[];
}

// ---------- event stream ----------

export type ZcodeEventType =
  | "turn.started"
  | "model.streaming"
  | "tool.updated"
  | "turn.completed"
  | "turn.failed"
  | "session.updated"
  // Backend pushes this notification (method: `state.updated`) whenever session
  // settings change (model/mode/thoughtLevel switch, incl. mid-turn). The bridge
  // wraps it as a ZcodeEvent so it flows through the same listener pipeline.
  | "state.updated"
  // app-server 0.15.2+: steer lifecycle + terminal turn. Not yet translated by
  // the bridge; tracked in docs/BACKLOG.md. Listed here so unknown-type guards
  // stay accurate.
  | "turn.steerQueued"
  | "turn.steerDrained"
  | "turn.terminal"
  // app-server 0.16.5 (verified live + schema-checked against the desktop
  // 3.12.3 bundle, 2026-09-18): authoritative conversation-title pushes.
  // Consumed by SessionTitleListener; see docs/PROTOCOL.md.
  | "session.titleUpdated";

export interface ZcodeEvent {
  sessionId: string;
  seq: number;
  type: ZcodeEventType;
  payload: Record<string, unknown>;
  /**
   * Turn attribution — on the event ENVELOPE, not the payload (source:
   * `zcodeEventEnvelopeSchema`, zcode-protocol index.ts:1029-1041; the
   * `turn.*` payloads are `.strict()` and carry no turnId). A `session/event`
   * frame's params ARE the envelope, so the field is present at runtime on
   * every push even though the client only types the fields it consumed.
   */
  turnId?: string;
}

export interface ZcodeSubscribeResult {
  eventSeq: number;
  /**
   * Missed-window replay carried in the subscribe response itself (source:
   * subscribeSession returns every event with seq > afterSeq). Consumed by
   * resubscribe; absent when the request omits afterSeq (fresh subscribe).
   */
  events?: ZcodeEvent[];
  snapshot?: ZcodeSnapshot;
}

export interface ZcodeSnapshot {
  projection?: ZcodeProjection;
  messages?: ZcodeMessage[];
  todos?: unknown[];
}

export interface ZcodeProjection {
  status?: string;
  contextUsed?: number;
  contextWindow?: number;
  totalTokenCount?: number;
  /** Turns completed in this session (observed in app-server projections). */
  turnCount?: number;
  /** Id of the turn the projection considers current, if any. */
  currentTurnId?: string;
}

// ---------- messages / history ----------

export interface ZcodeMessage {
  info: {
    id?: string;
    role: "user" | "assistant" | "system";
    /**
     * Harness semantics tag (newer backends). Identifies synthetic messages:
     * compact_summary (compaction product), system_reminder / todo_reminder /
     * background_notification (harness plumbing), timeline_event. Hidden
     * plumbing carries transcriptVisibility: "hidden".
     */
    semantics?: {
      kind?: string;
      source?: string;
      transcriptVisibility?: string;
      uiVisibility?: string;
    };
    /** Compaction display form carried by compact_summary messages. */
    summary?: { title?: string; body?: string };
  };
  parts: ZcodeMessagePart[];
}

export type ZcodeMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text?: string; content?: string }
  | {
      type: "tool";
      callID?: string;
      callId?: string;
      tool?: string;
      state?: Record<string, unknown>;
    }
  | { type: "patch"; hash?: string; files?: string[] }
  | { type: string; [key: string]: unknown };

export interface ZcodeMessagesResult {
  messages: ZcodeMessage[];
}

// ---------- read ----------

export interface ZcodeReadResult {
  projection?: ZcodeProjection;
  settings?: Record<string, unknown>;
  todos?: unknown[];
  todoGroups?: Array<{ entries?: unknown[]; todos?: unknown[] }>;
}

// ---------- interaction (server→client) ----------

export interface ZcodeInteractionPermissionParams {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName?: string;
  reason?: string;
  riskLevel?: string;
  input?: unknown;
  options?: Array<{ optionId: string; kind: string; name: string; response?: unknown }>;
}

export interface ZcodeInteractionUserInputParams {
  requestId: string;
  sessionId: string;
  toolCallId?: string;
  toolName?: string;
  prompt?: string;
  questions?: Array<{
    header?: string;
    question: string;
    multiSelect?: boolean;
    options?: Array<{ label?: string; value?: string; description?: string }>;
  }>;
  input?: { questions?: ZcodeInteractionUserInputParams["questions"] };
  schema?: { interaction?: string; toolName?: string };
}

/** The response we send back to a ZCode server→client request. */
export type ZcodeInteractionResponse =
  | { decision: "allow" | "deny" | "escalate" | "modify"; reason?: string; modifiedInput?: unknown }
  | { action: "accept" | "decline" | "cancel"; content?: unknown; reason?: string };
