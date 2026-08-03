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
  | "turn.terminal";

export interface ZcodeEvent {
  sessionId: string;
  seq: number;
  type: ZcodeEventType;
  payload: Record<string, unknown>;
}

export interface ZcodeSubscribeResult {
  eventSeq: number;
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
}

// ---------- messages / history ----------

export interface ZcodeMessage {
  info: { id?: string; role: "user" | "assistant" | "system" };
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
