/**
 * Session lifecycle handlers: initialize, new, list, resume, load, prompt, cancel.
 *
 * These map ACP session methods to ZCode app-server calls. `session/prompt` runs
 * the event-driven turn loop (subscribe-before-send ordering, no-progress
 * timeout, stall reconciliation). ZCode events are translated via
 * EventTranslator and dispatched as ACP `session/update` notifications.
 */

import process from "node:process";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

import { EventStreamListener, TurnMonitor } from "../backend/listener.js";
import type {
  ZcodeCreateResult,
  ZcodeListResult,
  ZcodeMessage,
  ZcodeMessagesResult,
  ZcodeSnapshot,
} from "../backend/types.js";
import { buildModes, buildConfigOptions } from "../config/options.js";
import { emitInitialUsage } from "../config/model-cache.js";
import { buildResumeRuntimeModel } from "../config/runtime-model.js";
import {
  buildDiffContent,
  EventTranslator,
  extractLocations,
  formatTurnError,
  ProjectionDiffer,
} from "../translators/index.js";
import type { InternalEvent } from "../translators/index.js";
import { log } from "../utils.js";
import type { PendingTurn, ZcodeAcpServer } from "../server.js";
import { dispatchEvent } from "./dispatch.js";
import { sendSessionUpdate, sendTextChunk } from "./io.js";
import { handleServerRequests } from "./server-requests.js";

/** Workspace descriptor used in session create/resume calls. */
function workspaceFor(cwd?: string): { workspacePath: string; workspaceKey: string } {
  const p = cwd || process.cwd();
  return { workspacePath: p, workspaceKey: p };
}

/** Convert a millisecond timestamp to ISO 8601 (for session list). */
function toIso(ms: number | undefined): string | undefined {
  if (typeof ms !== "number") return undefined;
  return new Date(ms).toISOString();
}

/** `session/new` → zcode `session/create` (mode hardcoded yolo). */
export async function newSession(
  server: ZcodeAcpServer,
  params: acp.NewSessionRequest,
): Promise<acp.NewSessionResponse> {
  const backend = server.ensureBackend();
  const cwd = params.cwd ?? process.cwd();
  log(`session/new: cwd=${cwd}`);

  const resp = await backend.request(
    server.nextId(),
    "session/create",
    { workspace: workspaceFor(cwd), mode: "yolo" },
    15000,
  );
  if (resp.error) {
    throw new Error(`zcode create failed: ${resp.error.message ?? ""}`);
  }
  const result = (resp.result ?? {}) as ZcodeCreateResult;
  const session = result.session ?? {};
  const sid = session.sessionId;
  if (!sid) throw new Error("zcode create returned no sessionId");

  server.sessionMap.set(sid, sid);
  log(`session/new → ${sid}`);

  // Sync to the App's tasks-index.sqlite so the App UI shows this session.
  // Best-effort; failures are logged inside upsertSessionTask and swallowed.
  const { upsertSessionTask } = await import("../tasks-index.js");
  void upsertSessionTask({
    workspaceKey: cwd,
    taskId: sid,
    title: session.title ?? "",
    traceId: session.traceId,
  });

  const modes = await buildModes(server, sid);
  server.lastMode.set(sid, modes.currentModeId);
  return {
    sessionId: sid,
    modes,
    configOptions: await buildConfigOptions(server, sid),
  };
}

/** `session/list` → zcode `session/list`. */
export async function listSessions(
  server: ZcodeAcpServer,
  params: acp.ListSessionsRequest,
): Promise<acp.ListSessionsResponse> {
  const backend = server.ensureBackend();
  const zcParams: Record<string, unknown> = {};
  if (params.cwd) {
    zcParams.workspace = workspaceFor(params.cwd);
  }

  const resp = await backend.request(server.nextId(), "session/list", zcParams, 15000);
  if (resp.error) throw new Error(`zcode list failed: ${resp.error.message ?? ""}`);

  const result = (resp.result ?? {}) as ZcodeListResult;
  const sessions = (result.sessions ?? []).map((s) => ({
    sessionId: s.sessionId ?? "",
    cwd: s.workspace?.workspacePath ?? "",
    title: s.title,
    updatedAt: toIso(s.updatedAt),
  }));
  log(`session/list → ${sessions.length} sessions`);
  return { sessions };
}

/** `session/resume` → zcode `session/resume` (with runtimeModel overlay for resumed sessions). */
export async function resumeSession(
  server: ZcodeAcpServer,
  params: acp.ResumeSessionRequest,
  cx: acp.AgentContext,
): Promise<acp.ResumeSessionResponse> {
  const backend = server.ensureBackend();
  const targetSid = params.sessionId;
  const cwd = params.cwd ?? process.cwd();
  if (!targetSid) throw new Error("sessionId required");

  const zcParams: Record<string, unknown> = {
    sessionId: targetSid,
    workspace: workspaceFor(cwd),
  };
  // runtimeModel overlay: a resumed session may carry a stale provider id in
  // its history → backend can't auth. Send the current enabled provider so the
  // backend overlays it and uses its own OAuth creds.
  const runtimeModel = buildResumeRuntimeModel();
  if (runtimeModel !== null) zcParams.runtimeModel = runtimeModel;
  const resp = await backend.request(server.nextId(), "session/resume", zcParams, 15000);
  if (resp.error) throw new Error(`zcode resume failed: ${resp.error.message ?? ""}`);

  server.sessionMap.set(targetSid, targetSid);
  log(`session/resume -> ${targetSid}`);
  // Initial usage_update so the editor shows the context bar immediately for a
  // resumed session (mirrors Python _on_session_resume → _emit_initial_usage).
  await emitInitialUsage(server, cx, targetSid, targetSid, getOrCreateDiffer(server, targetSid));
  const modes = await buildModes(server, targetSid);
  server.lastMode.set(targetSid, modes.currentModeId);
  return {
    modes,
    configOptions: await buildConfigOptions(server, targetSid),
  };
}

/**
 * `session/load` → zcode `session/resume` + stream conversation history back as
 * `session/update` notifications (text/reasoning/简化 tool_call).
 */
export async function loadSession(
  server: ZcodeAcpServer,
  params: acp.LoadSessionRequest,
  cx: acp.AgentContext,
): Promise<acp.LoadSessionResponse> {
  const backend = server.ensureBackend();
  const targetSid = params.sessionId;
  const cwd = params.cwd ?? process.cwd();
  if (!targetSid) throw new Error("sessionId required");

  const zcParams: Record<string, unknown> = {
    sessionId: targetSid,
    workspace: workspaceFor(cwd),
  };
  const runtimeModel = buildResumeRuntimeModel();
  if (runtimeModel !== null) zcParams.runtimeModel = runtimeModel;
  const resp = await backend.request(server.nextId(), "session/resume", zcParams, 15000);
  if (resp.error) throw new Error(`zcode resume failed: ${resp.error.message ?? ""}`);
  server.sessionMap.set(targetSid, targetSid);
  log(`session/load → ${targetSid}`);

  const messages = await fetchMessages(server, targetSid);
  let replayed = 0;
  for (const m of messages) {
    const info = m.info ?? {};
    const role = info.role;
    const mid = info.id ?? `hist_${randomUUID().slice(0, 12)}`;
    for (const p of m.parts ?? []) {
      if (!p || typeof p !== "object") continue;
      const ptype = (p as { type?: string }).type;
      if (ptype === "text") {
        const text = (p as { text?: string }).text ?? "";
        if (!text) continue;
        const sessionUpdate = role === "user" ? "user_message_chunk" : "agent_message_chunk";
        await sendSessionUpdate(cx, targetSid, {
          sessionUpdate,
          content: { type: "text", text },
          messageId: mid,
        });
      } else if (ptype === "reasoning") {
        const rp = p as { text?: string; content?: string };
        const text = rp.text ?? rp.content ?? "";
        if (text) {
          await sendSessionUpdate(cx, targetSid, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text },
            messageId: `thought_${mid}`,
          });
        }
      } else if (ptype === "tool") {
        const tp = p as {
          id?: string;
          tool?: string;
          title?: string;
          status?: string;
        };
        const title = tp.title ?? tp.tool ?? "tool call";
        const histToolName = tp.tool ?? "";
        const update: acp.SessionUpdate = {
          sessionUpdate: "tool_call",
          toolCallId: tp.id ?? `histtool_${randomUUID().slice(0, 8)}`,
          title,
          kind: "other",
          status: (tp.status as acp.ToolCallStatus) ?? "completed",
          ...(histToolName ? { _meta: { claudeCode: { toolName: histToolName } } } : {}),
        };
        await sendSessionUpdate(cx, targetSid, update);
      }
      // patch / step-start / other: skipped (history replay focuses on text + tool summary)
    }
    replayed += 1;
  }
  log(`session/load: replayed ${replayed} messages`);

  // Replay the existing todo list as an initial plan so a loaded session shows
  // its todos immediately (filter to PlanUpdate only — text/tools were already
  // replayed above and the differ hasn't mark_seen'd this history).
  try {
    const snapshot = await buildSnapshot(server, targetSid);
    const loadDiffer = getOrCreateDiffer(server, targetSid);
    const planEvents = loadDiffer.diff(snapshot).filter((e) => e.kind === "PlanUpdate");
    for (const iev of planEvents) {
      await dispatchEvent(server, cx, targetSid, iev, `load_${randomUUID().slice(0, 8)}`);
    }
  } catch (e) {
    log(
      `session/load: initial plan read failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Initial usage_update so the editor shows the context bar immediately.
  await emitInitialUsage(server, cx, targetSid, targetSid, getOrCreateDiffer(server, targetSid));

  const modes = await buildModes(server, targetSid);
  server.lastMode.set(targetSid, modes.currentModeId);
  return {
    modes,
    configOptions: await buildConfigOptions(server, targetSid),
  };
}

/** `session/prompt` → subscribe-before-send, run the event-driven turn loop. */
export async function prompt(
  server: ZcodeAcpServer,
  params: acp.PromptRequest,
  cx: acp.AgentContext,
  requestId: number,
): Promise<acp.PromptResponse> {
  const backend = server.ensureBackend();
  const zcodeSid = server.resolveSid(params.sessionId);
  if (!zcodeSid) throw new Error(`session ${params.sessionId} not found`);

  // Extract prompt text from ACP ContentBlock[].
  const text = extractPromptText(params.prompt);
  if (!text) throw new Error("empty prompt");

  // Slash-command interception: dispatches directly to ZCode methods and
  // returns end_turn without entering the turn loop. Unknown /x falls through.
  const { handleSlashCommand } = await import("./slash.js");
  const intercepted = await handleSlashCommand(server, cx, params.sessionId, zcodeSid, text);
  if (intercepted) return intercepted;

  // Preempt: if another turn is still running for this session (client sent a
  // new prompt without cancelling), stop it and wait for it to fully exit
  // before we subscribe/send. Without this, session/send hits the backend
  // prompt-lock and the error path kills the old turn but loses the new msg.
  await preemptInFlightTurn(server, zcodeSid, requestId);

  // Register the pending turn. This same object is mutated by cancel(); the
  // turn loop checks `.cancelled` on the SAME reference, so cancel propagates.
  const turn: PendingTurn = {
    zcodeSid,
    cancelled: false,
  };
  server.pendingTurns.set(requestId, turn);

  const listener = new EventStreamListener(backend, zcodeSid);
  const monitor = new TurnMonitor(backend, zcodeSid, () => server.nextId());

  // Per-session ProjectionDiffer (persists across turns). The baseline mark_seen
  // prevents the differ from re-emitting history at turn completion.
  const differ = getOrCreateDiffer(server, zcodeSid);
  const baselineMsgs = await fetchMessages(server, zcodeSid);
  differ.markSeen(baselineMsgs);

  // Subscribe BEFORE send so we don't lose early turn.completed on short turns.
  const snapshot = await listener.subscribe(() => server.nextId());
  if (snapshot === null) {
    server.pendingTurns.delete(requestId);
    throw new Error("session/subscribe failed (ZCode CLI 0.14.8+ required)");
  }
  backend.registerEventListener(zcodeSid, listener);

  const chunkMsgId = randomUUID();
  try {
    const sendResp = await backend.request(
      server.nextId(),
      "session/send",
      { sessionId: zcodeSid, content: text },
      15000,
    );
    if (sendResp.error) {
      // send failed/timeout — but backend may have started the turn anyway.
      // Stop it and probe to avoid leaking the prompt lock.
      await ensureTurnStopped(server, zcodeSid);
      throw new Error(`zcode send failed: ${sendResp.error.message ?? ""}`);
    }
    const accepted = (sendResp.result ?? {}) as { accepted?: boolean };
    if (!accepted.accepted) throw new Error("zcode send not accepted");

    // Event-driven turn loop: translate events via EventTranslator + dispatch.
    const result = await runEventTurn(
      server,
      listener,
      monitor,
      differ,
      cx,
      params.sessionId,
      chunkMsgId,
      turn,
    );

    // Session title: set once on the first end_turn of this session. The title
    // is the first prompt text (truncated). Subsequent turns never overwrite it
    // (set-once gate), and the App's title_overridden flag always wins.
    if (result.stopReason === "end_turn" && !server.sessionTitles.has(params.sessionId)) {
      const title = text.slice(0, 80);
      server.sessionTitles.set(params.sessionId, title);
      const { updateSessionTitle } = await import("../tasks-index.js");
      void updateSessionTitle(zcodeSid, title);
      await sendSessionUpdate(cx, params.sessionId, {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date().toISOString(),
      });
    }

    return result;
  } finally {
    backend.unregisterEventListener(zcodeSid);
    server.pendingTurns.delete(requestId);
  }
}

/**
 * `session/set_config_option` → dispatch model/mode/thought and emit the
 * resulting config_option_update (+ current_mode_update for mode).
 */
export async function setConfigOptionHandler(
  server: ZcodeAcpServer,
  params: acp.SetSessionConfigOptionRequest,
  cx: acp.AgentContext,
): Promise<acp.SetSessionConfigOptionResponse> {
  const zcodeSid = server.resolveSid(params.sessionId);
  if (!zcodeSid) throw new Error(`session ${params.sessionId} not found`);
  if (typeof params.value !== "string") {
    throw new Error(`unsupported config value type: ${String(params.value)}`);
  }
  const { setConfigOption, emitConfigOptionUpdate } = await import("../config/options.js");
  const result = await setConfigOption(server, zcodeSid, params.configId, params.value);
  if (!result) {
    throw new Error(`unsupported config option or switch failed: ${params.configId}`);
  }
  const options = await emitConfigOptionUpdate(server, cx, params.sessionId, zcodeSid, result.kind);
  return { configOptions: options };
}

/**
 * `session/cancel` → mark the pending turn cancelled. The turn loop observes
 * the flag and forwards `session/stop` itself (mirrors Python: cancel only
 * sets the flag; stop is sent by `_run_event_turn`). Eagerly sending stop
 * here would race with a turn that already completed.
 */
export async function cancel(
  server: ZcodeAcpServer,
  params: acp.CancelNotification,
): Promise<void> {
  const zcodeSid = server.resolveSid(params.sessionId);
  if (!zcodeSid) return;
  for (const [, turn] of server.pendingTurns) {
    if (turn.zcodeSid === zcodeSid) {
      turn.cancelled = true;
      break; // one turn per session at a time
    }
  }
  log(`session/cancel → ${zcodeSid}`);
}

/**
 * Send `session/stop` and probe until the prompt lock is confirmed released.
 *
 * `session/stop` is fire-and-forget, but ZCode has a startup delay: when stop
 * arrives before the turn truly holds the lock, the backend ignores it and the
 * turn runs on, leaking the lock — the next `session/send` then fails with
 * "A prompt is already running". Mirrors the `expectLock:true` strategy from
 * `waitForTurnIdle` (extensions.ts) but adapted for the cancel path.
 *
 * Strategy:
 *  1. send `session/stop`
 *  2. poll `session/goal show`; first REQUIRE seeing "prompt is running" once
 *     (proves the turn started), then wait for it to clear
 *  3. if the grace window (8s) elapses without ever seeing the lock, the turn
 *     never started (stop caught it in time) or already ended → treat as released
 *  4. hard timeout 30s
 *
 * Best-effort: never throws (failures only log) so it can't break the cancel
 * path. Returns true if released, false on timeout.
 */
async function ensureTurnStopped(server: ZcodeAcpServer, zcodeSid: string): Promise<boolean> {
  const backend = server.ensureBackend();
  backend.notify("session/stop", { sessionId: zcodeSid });
  const t0 = Date.now();
  const GRACE_MS = 8_000;
  const HARD_TIMEOUT_MS = 30_000;
  let lockSeen = false;
  while (Date.now() - t0 < HARD_TIMEOUT_MS) {
    const resp = await backend.request(
      server.nextId(),
      "session/goal",
      { sessionId: zcodeSid, action: "show" },
      10000,
    );
    const errMsg = resp.error?.message ?? "";
    if (errMsg.includes("prompt is running")) {
      lockSeen = true;
      await sleep(2000);
      continue;
    }
    if (errMsg.toLowerCase().includes("timeout")) {
      await sleep(2000);
      continue;
    }
    // Non-lock error or success.
    if (lockSeen) {
      log(`  [stop] prompt lock released`);
      return true;
    }
    // Haven't seen the lock yet — give the turn a grace window to start.
    if (Date.now() - t0 < GRACE_MS) {
      await sleep(500);
      continue;
    }
    // Grace window expired without ever seeing the lock: turn never started
    // (stop caught it in time) or already ended. Safe to treat as released.
    log(`  [stop] no lock observed within grace window, treating as released`);
    return true;
  }
  log(`  [stop] lock wait timed out (30s), lock may still be held`);
  return false;
}

/**
 * If another prompt() is already running for this zcodeSid, treat the new
 * prompt as an implicit cancel: stop the in-flight turn and wait for it to
 * fully exit (lock released + listener unregistered + pendingTurns cleaned)
 * before the new prompt subscribes and sends.
 *
 * Why wait for the map entry to disappear (not just the lock): registering
 * a second EventStreamListener overwrites the first (Map.set in client.ts),
 * so the old turn loop must have run its finally block before we subscribe.
 * The map cleanup in that finally block is the synchronization point.
 *
 * Best-effort: never throws. On timeout, continues anyway — session/send
 * will then hit the lock and take the existing error path.
 */
async function preemptInFlightTurn(
  server: ZcodeAcpServer,
  zcodeSid: string,
  selfRequestId: number,
): Promise<void> {
  // Find any in-flight turn for this session that isn't this request.
  let oldRequestId: number | undefined;
  for (const [reqId, turn] of server.pendingTurns) {
    if (turn.zcodeSid === zcodeSid && reqId !== selfRequestId) {
      oldRequestId = reqId;
      turn.cancelled = true; // signal the old turn loop to exit
      break;
    }
  }
  if (oldRequestId === undefined) return; // no in-flight turn, proceed

  log(`  [preempt] in-flight turn ${oldRequestId} found, stopping it`);
  // Stop the backend turn and wait for the prompt lock to release.
  await ensureTurnStopped(server, zcodeSid);

  // Wait for the old turn's prompt() to fully exit (its finally block deletes
  // the pendingTurns entry). This is the synchronization point that guarantees
  // its listener is unregistered before we register ours.
  const PREEMPT_TIMEOUT_MS = 35_000; // slightly longer than ensureTurnStopped's 30s
  const t0 = Date.now();
  while (server.pendingTurns.has(oldRequestId)) {
    if (Date.now() - t0 > PREEMPT_TIMEOUT_MS) {
      log(`  [preempt] timed out waiting for old turn ${oldRequestId} to exit`);
      return; // best-effort: continue anyway, session/send may fail
    }
    await sleep(200);
  }
  log(`  [preempt] old turn ${oldRequestId} exited, proceeding`);
}

// ---------- internals ----------

/** Concatenate text from ACP ContentBlocks into a prompt string. */
function extractPromptText(blocks: acp.ContentBlock[] | undefined): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    const b = block as {
      type?: string;
      text?: string;
      resource_link?: { name?: string; uri?: string };
    };
    if (b.type === "text" && b.text) {
      parts.push(b.text);
    } else if (b.type === "resource_link" && b.resource_link) {
      parts.push(
        `[related resource: ${b.resource_link.name ?? b.resource_link.uri ?? ""}](${b.resource_link.uri ?? ""})`,
      );
    }
  }
  return parts.join("\n").trim();
}

/** Fetch session/messages from zcode. */
async function fetchMessages(server: ZcodeAcpServer, zcodeSid: string): Promise<ZcodeMessage[]> {
  const backend = server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/messages",
    { sessionId: zcodeSid },
    8000,
  );
  if (resp.error) return [];
  const result = (resp.result ?? {}) as ZcodeMessagesResult;
  return result.messages ?? [];
}

/** Get or create the session-level ProjectionDiffer (persists across turns). */
function getOrCreateDiffer(server: ZcodeAcpServer, zcodeSid: string): ProjectionDiffer {
  let d = server.differs.get(zcodeSid);
  if (!d) {
    d = new ProjectionDiffer();
    server.differs.set(zcodeSid, d);
  }
  const differ = d as ProjectionDiffer;
  differ.resetTurn();
  return differ;
}

/**
 * Event-driven turn loop: translate zcode events via EventTranslator and
 * dispatch each internal event to the ACP client. No-progress timeout is 120s
 * (refreshed by any event). Cancel is honoured on each iteration.
 *
 * Server→client requests (interaction/*) are drained each iteration; full
 * handling (requestPermission / ExitPlanMode / AskUserQuestion) lands in
 * Commit 6 — for now they're polled to keep the inbox clear.
 */
async function runEventTurn(
  server: ZcodeAcpServer,
  listener: EventStreamListener,
  monitor: TurnMonitor,
  differ: ProjectionDiffer,
  cx: acp.AgentContext,
  acpSid: string,
  chunkMsgId: string,
  turn: PendingTurn,
): Promise<acp.PromptResponse> {
  const backend = server.ensureBackend();
  const translator = new EventTranslator();
  differ.resetTurn();
  const NO_PROGRESS_MS = 120_000;
  let lastProgress = Date.now();
  let lastStallCheck = Date.now();
  let emittedText = false;
  let emittedOutput = false;

  while (Date.now() - lastProgress < NO_PROGRESS_MS) {
    // Drain + handle server→client requests (interaction/*). Refreshes the
    // no-progress timer when any are handled. Pass `turn` so interaction
    // requests become turn-cancel aware (user stop aborts pending popups).
    if (await handleServerRequests(server, backend, cx, acpSid, turn)) {
      lastProgress = Date.now();
    }

    if (turn.cancelled) {
      await ensureTurnStopped(server, turn.zcodeSid);
      return { stopReason: "cancelled" };
    }

    const ev = await listener.pollEvent(500);
    if (ev === null) {
      // Stall reconciliation: probe authoritative status after 15s of silence.
      if (
        translator.turnStarted &&
        Date.now() - lastProgress > 15_000 &&
        Date.now() - lastStallCheck > 15_000
      ) {
        lastStallCheck = Date.now();
        const proj = await monitor.pollOnce();
        if (proj?.status === "idle") {
          // Turn completed but the event was lost.
          if (!emittedText) {
            const reply = await fetchLastReply(server, turn.zcodeSid, differ);
            if (reply) {
              await sendTextChunk(cx, acpSid, reply, chunkMsgId);
            } else if (!emittedOutput) {
              // No text and no output → suspected failure.
              await ensureTurnStopped(server, turn.zcodeSid);
              throw new RequestError(-32603, "turn produced no output");
            }
          }
          return { stopReason: "end_turn" };
        }
        if (proj?.status === "running") {
          lastProgress = Date.now();
          await listener.resubscribe(() => server.nextId());
        }
      }
      continue;
    }

    lastProgress = Date.now();
    const internalEvents = translator.translate(ev);
    for (const iev of internalEvents) {
      if (iev.kind === "TextDelta") emittedText = true;
      if (iev.kind === "ToolCallNew" || iev.kind === "ToolCallUpdate") emittedOutput = true;
      // Sync usage to the differ so the turn-completion diff doesn't re-emit a
      // UsageDelta for the same value (the differ's lastUsage baseline is
      // otherwise only set by its own diff / emitInitialUsage).
      if (iev.kind === "UsageDelta") differ.setLastUsage(iev.used);
      await dispatchEvent(server, cx, acpSid, iev, chunkMsgId);
    }

    // Edit/Write diff eager dispatch: on tool.updated result for Edit/Write,
    // grab the structured patch from session/messages immediately (don't wait
    // for turn completion — model rate-limiting could delay it indefinitely).
    if (ev.type === "tool.updated") {
      const payload = ev.payload as { kind?: string; toolCallId?: string; toolName?: string };
      if (
        payload.kind === "result" &&
        payload.toolCallId &&
        (payload.toolName === "Edit" ||
          payload.toolName === "Write" ||
          payload.toolName === "edit" ||
          payload.toolName === "write")
      ) {
        await dispatchEditDiff(
          server,
          cx,
          acpSid,
          turn.zcodeSid,
          payload.toolCallId,
          differ,
          chunkMsgId,
        );
      }
    }

    // Sync translator → differ seen-tool-ids so the turn-completion differ.diff
    // doesn't re-emit tools the event path already sent (which would clear
    // Bash terminal output via a content-less ToolCallNew through the terminal
    // path). Without this, Bash output is wiped on the next turn.
    for (const seenId of translator.seenToolIds) {
      differ.markToolSeen(seenId);
    }

    if (translator.turnDone) {
      // Cancel signalled via turn.completed(resultType:"cancelled").
      if (translator.turnResultType === "cancelled") {
        await ensureTurnStopped(server, turn.zcodeSid);
        return { stopReason: "cancelled" };
      }
      if (translator.turnFailed) {
        await ensureTurnStopped(server, turn.zcodeSid);
        throw new RequestError(-32603, formatTurnError(translator.turnError));
      }
      // Fallback: if no text streamed, surface the last assistant reply.
      if (!emittedText) {
        const reply = await fetchLastReply(server, turn.zcodeSid, differ);
        if (reply) await sendTextChunk(cx, acpSid, reply, chunkMsgId);
      }
      // Turn-completion diff: emits PlanUpdate (todos) + final usage_update,
      // reconciles any snapshot-only tool events.
      //
      // TextDelta and ReasoningDelta are deliberately filtered out here: the
      // event path already streamed the assistant reply and reasoning via
      // model.streaming (chunkMsgId). The differ's seenMessageIds dedup cannot
      // bridge the two paths because they use different id spaces — the
      // streaming path uses a client-generated chunkMsgId while the differ
      // keys on the backend's message info.id. Without this filter the whole
      // reply and reasoning are dispatched a second time. `fetchLastReply`
      // above already covers the case where the event path delivered no text.
      const snapshot = await buildSnapshot(server, turn.zcodeSid);
      const completionEvents = differ.diff(snapshot);
      for (const iev of completionEvents) {
        if (iev.kind === "TextDelta" || iev.kind === "ReasoningDelta") continue;
        await dispatchEvent(server, cx, acpSid, iev, chunkMsgId);
      }
      // Mode reconciliation: an in-turn tool (EnterPlanMode/ExitPlanMode) can
      // switch the session mode without the bridge intermediating, so no
      // session/setMode notification fires. Re-read the authoritative mode and
      // push current_mode_update + config_option_update when it changed since
      // the last value advertised to the client.
      await emitModeIfChanged(server, cx, acpSid, turn.zcodeSid);
      return { stopReason: "end_turn" };
    }
  }

  // 120s no progress: abandon.
  await ensureTurnStopped(server, turn.zcodeSid);
  return { stopReason: "max_turn_requests" };
}

/**
 * Fetch the last assistant message text as a fallback for lost text events.
 *
 * Retries up to 4 times with a short delay because zcode has a data-consistency
 * window after `status:idle` where `session/messages` may not yet include the
 * just-finished reply. Skips assistant messages the differ already saw (by
 * dedup key) so a previous turn's reply is never re-emitted as this turn's.
 */
async function fetchLastReply(
  server: ZcodeAcpServer,
  zcodeSid: string,
  differ: ProjectionDiffer,
): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const messages = await fetchMessages(server, zcodeSid);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.info?.role !== "assistant") continue;
      // Skip messages the differ already processed (previous turns).
      if (differ.hasSeenMessage(m)) continue;
      for (let j = (m.parts ?? []).length - 1; j >= 0; j--) {
        const p = m.parts[j];
        if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
          const text = (p as { text?: string }).text ?? "";
          if (text.trim()) return text;
        }
      }
    }
    if (attempt < 3) await sleep(400);
  }
  return null;
}

/**
 * Flatten the todos payload from `session/read`. Prefers the top-level `todos`;
 * when empty, flattens `todoGroups` — the real backend dump carries todos as a
 * list of groups (each with `entries` or `todos`), not a single object. Mirrors
 * Python `_build_snapshot`. Exported for unit testing.
 */
export function flattenTodos(
  todos: unknown[] | undefined,
  todoGroups: Array<{ entries?: unknown[]; todos?: unknown[] }> | undefined,
): unknown[] {
  const top = todos ?? [];
  if (top.length > 0 || !Array.isArray(todoGroups)) return top;
  let flat: unknown[] = [];
  for (const g of todoGroups) {
    if (!g) continue;
    flat = flat.concat(g.entries ?? g.todos ?? []);
  }
  return flat;
}

/** Build a {projection, messages, todos} snapshot from session/messages + session/read. */
async function buildSnapshot(server: ZcodeAcpServer, zcodeSid: string): Promise<ZcodeSnapshot> {
  const backend = server.ensureBackend();
  const [msgs, readResp] = await Promise.all([
    fetchMessages(server, zcodeSid),
    backend.request(server.nextId(), "session/read", { sessionId: zcodeSid }, 8000),
  ]);
  const read = (readResp.result ?? {}) as {
    projection?: ZcodeSnapshot["projection"];
    todos?: unknown[];
    todoGroups?: Array<{ entries?: unknown[]; todos?: unknown[] }>;
  };
  const todos = flattenTodos(read.todos, read.todoGroups);
  return { projection: read.projection, messages: msgs, todos };
}

/**
 * Re-read the authoritative session mode and, if it changed since the last
 * value advertised to the client, emit `current_mode_update` +
 * `config_option_update`. Covers in-turn mode switches performed by internal
 * tools (EnterPlanMode/ExitPlanMode) that bypass `session/setMode` and thus
 * emit no notification of their own. Best-effort: failures are logged and
 * swallowed so they never break the turn-completion path.
 */
async function emitModeIfChanged(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
): Promise<void> {
  try {
    const modes = await buildModes(server, zcodeSid);
    const last = server.lastMode.get(acpSid);
    if (last === modes.currentModeId) return;
    server.lastMode.set(acpSid, modes.currentModeId);
    const options = await buildConfigOptions(server, zcodeSid);
    await sendSessionUpdate(cx, acpSid, {
      sessionUpdate: "config_option_update",
      configOptions: options,
    });
    await sendSessionUpdate(cx, acpSid, {
      sessionUpdate: "current_mode_update",
      currentModeId: modes.currentModeId,
    });
    log(`session/prompt: mode changed → ${modes.currentModeId}`);
  } catch (e) {
    log(`emitModeIfChanged failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Edit/Write result → grab the structured patch from session/messages and emit
 * a ToolCallUpdate with diff content immediately (don't wait for turn
 * completion — model rate-limiting could delay it indefinitely). Always marks
 * the tool seen in the differ so turn-completion diff won't re-emit it.
 */
async function dispatchEditDiff(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  callId: string,
  differ: ProjectionDiffer,
  chunkMsgId: string,
): Promise<void> {
  const messages = await fetchMessages(server, zcodeSid);
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (!p || typeof p !== "object") continue;
      const part = p as Record<string, unknown>;
      const partCallId = String(part["callID"] ?? part["callId"] ?? "");
      if (partCallId !== callId) continue;
      const state = (part["state"] as Record<string, unknown>) ?? {};
      const display = (state["metadata"] as Record<string, unknown> | undefined)?.["display"];
      const diffContent = buildDiffContent(display);
      const locations = extractLocations(String(part["tool"] ?? ""), state["input"], display);
      const ev: InternalEvent = {
        kind: "ToolCallUpdate",
        callId,
        tool: String(part["tool"] ?? ""),
        status: "completed",
        diffContent: diffContent.length > 0 ? diffContent : undefined,
        locations: locations.length > 0 ? locations : undefined,
      };
      if (diffContent.length > 0 || locations.length > 0) {
        await dispatchEvent(server, cx, acpSid, ev, chunkMsgId);
      }
      differ.markToolSeen(callId);
      return;
    }
  }
  differ.markToolSeen(callId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
