/**
 * `session/edit_user_message` + `session/retry_turn` — the ACP rewind
 * extensions (ADR-0012 in zcode-acp-app): edit-and-resend and regenerate for
 * the latest turn, mapped onto the v4 conversation commands `editUserQuery` /
 * `retryTurn` (spec: zcode-acp-app .zcode/docs/session-rewind-backend-
 * requirements.md).
 *
 * Upstream wire facts these handlers depend on (source-verified against
 * ~/Develop/NoBackup/ZCode @ 3.18.2):
 * - Both commands are CAS + row-targeting: the `v4/command` envelope MUST
 *   carry `baseRevision` AND `baseLogEpoch` (command.ts
 *   COMMANDS_REQUIRING_BASE_REVISION / ROW_TARGETING_COMMANDS; the inbox
 *   rejects a missing pair and answers `proto.staleRevision` /
 *   `proto.staleLogEpoch` / `proto.staleTarget` on drift). The read-only
 *   `v4/conversation/rowsRange` response carries both values (`atRevision` /
 *   `atLogEpoch`) plus the row projection — one read provides the target and
 *   the CAS pair atomically.
 * - Row addressing: a persisted message's `entityId` IS its store messageId
 *   (product-projection.ts `entityId = messageId ?? pendingInputId`;
 *   transcript-hydration.ts `entityId: String(message.info.id)`), i.e. the
 *   same id the bridge replays as `_meta.zcode.mid` / top-level `messageId`.
 * - `editUserQuery` is latest-real-user-query only, `retryTurn` latest
 *   assistant row only (upstream guards `latestQueryEditOnly` /
 *   `latestAssistantRetryOnly`); the rows' `actions.canEdit` / `canRetry`
 *   flags are the same verdict the gateway will enforce, so refusing locally
 *   saves the round trip.
 * - A `blocked` edit (unsafe workspace rewind combination) rides an ACCEPTED
 *   ack as `result.disposition: "blocked"` — checked explicitly below.
 * - The replacement turn is started by the backend, not by a bridge
 *   `session/send`: no turn loop owns it, so its text would be silently
 *   dropped. The handler pre-claims it on the session's BackgroundTaskListener
 *   (`claimRewindTurn`) — the first `turn.started` after the claim is forwarded
 *   like a background notification turn (text deltas + busy window), and the
 *   listener's foreign-turn tracking broadcasts the running transitions.
 */

import { randomUUID } from "node:crypto";

import { RequestError } from "@agentclientprotocol/sdk";

import { ProjectionDiffer } from "../translators/projection-differ.js";
import type { ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";
import { emitSessionTurnState } from "./io.js";
import { fetchMessages } from "./replay.js";
import { ensureRealSession } from "./session.js";

/** v4/command budget — the edit path includes a preempt stop barrier (the
 * backend waits for a running turn to unwind) before the rewind cut and
 * admission, so this is deliberately longer than steering's admission ack. */
const REWIND_COMMAND_TIMEOUT_MS = 60_000;

/** rowsRange tail window. The editable/retryable rows are latest-only, so the
 * last window (no beforeRowId cursor) always contains them; 200 is the
 * protocol max (PROTOCOL_V4_LIMITS.rowsRangeMaxLimit). */
const ROWS_RANGE_LIMIT = 200;

/** One stale-retry: the rowsRange read and the command admission race every
 * other writer (a notification turn, a concurrent client) — a single refresh
 * covers the realistic contention; more would just burn CAS round trips. */
const REWIND_STALE_RETRIES = 1;

interface RewindRow {
  rowId: number;
  entityId: string;
  kind: string;
  canEdit: boolean;
  canRetry: boolean;
}

interface RowsRangeSnapshot {
  rows: RewindRow[];
  atRevision: number;
  atLogEpoch: string;
}

/** Upstream ack shape (commandAckSchema) — only the fields the bridge reads. */
interface RewindAck {
  status?: string;
  reasonCode?: string;
  message?: string;
  result?: { type?: string; disposition?: string; reasonCode?: string };
}

/**
 * Read the conversation row projection's tail window. Read-only, stateless,
 * resend-safe upstream; a backend without the v4 face answers -32601 (older
 * than desktop 3.14.3 — the first tag whose source tree carries the command
 * set), which surfaces as a clean error to the caller.
 */
async function fetchRowsRange(
  server: ZcodeAcpServer,
  zcodeSid: string,
): Promise<RowsRangeSnapshot> {
  const backend = await server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "v4/conversation/rowsRange",
    { sessionId: zcodeSid, limit: ROWS_RANGE_LIMIT },
    15_000,
  );
  if (resp.error) {
    throw new RequestError(
      -32603,
      `rewind unavailable on this backend: ${resp.error.message ?? "rowsRange rejected"}`,
    );
  }
  const result = (resp.result ?? {}) as {
    rows?: Array<Record<string, unknown>>;
    atRevision?: unknown;
    atLogEpoch?: unknown;
  };
  if (typeof result.atRevision !== "number" || typeof result.atLogEpoch !== "string") {
    throw new RequestError(-32603, "rewind unavailable: rowsRange answered an unknown shape");
  }
  const rows: RewindRow[] = (result.rows ?? []).flatMap((raw) => {
    const rowId = raw["rowId"];
    const entityId = raw["entityId"];
    if (typeof rowId !== "number" || typeof entityId !== "string" || !entityId) return [];
    const actions = (raw["actions"] ?? {}) as Record<string, unknown>;
    return [
      {
        rowId,
        entityId,
        kind: typeof raw["kind"] === "string" ? raw["kind"] : "",
        canEdit: actions["canEdit"] === true,
        canRetry: actions["canRetry"] === true,
      },
    ];
  });
  return { rows, atRevision: result.atRevision, atLogEpoch: result.atLogEpoch };
}

function rowNotFound(messageId: string): RequestError {
  return new RequestError(
    -32602,
    `message ${messageId} not found in the current conversation (it may already have been rewound away)`,
  );
}

/** The edit target: the userInput row whose entityId is the client-supplied
 * message handle, and which the projection still marks editable. */
function resolveEditRow(snapshot: RowsRangeSnapshot, messageId: string): RewindRow {
  const row = snapshot.rows.find((r) => r.entityId === messageId);
  if (!row) throw rowNotFound(messageId);
  if (row.kind !== "userInput" || !row.canEdit) {
    throw new RequestError(
      -32602,
      "only the latest user message can be edited (backend guard: guard.actionUnavailable)",
    );
  }
  return row;
}

/** The retry target: the client's assistant message handle, or (omitted) the
 * newest retryable assistant row = the latest turn. */
function resolveRetryRow(snapshot: RowsRangeSnapshot, messageId?: string): RewindRow {
  if (messageId) {
    const row = snapshot.rows.find((r) => r.entityId === messageId);
    if (!row) throw rowNotFound(messageId);
    if (row.kind !== "assistantText" || !row.canRetry) {
      throw new RequestError(
        -32602,
        "only the latest assistant reply can be regenerated (backend guard: guard.actionUnavailable)",
      );
    }
    return row;
  }
  const latest = [...snapshot.rows].reverse().find((r) => r.kind === "assistantText" && r.canRetry);
  if (!latest) {
    throw new RequestError(-32602, "no retryable turn in the current conversation");
  }
  return latest;
}

/** Send one v4 rewind command envelope and classify the ack. Returns the
 * accepted ack, throws a RequestError carrying the backend's message
 * verbatim, or returns null on a CAS-stale verdict (caller refreshes). */
async function sendRewindCommand(
  server: ZcodeAcpServer,
  zcodeSid: string,
  type: "editUserQuery" | "retryTurn",
  payload: Record<string, unknown>,
  baseRevision: number,
  baseLogEpoch: string,
): Promise<RewindAck | null> {
  const backend = await server.ensureBackend();
  const envelope = {
    commandId: randomUUID(),
    clientId: "zcode-acp-server",
    sessionId: zcodeSid,
    baseRevision,
    baseLogEpoch,
    type,
    payload,
    issuedAt: Date.now(),
  };
  const resp = await backend.request(
    server.nextId(),
    "v4/command",
    envelope,
    REWIND_COMMAND_TIMEOUT_MS,
  );
  if (resp.error) {
    throw new RequestError(-32603, `rewind failed: ${resp.error.message ?? "unknown error"}`);
  }
  const ack = (resp.result ?? {}) as RewindAck;
  if (ack.status === "stale") return null;
  if (ack.status !== "accepted") {
    const detail = ack.message ?? ack.reasonCode ?? ack.status ?? "not accepted";
    throw new RequestError(-32603, `rewind rejected by backend: ${detail}`);
  }
  if (ack.result?.type === type && ack.result.disposition === "blocked") {
    // Upstream still answers `accepted` for a blocked workspace-rewind
    // combination — surface it as the failure it is.
    const detail = ack.result.reasonCode ?? ack.reasonCode ?? "blocked";
    throw new RequestError(-32603, `rewind blocked by backend: ${detail}`);
  }
  return ack;
}

/**
 * Post-rewind re-baseline (best-effort): the store history was rewritten in
 * place — the discarded branch is gone. Seed the hydration watermark like
 * fork does (entry presence = observed-settled, so the client-triggered
 * reload's replay read skips the generation's settle poll), and re-anchor the
 * projection differ: its `historyAnchor` may point into the discarded branch,
 * and a gone `afterMessageId` cursor makes the backend answer the FULL store
 * (fetchMessages), so the next turn's diff would needlessly scan it all.
 */
async function rebaseAfterRewind(server: ZcodeAcpServer, zcodeSid: string): Promise<void> {
  server.hydrationWatermark.set(zcodeSid, 0);
  // Ensure a differ exists (the rewind may be the first action on a freshly
  // attached session) — same as the compact path — so the anchor is correct
  // for the next turn even though no bridge turn ever ran here.
  let differ = server.differs.get(zcodeSid);
  if (!differ) {
    differ = new ProjectionDiffer();
    server.differs.set(zcodeSid, differ);
  }
  differ.resetTurn();
  try {
    const messages = await fetchMessages(server, zcodeSid);
    if (messages.length > 0) differ.markSeen(messages);
  } catch (e) {
    warn(
      `rewind: differ re-baseline read failed (ignored): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** What one rewind method wants sent, resolved against a fresh row snapshot. */
interface RewindRequest {
  type: "editUserQuery" | "retryTurn";
  payload: Record<string, unknown>;
  /** The mid that was rewound (reported back to the client). */
  rewoundMessageId: string;
}

/**
 * Shared body of both rewind methods: busy raise → target resolve → claim the
 * replacement turn → command (one stale retry) → re-baseline. The ack returns
 * at admission: the replacement turn runs after it, streamed to every
 * attached client through the claimed-turn forwarding, and the busy state
 * settles at that turn's terminal (the listener's foreign-turn tracking), so
 * the handler must NOT settle it on the accepted path — the claim watchdog
 * covers the accepted-but-no-turn edge.
 */
async function runRewind(
  server: ZcodeAcpServer,
  acpSid: string,
  zcodeSid: string,
  buildRequest: (snapshot: RowsRangeSnapshot) => RewindRequest,
): Promise<Record<string, unknown>> {
  const listener = await server.ensureBackgroundListener(zcodeSid);
  let accepted = false;
  let claimToken: number | null = null;
  await emitSessionTurnState(server, acpSid, true);
  try {
    claimToken = listener.claimRewindTurn();
    for (let attempt = 0; ; attempt++) {
      const snapshot = await fetchRowsRange(server, zcodeSid);
      const request = buildRequest(snapshot);
      const ack = await sendRewindCommand(
        server,
        zcodeSid,
        request.type,
        request.payload,
        snapshot.atRevision,
        snapshot.atLogEpoch,
      );
      if (ack) {
        accepted = true;
        log(`rewind ${request.type} → accepted (rewound ${request.rewoundMessageId.slice(-8)})`);
        await rebaseAfterRewind(server, zcodeSid);
        return { ok: true, rewoundMessageId: request.rewoundMessageId };
      }
      if (attempt >= REWIND_STALE_RETRIES) {
        throw new RequestError(
          -32603,
          "rewind rejected by backend: conversation kept changing (stale)",
        );
      }
      log(`rewind ${request.type} → stale projection, refreshing target and retrying`);
    }
  } finally {
    if (!accepted) {
      // Token-guarded: a concurrent rewind that superseded our claim owns
      // the slot now — dropping ITS claim (and busy window) from OUR failure
      // would kill the flight still in progress. No-op when the claim already
      // armed (token consumed) or belongs to a newer call.
      if (claimToken !== null) listener.releaseRewindClaim(claimToken);
      // Settle only when nothing else holds the session busy: another
      // client's turn may legitimately be running (our raise locked everyone;
      // a blind broadcast-false would unlock it mid-flight). That turn's own
      // lifecycle settles the state — a turn IS running, so the caller's UI
      // reading stays truthful.
      const busyElsewhere =
        [...server.pendingTurns.values()].some((t) => t.zcodeSid === zcodeSid) ||
        server.foreignActiveTurns.has(zcodeSid) ||
        server.notifyTurnActiveSince.has(zcodeSid);
      if (!busyElsewhere) await emitSessionTurnState(server, acpSid, false);
    }
  }
}

/**
 * `session/edit_user_message {sessionId, messageId, newText}` → v4
 * `editUserQuery` (workspaceMode always "preserve" — file rewind stays a
 * desktop-app concern per the spec's non-goals).
 */
export async function editUserMessage(
  server: ZcodeAcpServer,
  params: { sessionId: string; messageId?: unknown; newText?: unknown },
): Promise<Record<string, unknown>> {
  const messageId = params.messageId;
  const newText = params.newText;
  if (typeof messageId !== "string" || !messageId) {
    throw new RequestError(
      -32602,
      "edit_user_message requires messageId (the _meta.zcode.mid of a user message)",
    );
  }
  if (typeof newText !== "string" || !newText.trim()) {
    // Upstream rejects an empty replacement when the original also had no
    // attachments/quotes; the ACP surface is text-only, so refuse early and
    // keep the failure from burning a rewind round trip.
    throw new RequestError(-32602, "edit_user_message requires non-empty newText");
  }
  const zcodeSid = await ensureRealSession(server, params.sessionId);
  return runRewind(server, params.sessionId, zcodeSid, (snapshot) => {
    const row = resolveEditRow(snapshot, messageId);
    return {
      type: "editUserQuery",
      payload: {
        target: { rowId: row.rowId, entityId: row.entityId },
        newText,
        workspaceMode: "preserve",
      },
      rewoundMessageId: messageId,
    };
  });
}

/**
 * `session/retry_turn {sessionId, messageId?}` → v4 `retryTurn`. An omitted
 * messageId retries the latest turn.
 */
export async function retryTurn(
  server: ZcodeAcpServer,
  params: { sessionId: string; messageId?: unknown },
): Promise<Record<string, unknown>> {
  const messageId =
    typeof params.messageId === "string" && params.messageId ? params.messageId : undefined;
  const zcodeSid = await ensureRealSession(server, params.sessionId);
  return runRewind(server, params.sessionId, zcodeSid, (snapshot) => {
    const row = resolveRetryRow(snapshot, messageId);
    return {
      type: "retryTurn",
      payload: { target: { rowId: row.rowId, entityId: row.entityId } },
      rewoundMessageId: row.entityId,
    };
  });
}
