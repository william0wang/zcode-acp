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
  exitPlanModeToAcpPermission,
  isAskUserQuestion,
  isExitPlanMode,
  isPermissionRequest,
  parseAskUserElicitationResponse,
  parseAskUserResponse,
  splitAskUserQuestions,
  zcodePermissionToAcp,
} from "../interaction/adapter.js";
import { buildConfigOptions, buildModes } from "../config/options.js";
import { log, warn } from "../utils.js";
import type { PendingTurn, ZcodeAcpServer } from "../server.js";
import { sendSessionUpdate } from "./io.js";

/** A dedup entry tracking reannounced zcode ids + the cached result. */
interface DedupEntry {
  zcodeIds: Array<number | string>;
  result?: ZcodeInteractionResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Re-read the authoritative session mode and push a `config_option_update`
 * with the mode item's currentValue set to it.
 *
 * Used for ExitPlanMode reconciliation: Zed's `config_state()` drops
 * `session_modes` to None whenever `session/new` returns configOptions (which
 * the bridge always sends), so subsequent `current_mode_update` notifications
 * are silently ignored — only `config_option_update` drives the dropdown.
 *
 * Always emits (no dedup): when the user manually switched to plan via the
 * dropdown (session/set_mode), `lastMode` can lag the real mode and a dedup
 * check would wrongly suppress the post-exit update.
 */
async function emitModeViaConfigOption(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
): Promise<void> {
  try {
    const modes = await buildModes(server, zcodeSid);
    server.lastMode.set(acpSid, modes.currentModeId);
    const options = await buildConfigOptions(server, zcodeSid);
    const modeOpt = options.find((o) => o.id === "mode");
    if (modeOpt) modeOpt.currentValue = modes.currentModeId;
    await sendSessionUpdate(cx, acpSid, {
      sessionUpdate: "config_option_update",
      configOptions: options,
    });
  } catch (e) {
    warn(`emitModeViaConfigOption failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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

  // ExitPlanMode approval switches the session mode (plan → build/etc.), but
  // the backend applies it asynchronously — an immediate session/read still
  // sees the pre-exit mode. Probe once after a delay to read the real post-exit
  // mode, then push it via config_option_update: Zed's config_state() drops
  // session_modes to None when session/new returns configOptions, so
  // current_mode_update is silently ignored — only config_option_update drives
  // the mode dropdown's selection.
  if (epm && (zcodeResp as { action?: string }).action === "accept") {
    const zcodeSid = server.resolveSid(acpSid);
    if (zcodeSid) {
      void sleep(1000).then(() =>
        emitModeViaConfigOption(server, cx, acpSid, zcodeSid).catch(() => {}),
      );
    }
  }
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

  // ExitPlanMode and tool auth both go through session/request_permission.
  // ExitPlanMode intentionally does NOT use elicitation/create even when the
  // client supports forms — matching claude-agent-acp's reference behaviour:
  // plan approval is a permission decision (approve/reject), not a structured
  // input, and rendering it through the elicitation channel surfaces a generic
  // "input request" shell that reads wrong for this flow. AskUserQuestion is
  // the right place for elicitation; plan approval is not.
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
  if (acpResp === INTERRUPTED) {
    return onInteractionInterrupted(cx, acpSid, toolCallId, turn);
  }
  if (acpResp === null) {
    return { action: "decline", reason: "declined or cancelled" };
  }
  return perm
    ? acpPermissionResponseToZcode(acpResp)
    : acpPermissionResponseToExitPlanMode(acpResp);
}

/**
 * AskUserQuestion: sequential per-question, multi-select per-option.
 *
 * Single-select: one popup per question; Skip/cancel → overall decline.
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
        warn(`  ⚠ AskUserQuestion [${idx + 1}] skip/cancel, declining`);
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
        // new prompt) or the popup returned nothing — otherwise the remaining
        // options keep popping up and block the new task. Mirrors the
        // single-select path's null → decline behaviour.
        if (turn?.cancelled || resp === null) {
          warn(`  ⚠ AskUserQuestion [${idx + 1}] multi aborted (cancel/interrupt), declining`);
          return { action: "decline", reason: "cancelled or interrupted" };
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
  if (acpResp === INTERRUPTED) {
    return onInteractionInterrupted(cx, acpSid, toolCallId, turn);
  }
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
  const resp = await requestWithTimeout(
    cx,
    "session/request_permission",
    acpParams,
    "request_permission",
    undefined,
    turn,
  );
  if (resp === INTERRUPTED) {
    // Interrupted (connection close / env timeout / cancel): mark the popup's
    // tool_call failed and flip turn.cancelled so the outer loop aborts and the
    // turn loop stops the backend. Return null so callers' existing null →
    // decline branch handles the reply uniformly.
    await onInteractionInterrupted(cx, acpParams.sessionId, acpParams.toolCall.toolCallId, turn);
    return null;
  }
  return resp;
}

// ---------- request helpers ----------

/**
 * Interaction request wait strategy.
 *
 * By default we wait INDEFINITELY for the user to respond to a confirmation
 * popup — this matches every mainstream agent (Claude Code, Gemini CLI, Codex,
 * Cursor all wait forever for tool-auth/ExitPlanMode/AskUserQuestion; the ACP
 * spec has no timeout on `session/request_permission`). A finite timeout that
 * auto-declines is actively harmful: it decides for the user (often the
 * opposite of their intent) and then keeps running, which is exactly the bug
 * this fixed.
 *
 * Two things can still break a pending wait:
 *   1. `turn.cancelled` — the user pressed stop / sent a new prompt (preempt).
 *   2. Connection close (`cx.signal` abort / `cx.closed` resolves) — the editor
 *      went away. This is the real crash signal and replaces the old timeout.
 *
 * An explicit timeout is kept as an opt-in escape hatch via the
 * `ZCODE_ACP_INTERACTION_TIMEOUT_MS` env var (milliseconds; 0/unset = wait
 * forever). On any of these interrupts the caller replies `decline` to unlock
 * the backend AND flips `turn.cancelled` so the turn loop stops the backend
 * turn instead of auto-continuing.
 */
const INTERACTION_TIMEOUT_MS = parseInteractionTimeout();

function parseInteractionTimeout(): number {
  const raw = process.env.ZCODE_ACP_INTERACTION_TIMEOUT_MS;
  if (!raw) return 0; // 0 = wait indefinitely
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Marker returned when a wait was interrupted (connection close, env timeout,
 * or turn cancel) as opposed to the client deliberately returning null. Callers
 * flip `turn.cancelled` on this so the backend turn is stopped rather than
 * allowed to continue after the decline reply.
 */
const INTERRUPTED = Symbol("interactionInterrupted");
type InteractionResult = unknown | typeof INTERRUPTED;

/**
 * Send a client-side request and wait for the response. By default waits
 * indefinitely (see {@link INTERACTION_TIMEOUT_MS}). Resolves to the client
 * response, `null` if the client returned null/errored, or {@link INTERRUPTED}
 * if the wait was broken by connection close / env timeout / turn cancel. The
 * underlying `cx.request` promise stays pending after an interrupt (the SDK has
 * no abort) but is no longer awaited; it settles naturally when the client
 * eventually responds or the connection closes.
 */
async function requestWithTimeout(
  cx: acp.AgentContext,
  method: string,
  params: unknown,
  label: string,
  timeoutMs = INTERACTION_TIMEOUT_MS,
  turn?: PendingTurn,
): Promise<InteractionResult> {
  // Build the racers. The primary is the client request itself.
  const racers: Array<Promise<InteractionResult>> = [
    cx.request(method, params as never).catch((e: unknown) => {
      warn(`  ⚠ ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }),
  ];

  // Connection-close detection: replaces the old finite timeout as the crash
  // guard. `cx.signal` is an AbortSignal that fires when the stream closes;
  // `cx.closed` is the Promise form. Either being present is enough.
  const signal = (cx as { signal?: AbortSignal }).signal;
  const closed = (cx as { closed?: Promise<void> }).closed;
  if (signal || closed) {
    racers.push(
      new Promise<typeof INTERRUPTED>((resolve) => {
        let done = false;
        const fire = () => {
          if (done) return;
          done = true;
          warn(`  ⚠ ${label} aborted (client connection closed)`);
          resolve(INTERRUPTED);
        };
        signal?.addEventListener("abort", fire);
        closed?.then(fire).catch(() => {});
      }),
    );
  }

  // Optional env timeout (off by default).
  if (timeoutMs > 0) {
    racers.push(
      new Promise<typeof INTERRUPTED>((resolve) => {
        const t = setTimeout(() => {
          warn(`  ⚠ ${label} timed out after ${timeoutMs}ms`);
          resolve(INTERRUPTED);
        }, timeoutMs);
        t.unref?.();
      }),
    );
  }

  // Turn-cancel poll: lets the user abort a pending popup via stop/preempt.
  if (turn) {
    racers.push(
      new Promise<typeof INTERRUPTED>((resolve) => {
        const cancelTimer = setInterval(() => {
          if (turn.cancelled) {
            warn(`  ⚠ ${label} aborted (turn cancelled)`);
            resolve(INTERRUPTED);
          }
        }, 100);
        // unref so this polling interval cannot keep the event loop alive.
        cancelTimer.unref?.();
      }),
    );
  }

  return Promise.race(racers);
}

/**
 * Handle an interrupted interaction wait (connection close, env timeout, or
 * turn cancel). Emits a `failed` tool_call_update so the editor shows a clear
 * red marker, and flips `turn.cancelled` so the turn loop stops the backend
 * turn instead of auto-continuing after the decline reply.
 *
 * Returns the decline response the caller should send back to zcode.
 */
async function onInteractionInterrupted(
  cx: acp.AgentContext,
  acpSid: string,
  toolCallId: string,
  turn?: PendingTurn,
): Promise<ZcodeInteractionResponse> {
  if (toolCallId) {
    await sendSessionUpdate(cx, acpSid, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "交互中断：连接关闭或超时，请重新发起对话。" },
        },
      ],
    }).catch(() => {
      /* best-effort: editor may already be gone */
    });
  }
  if (turn) turn.cancelled = true;
  return { action: "decline", reason: "interrupted (connection closed or timeout)" };
}

// ---------- reply helpers ----------

/** Reply to the first zcode id + all reannounced ones, cache for late reannounces. */
function sendInteractionReply(
  backend: ZcodeBackend,
  pending: Map<string, DedupEntry>,
  dedupKey: string | null,
  firstZcodeId: number | string,
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
  zcodeId: number | string,
  result: ZcodeInteractionResponse,
): void {
  // zcode expects {id, result} — but our backend.notify sends {method, params}. Use a raw write.
  // The backend's notify is for notifications; replies need the id. We route via a private seam.
  (backend as unknown as { sendReply: (id: number | string, result: unknown) => void }).sendReply(
    zcodeId,
    result,
  );
}

/** Send a zcode error response. */
function sendZcodeError(backend: ZcodeBackend, zcodeId: number | string, message: string): void {
  (
    backend as unknown as {
      sendError: (id: number | string, code: number, message: string) => void;
    }
  ).sendError(zcodeId, -32601, message);
}

function isUserInputRequestUnchecked(method: string): boolean {
  return method === "interaction/requestUserInput";
}
