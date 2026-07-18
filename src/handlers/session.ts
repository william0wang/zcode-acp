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
import { log, warn } from "../utils.js";
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

  server.registerSession(sid, sid);
  // Only freshly-created sessions are eligible for auto-title on first
  // end_turn; resumed/loaded sessions already have a title and must keep it.
  server.titleEligibleSessions.add(sid);
  log(`session/new → ${sid}`);
  server.ensureBackgroundListener(sid);

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

  server.registerSession(targetSid, targetSid);
  log(`session/resume -> ${targetSid}`);
  server.ensureBackgroundListener(targetSid);
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
  server.registerSession(targetSid, targetSid);
  log(`session/load → ${targetSid}`);
  server.ensureBackgroundListener(targetSid);

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

  // Register self + preempt others under a per-session lock. The lock
  // serializes the critical section so that two concurrent prompts (B, C) for
  // the same session can't both miss each other and register at once: C waits
  // for B's section, by which point B is in pendingTurns, so C's preempt finds
  // and cancels B. Registering INSIDE the lock is what makes the new turn
  // visible to the next prompt's preempt scan.
  const turn: PendingTurn = {
    zcodeSid,
    cancelled: false,
  };
  await withPreemptLock(server, zcodeSid, () => {
    server.pendingTurns.set(requestId, turn);
    return preemptInFlightTurn(server, zcodeSid, requestId);
  });

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
      // send failed/timeout. Don't fire stop here: a send failure usually
      // means the turn never started (no lock to leak). Mirrors Python which
      // just returns the error without stopping.
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

    // Session title: set once on the first end_turn, but ONLY for freshly
    // created sessions. Resumed/loaded sessions already carry a title from
    // their history and must not be overwritten by the first post-load message.
    // sessionTitles enforces set-once within a session; titleEligibleSessions
    // gates which sessions are titled at all.
    if (
      result.stopReason === "end_turn" &&
      server.titleEligibleSessions.has(params.sessionId) &&
      !server.sessionTitles.has(params.sessionId)
    ) {
      // Title = first non-empty line of the prompt, truncated to 80 chars.
      // Multi-line prompts must not leak newlines into the session title.
      // Split on any line break (\r\n, \n, \r) so all platforms are covered.
      const title =
        text
          .split(/\r\n|\r|\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0)
          ?.slice(0, 80) ?? text.slice(0, 80);
      server.sessionTitles.set(params.sessionId, title);
      const { updateSessionTitle } = await import("../tasks-index.js");
      void updateSessionTitle(zcodeSid, title, text);
      await sendSessionUpdate(cx, params.sessionId, {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date().toISOString(),
      });
    }

    // Auto-compact: if context usage exceeds the threshold, compact before
    // returning so the next prompt has room. Configured via
    // ZCODE_ACP_AUTO_COMPACT_THRESHOLD (absolute token count; 0/unset = disabled).
    // Only on end_turn — cancelled/max_turn_requests skips compaction.
    // Best-effort: failures are logged inside maybeAutoCompact, never thrown.
    if (result.stopReason === "end_turn") {
      const { maybeAutoCompact } = await import("../config/auto-compact.js");
      await maybeAutoCompact(server, cx, params.sessionId, zcodeSid);
    }

    return result;
  } finally {
    backend.unregisterEventListener(zcodeSid, listener);
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
 * Fire-and-forget `session/stop` to the backend. Mirrors Python's
 * `_cancel_backend_turn`: send stop with an id (some backends route by id
 * presence), never wait for a response, never throw.
 *
 * The backend's turn loop will emit turn.completed(cancelled) on its own;
 * the ACP turn loop observes that event and exits. No probing needed on the
 * prompt path — an earlier ensureTurnStopped probed session/goal show for 30s
 * but returned inconsistent values and caused severe stalls.
 */
function stopBackendTurn(server: ZcodeAcpServer, zcodeSid: string): void {
  try {
    server.ensureBackend().send("session/stop", { sessionId: zcodeSid });
  } catch (e) {
    log(
      `  [stop] session/stop send failed (ignored): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Serialize a per-session critical section. Each section awaits the previous
 * one's promise before running, so concurrent prompts for the same session
 * execute register+preempt strictly one after another.
 *
 * Used by prompt() to wrap "register self in pendingTurns + preempt others":
 * the registration must land before the section releases, so the next prompt
 * entering its section sees this turn in its preempt scan. Without this lock,
 * two near-simultaneous prompts could both scan before either registers.
 *
 * The body may be async and long-running (preempt waits up to 35s for the old
 * turn to exit); that is acceptable because the turn loop itself runs OUTSIDE
 * this lock — only registration + preempt-in-wait are serialized.
 */
function withPreemptLock(
  server: ZcodeAcpServer,
  zcodeSid: string,
  body: () => Promise<void>,
): Promise<void> {
  const prev = server.preemptLocks.get(zcodeSid) ?? Promise.resolve();
  const next = prev.then(body, body); // run body regardless of prior rejection
  server.preemptLocks.set(zcodeSid, next);
  // Clean up the entry once settled so a later idle session doesn't retain a
  // dangling promise. Only delete if still ours (a newer section may have
  // chained on top of us). The `.catch` swallows any rejection propagated by
  // `finally` (it returns a new promise that rejects if `next` rejected) —
  // otherwise Node would raise an UnhandledPromiseRejection and crash.
  next
    .finally(() => {
      if (server.preemptLocks.get(zcodeSid) === next) {
        server.preemptLocks.delete(zcodeSid);
      }
    })
    .catch(() => {
      /* body rejection already surfaced by the returned `next`; swallow here */
    });
  return next;
}

/**
 * Cancel any other in-flight turn for this zcodeSid and wait for it to fully
 * exit (listener unregistered + pendingTurns cleaned) before returning.
 *
 * Must be called from inside a preempt lock section (the caller has already
 * registered itself in pendingTurns), so a concurrent prompt entering its own
 * section is guaranteed to see this caller's turn and cancel it.
 *
 * Why wait for the map entry to disappear (not just fire stop): registering
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
  // Fire-and-forget stop (mirrors Python's _cancel_backend_turn). The old
  // turn loop will receive turn.completed(cancelled) and exit on its own.
  stopBackendTurn(server, zcodeSid);

  // Wait for the old turn's prompt() to fully exit (its finally block deletes
  // the pendingTurns entry). This is the synchronization point that guarantees
  // both lock release (backend turn ended) and listener unregistration before
  // we subscribe/send. More reliable than probing session/goal show.
  const PREEMPT_TIMEOUT_MS = 35_000;
  const t0 = Date.now();
  while (server.pendingTurns.has(oldRequestId)) {
    if (Date.now() - t0 > PREEMPT_TIMEOUT_MS) {
      warn(`  [preempt] timed out waiting for old turn ${oldRequestId} to exit`);
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
      stopBackendTurn(server, turn.zcodeSid);
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
              stopBackendTurn(server, turn.zcodeSid);
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

    // Edit/Write diff eager dispatch: on tool.updated result, grab the
    // structured patch from session/messages immediately (don't wait for turn
    // completion — model rate-limiting could delay it indefinitely).
    //
    // Newer ZCode backends omit toolName on "result" events (only "scheduled"
    // and "started" carry it), so we no longer filter by tool name here —
    // dispatchEditDiff itself checks the tool part's display and skips
    // non-file-diff tools harmlessly.
    if (ev.type === "tool.updated") {
      const payload = ev.payload as { kind?: string; toolCallId?: string };
      if (payload.kind === "result" && payload.toolCallId) {
        // Fire edit-diff and plan-sync in parallel — they hit independent
        // backend methods (session/messages vs session/read) so there's no
        // ordering dependency between them.
        await Promise.all([
          dispatchEditDiff(
            server,
            cx,
            acpSid,
            turn.zcodeSid,
            payload.toolCallId,
            differ,
            chunkMsgId,
          ),
          // Push plan (TODO list) updates immediately on tool completion so the
          // editor doesn't lag behind — without this, TODO changes only surface at
          // turn completion, which can be delayed by the model's remaining output.
          dispatchPlanIfChanged(server, cx, acpSid, turn.zcodeSid, differ, chunkMsgId),
        ]);
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
      // Cancel signalled via turn.completed(resultType:"cancelled"). The
      // backend turn has already ended and released the lock — no stop needed.
      if (translator.turnResultType === "cancelled") {
        return { stopReason: "cancelled" };
      }
      if (translator.turnFailed) {
        // Best-effort stop in case the failed turn left a residual lock.
        stopBackendTurn(server, turn.zcodeSid);
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
  stopBackendTurn(server, turn.zcodeSid);
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
    warn(`emitModeIfChanged failed: ${e instanceof Error ? e.message : String(e)}`);
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

/**
 * Read the authoritative todos from `session/read` and push a PlanUpdate if the
 * signature changed since the last check. Called mid-turn (right after each
 * tool completes) so the editor sees TODO updates immediately instead of
 * waiting for turn completion — the turn-completion diff would otherwise lag
 * behind by the rest of the model's output.
 *
 * Uses a lightweight `session/read` (no session/messages fetch). Failures are
 * logged and swallowed: plan staleness is cosmetic, not worth crashing the turn.
 */
async function dispatchPlanIfChanged(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  differ: ProjectionDiffer,
  chunkMsgId: string,
): Promise<void> {
  try {
    const backend = server.ensureBackend();
    const readResp = await backend.request(
      server.nextId(),
      "session/read",
      { sessionId: zcodeSid },
      8000,
    );
    const read = (readResp.result ?? {}) as {
      todos?: unknown[];
      todoGroups?: Array<{ entries?: unknown[]; todos?: unknown[] }>;
    };
    const todos = flattenTodos(read.todos, read.todoGroups);
    const events = differ.diffPlan(todos);
    for (const iev of events) {
      await dispatchEvent(server, cx, acpSid, iev, chunkMsgId);
    }
  } catch (e) {
    log(`dispatchPlanIfChanged: skipped (${e instanceof Error ? e.message : String(e)})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
