/**
 * Handle zcode-initiated server→client requests during a turn.
 *
 * ZCode's interaction broker dispatches three request kinds, all bridged onto
 * ACP `session/requestPermission` (Zed supports it natively; elicitation is
 * not supported):
 *   - interaction/requestPermission (tool auth)       → direct option mapping
 *   - interaction/requestUserInput (ExitPlanMode)     → approve/reject options
 *   - interaction/requestUserInput (AskUserQuestion)  → per-question popups
 *     (single-select: one popup; multi-select: per-option Include/Skip)
 *
 * Reannounce dedup: ZCode reannounces unanswered requests every ~1s sharing
 * the same requestId/toolCallId. The first request forwards to the client;
 * reannounces either get the cached result (if it arrived) or just record
 * their zcode id for a later unified reply.
 */

import type * as acp from "@agentclientprotocol/sdk";

import type { ServerRequest, ZcodeBackend } from "../backend/client.js";
import type {
  ZcodeInteractionPermissionParams,
  ZcodeInteractionResponse,
  ZcodeInteractionUserInputParams,
} from "../backend/types.js";
import {
  acpPermissionResponseToExitPlanMode,
  acpPermissionResponseToZcode,
  buildAskUserAcpParams,
  buildAskUserElicitationForm,
  buildExitPlanModeElicitationForm,
  exitPlanModeToAcpPermission,
  isAskUserQuestion,
  isExitPlanMode,
  isPermissionRequest,
  parseAskUserElicitationResponse,
  parseAskUserResponse,
  parseExitPlanModeElicitationResponse,
  splitAskUserQuestions,
  zcodePermissionToAcp,
} from "../interaction/adapter.js";
import { log, warn } from "../utils.js";
import type { PendingTurn, ZcodeAcpServer } from "../server.js";
import { sendSessionUpdate } from "./io.js";

/** A dedup entry tracking reannounced zcode ids + the cached result. */
interface DedupEntry {
  zcodeIds: number[];
  result?: ZcodeInteractionResponse;
}

/** Per-server reannounce dedup state (lazy-initialised). */
export function getPendingInteractions(server: ZcodeAcpServer): Map<string, DedupEntry> {
  const existing = (server as unknown as { _pendingInteractions?: Map<string, DedupEntry> })
    ._pendingInteractions;
  if (existing) return existing;
  const fresh = new Map<string, DedupEntry>();
  (server as unknown as { _pendingInteractions: Map<string, DedupEntry> })._pendingInteractions =
    fresh;
  return fresh;
}

/**
 * Drain and handle pending zcode server→client requests for THIS session only.
 * Returns true if any were handled (used by the turn loop to refresh the
 * no-progress timer).
 *
 * The backend's `serverRequests` queue is shared across all sessions (a single
 * subprocess serves them all). Without filtering, session A's turn loop could
 * pop session B's permission request and forward it to A's client — the popup
 * lands in the wrong session. When `turn` is available we filter by
 * `params.sessionId` so each turn loop only consumes its own requests; others
 * are re-queued for their owner. Without `turn` (tests / non-turn callers) we
 * process everything (legacy behaviour).
 */
export async function handleServerRequests(
  server: ZcodeAcpServer,
  backend: ZcodeBackend,
  cx: acp.AgentContext,
  acpSid: string,
  turn?: PendingTurn,
): Promise<boolean> {
  const pending = getPendingInteractions(server);
  let handled = false;
  const mySid = turn?.zcodeSid;

  for (;;) {
    const all = backend.pollServerRequests();
    if (all.length === 0) return handled;
    // Without a session filter (no turn), process everything — legacy path.
    if (mySid === undefined) {
      for (const req of all) {
        handled = true;
        await handleOne(server, backend, cx, acpSid, req, pending, turn);
      }
      continue;
    }
    // Pick the first request belonging to this session; put the rest back.
    // Requests without a sessionId field are unrouteable — claim them here
    // so they don't sit in the queue forever.
    let mine: ServerRequest | undefined;
    const others: ServerRequest[] = [];
    for (const r of all) {
      const sid = (r.params as { sessionId?: string }).sessionId;
      if (!mine && (sid === undefined || sid === mySid)) {
        mine = r;
      } else {
        others.push(r);
      }
    }
    // Re-queue the ones that don't belong to this session (prepend to preserve order).
    if (others.length > 0) backend.requeueServerRequests(others);
    if (!mine) return handled;
    handled = true;
    await handleOne(server, backend, cx, acpSid, mine, pending, turn);
  }
}

async function handleOne(
  server: ZcodeAcpServer,
  backend: ZcodeBackend,
  cx: acp.AgentContext,
  acpSid: string,
  req: ServerRequest,
  pending: Map<string, DedupEntry>,
  turn?: PendingTurn,
): Promise<void> {
  const method = req.method;
  const zcodeReqId = req.id;
  const params = req.params as
    ZcodeInteractionPermissionParams | ZcodeInteractionUserInputParams | Record<string, unknown>;

  const ask = isAskUserQuestion(method, params);
  const perm = isPermissionRequest(method);
  const epm = isExitPlanMode(params);

  if (!perm && !(isUserInputRequestUnchecked(method) && (epm || ask))) {
    warn(`  ⚠ unhandled server→client request: ${method} (id=${zcodeReqId})`);
    sendZcodeError(backend, zcodeReqId, `bridge unsupported: ${method}`);
    return;
  }

  // Reannounce dedup.
  const dedupKey =
    (params as { requestId?: string; toolCallId?: string }).requestId ??
    (params as { toolCallId?: string }).toolCallId ??
    null;
  if (dedupKey && pending.has(dedupKey)) {
    const entry = pending.get(dedupKey)!;
    if (entry.result !== undefined) {
      // Result already cached (client responded earlier): reply directly with
      // {id, result} so zcode resolves the reannounced request. Must NOT use
      // notify() (that writes {method, params}, not a valid response).
      backend.sendReply(zcodeReqId, entry.result);
      log(`  ⟳ reannounce, returning cached result (zcode_id=${zcodeReqId})`);
    } else {
      entry.zcodeIds.push(zcodeReqId);
      log(`  ⟳ reannounce, recording zcode_id=${zcodeReqId} (no re-prompt)`);
    }
    return;
  }
  if (dedupKey) pending.set(dedupKey, { zcodeIds: [zcodeReqId] });

  let zcodeResp: ZcodeInteractionResponse;
  if (ask) {
    zcodeResp = await handleAskUserQuestion(
      server,
      cx,
      acpSid,
      params as ZcodeInteractionUserInputParams,
      turn,
    );
  } else {
    zcodeResp = await handleSinglePermission(server, cx, acpSid, params, epm, perm, turn);
  }

  // Reply to the first zcode id + all reannounced ones, and cache for late reannounces.
  sendInteractionReply(backend, pending, dedupKey, zcodeReqId, zcodeResp);
}

/** Single requestPermission (tool auth / ExitPlanMode). */
async function handleSinglePermission(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  params:
    ZcodeInteractionPermissionParams | ZcodeInteractionUserInputParams | Record<string, unknown>,
  epm: boolean,
  perm: boolean,
  turn?: PendingTurn,
): Promise<ZcodeInteractionResponse> {
  const p = params as ZcodeInteractionPermissionParams & ZcodeInteractionUserInputParams;
  // Emit a tool_call first so Zed renders the popup (it requires the toolCallId
  // to have been emitted before request_permission).
  const toolCallId = p.toolCallId ?? "";
  const rawInput = p.input;
  const tcTitle = epm
    ? "Ready to code?"
    : perm
      ? `tool permission (${p.toolName ?? "?"})`
      : "interaction";
  const tcKind = epm ? "switch_mode" : "other";
  const toolName = epm ? "ExitPlanMode" : (p.toolName ?? "");
  const tcUpdate: acp.SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId,
    title: tcTitle,
    kind: tcKind,
    status: "pending",
    rawInput,
    _meta: { claudeCode: { toolName } },
  };
  if (epm && rawInput && typeof rawInput === "object") {
    const planText = (rawInput as { plan?: string }).plan;
    if (planText) {
      tcUpdate.content = [{ type: "content", content: { type: "text", text: planText } }];
    }
  }
  await sendSessionUpdate(cx, acpSid, tcUpdate);

  // ExitPlanMode: prefer elicitation form when the client supports it.
  if (epm && server.supportsElicitationForm()) {
    const formParams = buildExitPlanModeElicitationForm(
      p as ZcodeInteractionUserInputParams,
      acpSid,
      toolCallId || undefined,
    );
    log(`  ⟳ ExitPlanMode forwarding elicitation/create (form)`);
    const elicResp = await requestWithTimeout(
      cx,
      "elicitation/create",
      formParams,
      "elicitation/create",
      undefined,
      turn,
    );
    if (elicResp === null) {
      return { action: "decline", reason: "elicitation failed" };
    }
    return parseExitPlanModeElicitationResponse(elicResp) as ZcodeInteractionResponse;
  }

  // Tool auth, or ExitPlanMode without elicitation: use request_permission.
  const acpParams = perm
    ? zcodePermissionToAcp(p as ZcodeInteractionPermissionParams, acpSid)!
    : exitPlanModeToAcpPermission(p as ZcodeInteractionUserInputParams, acpSid);

  const acpReqId = server.nextId();
  log(
    `  ⟳ ${toolName || "permission"}, forwarding session/request_permission (acp_id=${acpReqId})`,
  );
  const acpResp = await requestWithTimeout(
    cx,
    "session/request_permission",
    acpParams,
    "request_permission",
    undefined,
    turn,
  );
  if (acpResp === null) {
    return { action: "decline", reason: "timeout or cancelled" };
  }
  return perm
    ? acpPermissionResponseToZcode(acpResp)
    : acpPermissionResponseToExitPlanMode(acpResp);
}

/**
 * AskUserQuestion: sequential per-question, multi-select per-option.
 *
 * Single-select: one popup per question; Skip/cancel/timeout → overall decline.
 * Multi-select: one Include/Skip popup per option; Include picks comma-joined.
 */
export async function handleAskUserQuestion(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  params: ZcodeInteractionUserInputParams,
  turn?: PendingTurn,
): Promise<ZcodeInteractionResponse> {
  const qs = splitAskUserQuestions(params);
  if (qs === null) {
    warn("  ⚠ AskUserQuestion: no valid questions, declining");
    return { action: "decline", reason: "no valid questions" };
  }
  const toolCallId = params.toolCallId ?? "";
  const rawInput = params.input;

  // Preferred path: form-based elicitation renders all questions in one form.
  if (server.supportsElicitationForm()) {
    return handleAskUserViaElicitation(server, cx, acpSid, params, toolCallId, rawInput, turn);
  }

  // Fallback path: per-question request_permission popups.
  const answers: Record<string, string> = {};

  for (let idx = 0; idx < qs.length; idx++) {
    const q = qs[idx]!;
    if (!q.multiSelect) {
      // Single-select: one popup.
      await emitAskToolCall(cx, acpSid, toolCallId, idx, q.question, rawInput);
      const acpParams = buildAskUserAcpParams(params, acpSid, q.options);
      acpParams.toolCall.toolCallId = `${toolCallId}_${idx}`;
      const resp = await askOnce(server, cx, acpParams, idx + 1, qs.length, q.question, turn);
      if (turn?.cancelled) {
        warn(`  ⚠ AskUserQuestion [${idx + 1}] aborted (turn cancelled), declining`);
        return { action: "decline", reason: "turn cancelled" };
      }
      const selected = parseAskUserResponse(resp);
      if (selected === null) {
        warn(`  ⚠ AskUserQuestion [${idx + 1}] skip/cancel/timeout, declining`);
        return { action: "decline", reason: "skipped or cancelled" };
      }
      answers[q.question] = selected;
      log(`  ✓ AskUserQuestion [${idx + 1}] answer: ${selected}`);
    } else {
      // Multi-select: per-option yes/no. options is [opt0_yes, opt0_no, opt1_yes, opt1_no, ...].
      const pairs: Array<{ label: string; pair: typeof q.options }> = [];
      for (let i = 0; i < q.options.length; i += 2) {
        const yesOpt = q.options[i];
        const noOpt = q.options[i + 1];
        if (!yesOpt || !noOpt) continue;
        pairs.push({ label: yesOpt.optionId.replace(/:yes$/, ""), pair: [yesOpt, noOpt] });
      }
      const picked: string[] = [];
      for (let sub = 0; sub < pairs.length; sub++) {
        const { label, pair } = pairs[sub]!;
        const promptText = `${q.question}\n— include "${label}"?`;
        await emitAskToolCall(cx, acpSid, toolCallId, `${idx}_${sub}`, promptText, rawInput);
        const acpParams = buildAskUserAcpParams(params, acpSid, pair);
        acpParams.toolCall.toolCallId = `${toolCallId}_${idx}_${sub}`;
        const resp = await askOnce(server, cx, acpParams, idx + 1, qs.length, label, turn);
        // Abort the whole multi-select if the turn was cancelled (user sent a
        // new prompt) or the popup timed out — otherwise the remaining options
        // keep popping up and block the new task. Mirrors the single-select
        // path's null → decline behaviour.
        if (turn?.cancelled || resp === null) {
          warn(`  ⚠ AskUserQuestion [${idx + 1}] multi aborted (cancel/timeout), declining`);
          return { action: "decline", reason: "cancelled or timed out" };
        }
        if (parseAskUserResponse(resp) === "yes") {
          picked.push(label);
          log(`  ✓ AskUserQuestion [${idx + 1}] multi picked: ${label}`);
        } else {
          log(`  · AskUserQuestion [${idx + 1}] multi skipped: ${label}`);
        }
      }
      answers[q.question] = picked.join(", ");
      log(`  ✓ AskUserQuestion [${idx + 1}] multi answer: ${answers[q.question] || "(none)"}`);
    }
  }
  log(`  ✓ AskUserQuestion all answered (${Object.keys(answers).length}), replying`);
  return { action: "accept", content: { answers } };
}

/**
 * AskUserQuestion via elicitation form — one form for all questions.
 *
 * When the client supports form-based elicitation, render a single form with
 * one field per question instead of N sequential popups. Falls back to
 * `decline` on any failure so the caller can degrade gracefully.
 */
async function handleAskUserViaElicitation(
  _server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  params: ZcodeInteractionUserInputParams,
  toolCallId: string,
  rawInput: unknown,
  turn?: PendingTurn,
): Promise<ZcodeInteractionResponse> {
  const toolName = "AskUserQuestion";
  await sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: "questions",
    kind: "other",
    status: "pending",
    rawInput,
    _meta: { claudeCode: { toolName } },
  });
  const formParams = buildAskUserElicitationForm(params, acpSid, toolCallId || undefined);
  log(
    `  ⟳ AskUserQuestion forwarding elicitation/create (form, ${Object.keys(formParams.requestedSchema.properties).length} fields)`,
  );
  const acpResp = await requestWithTimeout(
    cx,
    "elicitation/create",
    formParams,
    "elicitation/create",
    undefined,
    turn,
  );
  if (acpResp === null) {
    return { action: "decline", reason: "elicitation failed" };
  }
  const answers = parseAskUserElicitationResponse(acpResp, params);
  if (answers === null) {
    warn("  ⚠ AskUserQuestion elicitation declined/cancelled");
    return { action: "decline", reason: "declined or cancelled" };
  }
  log(`  ✓ AskUserQuestion elicitation answered (${Object.keys(answers).length})`);
  return { action: "accept", content: { answers } };
}

/** Emit the prerequisite tool_call for an AskUserQuestion popup. */
async function emitAskToolCall(
  cx: acp.AgentContext,
  acpSid: string,
  toolCallId: string,
  idxSuffix: number | string,
  qText: string,
  rawInput: unknown,
): Promise<void> {
  await sendSessionUpdate(cx, acpSid, {
    sessionUpdate: "tool_call",
    toolCallId: `${toolCallId}_${idxSuffix}`,
    title: qText,
    kind: "other",
    status: "pending",
    rawInput,
    _meta: { claudeCode: { toolName: "AskUserQuestion" } },
    content: [{ type: "content", content: { type: "text", text: qText } }],
  });
}

/** Send one requestPermission and await the response. */
async function askOnce(
  _server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpParams: {
    options: unknown[];
    sessionId: string;
    toolCall: { toolCallId: string; rawInput: unknown };
  },
  _qNum: number,
  _qTotal: number,
  _label: string,
  turn?: PendingTurn,
): Promise<unknown> {
  const acpReqId = _server.nextId();
  log(`  ⟳ AskUserQuestion forwarding session/request_permission (acp_id=${acpReqId})`);
  return requestWithTimeout(
    cx,
    "session/request_permission",
    acpParams,
    "request_permission",
    undefined,
    turn,
  );
}

// ---------- request helpers ----------

/**
 * Interaction request timeout. Python's `_await_client_response` uses 600s and
 * this matches it — long enough for slow models, retries, and user deliberation
 * (well past the turn loop's 120s no-progress guard), while still bounding a
 * dead client so it cannot pin a turn forever (the turn loop's
 * `await handleServerRequests` would otherwise block indefinitely and the 120s
 * no-progress timer could never re-check).
 */
const INTERACTION_TIMEOUT_MS = 600_000;

/**
 * Send a client-side request with a timeout and turn-cancel awareness. Resolves
 * to the client response, or `null` on timeout/error/cancel (callers treat null
 * as decline). The underlying `cx.request` promise stays pending after a
 * timeout/cancel (the SDK has no abort), but we no longer await it; it settles
 * naturally when the client eventually responds or the connection closes.
 *
 * Turn cancel: while awaiting the client response we poll `turn.cancelled`
 * every 100ms (mirrors Python `_await_client_response`, which drains + checks
 * cancel every 0.1s). Without this, a user pressing stop during a permission
 * popup would be ignored until the client responds or 600s elapses, because the
 * turn loop's `await handleServerRequests` blocks here.
 */
async function requestWithTimeout(
  cx: acp.AgentContext,
  method: string,
  params: unknown,
  label: string,
  timeoutMs = INTERACTION_TIMEOUT_MS,
  turn?: PendingTurn,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelTimer: ReturnType<typeof setInterval> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      warn(`  ⚠ ${label} timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
  });
  const racers: Array<Promise<unknown>> = [
    cx.request(method, params as never).catch((e: unknown) => {
      warn(`  ⚠ ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }),
    timeout,
  ];
  // Race a cancel poll so the user can abort a pending popup. Resolves null on
  // cancel; callers already treat null as decline. Only added when a turn is
  // available (turn-less callers, e.g. tests, skip cancel awareness).
  if (turn) {
    racers.push(
      new Promise<null>((resolve) => {
        cancelTimer = setInterval(() => {
          if (turn.cancelled) {
            warn(`  ⚠ ${label} aborted (turn cancelled)`);
            resolve(null);
          }
        }, 100);
        // unref so this polling interval cannot keep the event loop (and thus
        // the process) alive while awaiting a client response (up to 600s).
        cancelTimer.unref?.();
      }),
    );
  }
  try {
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancelTimer) clearInterval(cancelTimer);
  }
}

// ---------- reply helpers ----------

/** Reply to the first zcode id + all reannounced ones, cache for late reannounces. */
function sendInteractionReply(
  backend: ZcodeBackend,
  pending: Map<string, DedupEntry>,
  dedupKey: string | null,
  firstZcodeId: number,
  result: ZcodeInteractionResponse,
): void {
  const ids = dedupKey && pending.has(dedupKey) ? pending.get(dedupKey)!.zcodeIds : [firstZcodeId];
  if (dedupKey && pending.has(dedupKey)) {
    pending.get(dedupKey)!.result = result;
  }
  for (const id of ids) {
    sendZcodeReply(backend, id, result);
  }
  log(`  ✓ replied to zcode (${ids.length} request(s))`);
  // Schedule cleanup so late reannounces (after the result) still hit the cache briefly.
  if (dedupKey) {
    setTimeout(() => pending.delete(dedupKey), 30_000).unref();
  }
}

/** Send a zcode response (result) for a server→client request id. */
function sendZcodeReply(
  backend: ZcodeBackend,
  zcodeId: number,
  result: ZcodeInteractionResponse,
): void {
  // zcode expects {id, result} — but our backend.notify sends {method, params}. Use a raw write.
  // The backend's notify is for notifications; replies need the id. We route via a private seam.
  (backend as unknown as { sendReply: (id: number, result: unknown) => void }).sendReply(
    zcodeId,
    result,
  );
}

/** Send a zcode error response. */
function sendZcodeError(backend: ZcodeBackend, zcodeId: number, message: string): void {
  (
    backend as unknown as { sendError: (id: number, code: number, message: string) => void }
  ).sendError(zcodeId, -32601, message);
}

function isUserInputRequestUnchecked(method: string): boolean {
  return method === "interaction/requestUserInput";
}
