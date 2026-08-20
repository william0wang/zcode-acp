/**
 * Session lifecycle handlers: initialize, new, list, resume, load, prompt, cancel.
 *
 * These map ACP session methods to ZCode app-server calls. `session/new` is
 * lazy: it returns a placeholder id and defers zcode `session/create` to the
 * session's first use (`ensureRealSession`), so an editor startup that never
 * prompts leaves no empty session in the backend or the App's task index.
 * `session/prompt` runs the event-driven turn loop (subscribe-before-send
 * ordering, no-progress timeout, stall reconciliation). ZCode events are
 * translated via EventTranslator and dispatched as ACP `session/update`
 * notifications.
 */

import process from "node:process";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

import { EventStreamListener, TurnMonitor } from "../backend/listener.js";
import type { ZcodeCreateResult, ZcodeListResult, ZcodeSnapshot } from "../backend/types.js";
import { buildModes, buildConfigOptions } from "../config/options.js";
import { emitInitialUsage } from "../config/model-cache.js";
import { buildProviderRegistry } from "../config/provider-registry.js";
import { buildResumeRuntimeModel } from "../config/runtime-model.js";
import {
  lookupLazySession,
  recordMaterializedSession,
  rememberLazySession,
} from "../lazy-sessions.js";
import {
  buildDiffContent,
  EventTranslator,
  extractLocations,
  formatTurnError,
  isTransientTurnError,
  ProjectionDiffer,
} from "../translators/index.js";
import type { InternalEvent } from "../translators/index.js";
import { log, warn } from "../utils.js";
import type { PendingTurn, ZcodeAcpServer } from "../server.js";
import { dispatchEvent } from "./dispatch.js";
import { sendSessionUpdate, sendTextChunk, withReplayBatch } from "./io.js";
import { fetchMessages, fullSlice, readTailLimit, replayMessages, sliceTail } from "./replay.js";
import { handleServerRequests } from "./server-requests.js";

/** Workspace descriptor used in session create/resume calls. */
function workspaceFor(cwd?: string): { workspacePath: string; workspaceKey: string } {
  const p = cwd || process.cwd();
  return { workspacePath: p, workspaceKey: p };
}

/**
 * Push the provider registry to the backend so third-party providers (those in
 * config.json) are recognised. The V4 backend doesn't auto-load them from
 * config.json — without this RPC a session switching to a third-party model
 * fails with `provider_not_configured`. Best-effort: failures are logged, not
 * thrown, so a registry push problem never blocks session creation.
 */
async function syncProviderRegistry(server: ZcodeAcpServer, cwd: string): Promise<void> {
  try {
    const registry = buildProviderRegistry();
    const resp = await server
      .ensureBackend()
      .request(
        server.nextId(),
        "workspace/updateProviderRegistry",
        { workspace: workspaceFor(cwd), registry },
        10000,
      );
    if (resp.error) {
      warn(`provider-registry: sync failed: ${resp.error.message}`);
      return;
    }
    log("provider-registry: synced to backend");
  } catch (e) {
    warn(`provider-registry: sync threw (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Convert a millisecond timestamp to ISO 8601 (for session list). */
function toIso(ms: number | undefined): string | undefined {
  if (typeof ms !== "number") return undefined;
  return new Date(ms).toISOString();
}

/**
 * `session/new` → local placeholder id. The real zcode `session/create` is
 * deferred to first use (`ensureRealSession`) so an editor startup that never
 * sends a message leaves no empty session in the backend or the App's task
 * index. The created session uses mode yolo (hardcoded).
 */
export async function newSession(
  server: ZcodeAcpServer,
  params: acp.NewSessionRequest,
): Promise<acp.NewSessionResponse> {
  const cwd = params.cwd ?? process.cwd();
  // Placeholder id — the client addresses this session with it until the
  // backend session materializes; never shown in session/list.
  const acpSid = randomUUID();
  server.pendingSessions.set(acpSid, { cwd, mcpServers: params.mcpServers });
  // Persists past materialization (pendingSessions is cleared on first use) so
  // the remote discovery payload can still label the workspace.
  server.sessionCwds.set(acpSid, cwd);
  // Durable alias so the placeholder survives a bridge restart and session/
  // resume can still resolve it (best-effort; failures are swallowed inside
  // the store).
  rememberLazySession(acpSid, cwd);
  // Only freshly-created sessions are eligible for auto-title on first
  // end_turn; resumed/loaded sessions already have a title and must keep it.
  server.titleEligibleSessions.add(acpSid);
  log(`session/new (lazy) → ${acpSid} cwd=${cwd}`);

  // No backend RPC yet: modes/configOptions are built from defaults (the
  // pending session's real values arrive via updates once materialized).
  const modes = await buildModes(server, null);
  server.lastMode.set(acpSid, modes.currentModeId);
  return {
    sessionId: acpSid,
    modes,
    configOptions: await buildConfigOptions(server, null),
  };
}

/**
 * Materialize a lazy `session/new` placeholder into a real backend session on
 * first use (prompt / set_config_option / extension methods). Idempotent:
 * returns the existing mapping for already-created sessions, and concurrent
 * first-uses share a single `session/create` via the pending entry's `creating`
 * promise. Unknown ids throw.
 */
export async function ensureRealSession(server: ZcodeAcpServer, acpSid: string): Promise<string> {
  const existing = server.resolveSid(acpSid);
  if (existing) return existing;
  let pending = server.pendingSessions.get(acpSid);
  if (!pending) {
    // Placeholder from a previous bridge lifetime: recover it from the durable
    // store. A record that already carries a zcodeSid maps straight through
    // (the backend session still exists — re-register the alias); one without
    // re-hydrates the pending entry so the create path below runs.
    const record = lookupLazySession(acpSid);
    if (record?.zcodeSid) {
      server.registerSession(acpSid, record.zcodeSid);
      return record.zcodeSid;
    }
    if (record) {
      pending = { cwd: record.cwd };
      server.pendingSessions.set(acpSid, pending);
      server.sessionCwds.set(acpSid, record.cwd);
    }
  }
  if (!pending) throw new Error(`session ${acpSid} not found`);
  if (pending.creating) return pending.creating;

  // The create body runs synchronously up to its first await, so the `creating`
  // promise is stored before any concurrent caller can observe the entry.
  const creating = (async () => {
    const backend = server.ensureBackend();
    // Push the provider registry BEFORE session/create: the backend resolves
    // the session's default model against the registry, and without the
    // provider's reasoning/model definitions it falls back to the bare
    // anthropic channel (2-state thought: enabled/disabled) instead of the
    // real provider (max/high/low). Also covers third-party providers for
    // later model switches (provider_not_configured). Best-effort — a failed
    // push logs and continues, the session still works over the fallback.
    await syncProviderRegistry(server, pending.cwd);
    // Client-provided MCP servers (ACP session/new mcpServers) ride along
    // when the lazy session materializes. The backend accepts the ACP array
    // shape verbatim; the verified merge behaviour is additive (client
    // entries appear next to the runtime's own local config). Same-name
    // clash behaviour is the backend's own and unasserted here.
    const createParams: Record<string, unknown> = {
      workspace: workspaceFor(pending.cwd),
      mode: "yolo",
    };
    if (pending.mcpServers && pending.mcpServers.length > 0) {
      createParams.mcpServers = pending.mcpServers;
      log(`session/create carrying ${pending.mcpServers.length} client MCP server(s)`);
    }
    const resp = await backend.request(server.nextId(), "session/create", createParams, 15000);
    if (resp.error) {
      throw new Error(`zcode create failed: ${resp.error.message ?? ""}`);
    }
    const result = (resp.result ?? {}) as ZcodeCreateResult;
    const session = result.session ?? {};
    const sid = session.sessionId;
    if (!sid) throw new Error("zcode create returned no sessionId");

    server.pendingSessions.delete(acpSid);
    server.registerSession(acpSid, sid);
    // session/create loads the session into this backend process.
    server.backendLoadedSessions.add(acpSid);
    // Keep the durable alias in sync so a later bridge restart can still
    // resume this session via the placeholder id.
    recordMaterializedSession(acpSid, sid, pending.cwd);
    log(`session/new ${acpSid} → created ${sid} (lazy, on first use)`);
    server.ensureBackgroundListener(sid);

    // Sync to the App's tasks-index.sqlite so the App UI shows this session.
    // Best-effort; failures are logged inside upsertSessionTask and swallowed.
    const { upsertSessionTask } = await import("../tasks-index.js");
    void upsertSessionTask({
      workspaceKey: pending.cwd,
      taskId: sid,
      title: session.title ?? "",
      traceId: session.traceId,
    });

    return sid;
  })();
  pending.creating = creating;
  try {
    return await creating;
  } finally {
    // Reset the in-flight marker (on success the sessionMap short-circuits
    // later calls; on failure this lets the next use retry the create).
    pending.creating = undefined;
  }
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

/**
 * Adopt the backend's stored title for a loaded/resumed session.
 *
 * The prompt loop's auto-title only fires for freshly created sessions
 * (`titleEligibleSessions`), so a session resumed across a bridge restart
 * would otherwise appear title-less in the hub's discovery API — remote
 * clients have no editor-side session storage to fall back on. The backend's
 * session/list is the only title source for sessions born in a previous
 * bridge lifetime. Best-effort: failures log and leave the session untitled.
 */
async function adoptStoredTitle(
  server: ZcodeAcpServer,
  acpSid: string,
  zcodeSid: string,
): Promise<void> {
  if (server.sessionTitles.has(acpSid)) return;
  try {
    const backend = server.ensureBackend();
    const resp = await backend.request(server.nextId(), "session/list", {}, 15000);
    if (resp.error) return;
    const result = (resp.result ?? {}) as ZcodeListResult;
    const hit = (result.sessions ?? []).find((s) => s.sessionId === zcodeSid);
    if (hit?.title) {
      server.sessionTitles.set(acpSid, hit.title);
      server.touchSessionSummary(acpSid, hit.title);
      log(`adopted stored title for ${acpSid.slice(0, 8)}: ${hit.title}`);
    }
  } catch (e) {
    log(`stored title lookup failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Resolve the backend session id for `session/resume` / `session/load`.
 *
 * A `session/new` placeholder has no backend counterpart until first use, yet
 * the editor may resume it anyway (panel reopen, bridge restart) — resolving it
 * here prevents an otherwise unavoidable "Session not found". Resolution order:
 *   1. in-memory mapping → live only if verified loaded in this backend
 *      subprocess (`backendLoadedSessions`); a bare mapping may have been
 *      re-registered from the durable store without a resume, and the backend
 *      only serves messages for sessions it has loaded — those must fall
 *      through to the resume RPC or the replay comes back empty;
 *   2. pending placeholder → materialize it (an empty session, matching the
 *      pre-lazy behavior where a never-used session/new always resumed);
 *   3. durable store → a placeholder from a previous bridge lifetime: with a
 *      recorded zcodeSid the backend session still exists but isn't loaded into
 *      this subprocess (the resume RPC is needed); without one, materialize
 *      fresh;
 *   4. anything else (a real id from session/list, or a stale id) → pass
 *      through unchanged; genuinely missing sessions still error downstream.
 */
async function resolveResumeTarget(
  server: ZcodeAcpServer,
  acpSid: string,
): Promise<{ zcodeSid: string; alreadyLive: boolean }> {
  const mapped = server.resolveSid(acpSid);
  if (mapped) {
    return { zcodeSid: mapped, alreadyLive: server.backendLoadedSessions.has(acpSid) };
  }
  if (server.pendingSessions.has(acpSid)) {
    return { zcodeSid: await ensureRealSession(server, acpSid), alreadyLive: true };
  }
  const record = lookupLazySession(acpSid);
  if (record) {
    // ensureRealSession recovers the record: with a zcodeSid it re-registers
    // the alias (no create), without one it materializes a fresh session.
    return {
      zcodeSid: await ensureRealSession(server, acpSid),
      alreadyLive: !record.zcodeSid,
    };
  }
  return { zcodeSid: acpSid, alreadyLive: false };
}

/** `session/resume` → zcode `session/resume` (with runtimeModel overlay). */
export async function resumeSession(
  server: ZcodeAcpServer,
  params: acp.ResumeSessionRequest,
  cx: acp.AgentContext,
): Promise<acp.ResumeSessionResponse> {
  const acpSid = params.sessionId;
  const cwd = params.cwd ?? process.cwd();
  if (!acpSid) throw new Error("sessionId required");

  // Lazy placeholders (session/new) resolve to their real backend session
  // here; alreadyLive targets skip the resume RPC because the session is live
  // in this backend subprocess.
  const { zcodeSid, alreadyLive } = await resolveResumeTarget(server, acpSid);

  if (!alreadyLive) {
    // runtimeModel overlay: a resumed session may carry a stale/revoked model in
    // its history → send fails with "历史模型不可用". Overlaying the current
    // enabled provider redirects the session onto a working model. The overlay
    // deliberately carries NO apiKey (the backend's schema rejects it; it resolves
    // auth from its own config/OAuth store).
    const zcParams: Record<string, unknown> = {
      sessionId: zcodeSid,
      workspace: workspaceFor(cwd),
    };
    // ACP session/resume may also carry mcpServers; the backend's resume
    // schema accepts the same array shape (verified: an unknown key would be
    // rejected before the session lookup).
    if (params.mcpServers && params.mcpServers.length > 0) {
      zcParams.mcpServers = params.mcpServers;
    }
    const runtimeModel = buildResumeRuntimeModel();
    if (runtimeModel !== null) zcParams.runtimeModel = runtimeModel;
    // Push the provider registry BEFORE resume: a resumed session may carry a
    // third-party model in its history, and the backend needs the provider
    // registered to even process the resume turn.
    await syncProviderRegistry(server, cwd);
    await resumeBackendSession(server, zcParams);
    // The resume RPC succeeded — the session is now loaded in this backend.
    server.backendLoadedSessions.add(acpSid);
  }

  server.registerSession(acpSid, zcodeSid);
  // The load's cwd becomes the session root for remote file access (same as
  // session/new) — without this, a loaded session has no readable root.
  server.sessionCwds.set(acpSid, cwd);
  log(`session/resume -> ${zcodeSid}`);
  server.ensureBackgroundListener(zcodeSid);
  await adoptStoredTitle(server, acpSid, zcodeSid);
  // Initial usage_update so the editor shows the context bar immediately for a
  // resumed session (mirrors Python _on_session_resume → _emit_initial_usage).
  await emitInitialUsage(server, cx, acpSid, zcodeSid, getOrCreateDiffer(server, zcodeSid));
  const modes = await buildModes(server, zcodeSid);
  server.lastMode.set(acpSid, modes.currentModeId);
  return {
    modes,
    configOptions: await buildConfigOptions(server, zcodeSid),
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
  const acpSid = params.sessionId;
  const cwd = params.cwd ?? process.cwd();
  if (!acpSid) throw new Error("sessionId required");

  // Same placeholder resolution as resumeSession; alreadyLive targets skip the
  // backend resume RPC (the session is live in this subprocess).
  const { zcodeSid, alreadyLive } = await resolveResumeTarget(server, acpSid);

  if (!alreadyLive) {
    const zcParams: Record<string, unknown> = {
      sessionId: zcodeSid,
      workspace: workspaceFor(cwd),
    };
    const runtimeModel = buildResumeRuntimeModel();
    if (runtimeModel !== null) zcParams.runtimeModel = runtimeModel;
    // Push the provider registry BEFORE resume: a loaded session may carry a
    // third-party model in its history, and the backend needs the provider
    // registered to process it.
    await syncProviderRegistry(server, cwd);
    await resumeBackendSession(server, zcParams);
    // The resume RPC succeeded — the session is now loaded in this backend.
    server.backendLoadedSessions.add(acpSid);
  }
  server.registerSession(acpSid, zcodeSid);
  // Same as resumeSession: record the cwd as the session root for file access.
  server.sessionCwds.set(acpSid, cwd);
  log(`session/load → ${zcodeSid}`);
  server.ensureBackgroundListener(zcodeSid);
  await adoptStoredTitle(server, acpSid, zcodeSid);

  const messages = await fetchMessages(server, zcodeSid);
  // History on disk = real interaction (covers untitled sessions resumed from
  // a previous bridge lifetime) — make the session discoverable remotely.
  if (messages.length > 0) server.markSessionActive(acpSid);
  // Tail replay (Proposal 0001): a `_meta.zcode.limit` replays only the last
  // N messages aligned to turn boundaries — the full replay stays the default
  // for editors that send no `_meta` (Zed path unchanged).
  const limit = readTailLimit(params);
  const slice = limit === null ? fullSlice(messages) : sliceTail(messages, limit);
  await withReplayBatch(acpSid, () => replayMessages(cx, acpSid, slice.batch));
  log(
    `session/load: replayed ${slice.meta.replayedMessages} messages` +
      `${limit === null ? "" : ` (tail limit ${limit}, total ${slice.meta.totalMessages})`}`,
  );

  // Replay the existing todo list as an initial plan so a loaded session shows
  // its todos immediately (filter to PlanUpdate only — text/tools were already
  // replayed above and the differ hasn't mark_seen'd this history).
  try {
    const snapshot = await buildSnapshot(server, zcodeSid);
    const loadDiffer = getOrCreateDiffer(server, zcodeSid);
    const planEvents = loadDiffer.diff(snapshot).filter((e) => e.kind === "PlanUpdate");
    for (const iev of planEvents) {
      await dispatchEvent(server, cx, acpSid, iev, `load_${randomUUID().slice(0, 8)}`);
    }
  } catch (e) {
    log(
      `session/load: initial plan read failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Initial usage_update so the editor shows the context bar immediately.
  await emitInitialUsage(server, cx, acpSid, zcodeSid, getOrCreateDiffer(server, zcodeSid));

  const modes = await buildModes(server, zcodeSid);
  server.lastMode.set(acpSid, modes.currentModeId);
  // A turn from a prior client may still be in flight (the bridge runs it to
  // completion regardless of who prompted); flag it so re-attaching clients
  // restore their running state. Editor-initiated turns land here too.
  const turnActive = [...server.pendingTurns.values()].some((t) => t.zcodeSid === zcodeSid);
  const result = {
    modes,
    configOptions: await buildConfigOptions(server, zcodeSid),
    // Additive replay metadata — the anchor for load_earlier pagination.
    replayMeta: { ...slice.meta, turnActive },
  };
  return result as acp.LoadSessionResponse;
}

/** `session/prompt` → subscribe-before-send, run the event-driven turn loop. */
export async function prompt(
  server: ZcodeAcpServer,
  params: acp.PromptRequest,
  cx: acp.AgentContext,
  requestId: number | string,
): Promise<acp.PromptResponse> {
  const backend = server.ensureBackend();

  // Extract prompt text + image attachments from ACP ContentBlock[].
  const text = extractPromptText(params.prompt);
  const attachments = extractAttachments(params.prompt);
  // A prompt is valid if it has text OR at least one image attachment (a user
  // may drag in an image with no accompanying text).
  if (!text && attachments.length === 0) throw new Error("empty prompt");

  // Materialize a lazy session/new placeholder on first use. Placed after the
  // empty-prompt check so an invalid request doesn't create a backend session.
  const zcodeSid = await ensureRealSession(server, params.sessionId);

  // Slash-command interception: dispatches directly to ZCode methods and
  // returns end_turn without entering the turn loop. Known passthrough
  // commands and unknown /x both return null for the normal turn loop.
  const { handleSlashCommand, neutralizeSlashText } = await import("./slash.js");
  const intercepted = await handleSlashCommand(server, cx, params.sessionId, zcodeSid, text);
  if (intercepted) return intercepted;

  // Wire text for the backend: unknown `/x` prompts (not advertised commands)
  // are neutralized so the backend's command resolver never sees them — an
  // unresolvable name can hard-fail the turn. Known commands pass through
  // unchanged. The title/auto-compact paths below keep using the raw `text`.
  const sendText = neutralizeSlashText(text);

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
  // True when this send cancelled another in-flight prompt (preempt/stop).
  // Drives the turn-attribution gate: only a preempted prompt can see leftover
  // events from a prior turn in its listener queue; without preemption any
  // events before this turn's turn.started belong to a backend-owned turn
  // (e.g. auto-resumed after compaction) that this send was steered into.
  let preempted = false;
  await withPreemptLock(server, zcodeSid, async () => {
    server.pendingTurns.set(requestId, turn);
    preempted = preemptInFlightTurn(server, zcodeSid, requestId);
  });
  // Discovery: the session is live the moment its turn STARTS — mark it active
  // here instead of only at turn end, so a freshly created conversation shows
  // up in remote lists within one heartbeat even while its first (possibly
  // minutes-long) turn is still running. Until the backend's auto-title lands
  // at end_turn, seed a provisional title from the prompt text (auto-title
  // stays authoritative — its set-once gate is the separate sessionTitles).
  server.markSessionActive(params.sessionId);
  if (server.sessionSummaries.get(params.sessionId)?.title === undefined) {
    const firstLine = text.trim().split(/\r\n|\r|\n/)[0] ?? "";
    if (firstLine) {
      server.touchSessionSummary(
        params.sessionId,
        firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine,
      );
    }
  }
  // Out-of-band running indicator: clients that did not send this prompt
  // (re-attached mobile, second editor) learn the turn started here — the
  // session/load replayMeta only snapshots attach time. Best-effort: a dead
  // client must not fail the turn.
  const emitTurnState = (running: boolean): Promise<void> =>
    cx
      .notify("$/zcode/turnState", { sessionId: params.sessionId, running })
      .catch((e) => log(`turnState notify failed: ${e instanceof Error ? e.message : String(e)}`));
  await emitTurnState(true);

  const listener = new EventStreamListener(backend, zcodeSid);
  const monitor = new TurnMonitor(backend, zcodeSid, () => server.nextId());

  // Per-session ProjectionDiffer (persists across turns). The baseline mark_seen
  // prevents the differ from re-emitting history at turn completion.
  const differ = getOrCreateDiffer(server, zcodeSid);
  const baselineMsgs = await fetchMessages(server, zcodeSid);
  differ.markSeen(baselineMsgs);

  // Subscribe BEFORE send so we don't lose early turn.completed on short turns.
  // subscribe() throws on failure, surfacing the backend's real error (reader
  // dead, timeout, pipe broken, method-not-found on old CLI, session error) so
  // the cause is distinguishable. Clean up the pending turn before propagating
  // — this call site is outside the try/finally below.
  let snapshot: ZcodeSnapshot;
  try {
    snapshot = await listener.subscribe(() => server.nextId());
  } catch (e) {
    server.pendingTurns.delete(requestId);
    await emitTurnState(false);
    throw e;
  }
  // subscribe() requests includeSnapshot:false (it only needs the eventSeq
  // watermark to arm the event stream), so `snapshot` is an empty fallback.
  // The real projection baseline comes from fetchMessages + differ.markSeen
  // above. Kept as a binding only so the call fits the Promise-returning shape.
  void snapshot;
  backend.registerEventListener(zcodeSid, listener);

  try {
    // Transient turn failures (e.g. provider network blips surfaced as
    // turn.failed with cause code model_request_failed) are retried by
    // re-sending the prompt and re-running the event loop, instead of
    // surfacing a hard error that stops the session. Non-transient failures
    // (send rejected, non-transient turn error) propagate immediately. After
    // exhausting retries on a transient error we degrade gracefully: emit a
    // user-visible message and return end_turn so the session stays usable.
    // 1 initial attempt + 5 retries. Backoff grows exponentially then caps so
    // later retries don't keep stretching: 1s, 2s, 4s, 4s, 4s.
    const MAX_TURN_ATTEMPTS = 6;
    const MAX_BACKOFF_MS = 4000;
    const backoffMs = (attempt: number): number =>
      Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    let lastTurnError: Record<string, unknown> | null = null;

    for (let attempt = 1; attempt <= MAX_TURN_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        // A prior transient turn ended the backend turn; before re-sending,
        // reconcile the differ baseline so the retried turn's new messages
        // aren't treated as already-seen, surface a retry hint, then back off.
        if (turn.cancelled) {
          stopBackendTurn(server, zcodeSid);
          return { stopReason: "cancelled" };
        }
        differ.markSeen(await fetchMessages(server, zcodeSid));
        await sendTextChunk(
          cx,
          params.sessionId,
          `[网络异常，正在重试 (${attempt - 1}/${MAX_TURN_ATTEMPTS - 1})…]`,
          randomUUID(),
        );
        log(
          `  [retry] transient turn failed, re-sending (attempt ${attempt}/${MAX_TURN_ATTEMPTS})`,
        );
        await sleep(backoffMs(attempt - 1));
      }

      const chunkMsgId = randomUUID();

      // Send the prompt, retrying while the backend reports it's still busy.
      // The backend's prompt lock is the single authoritative readiness signal:
      // a rejected send (code 1308 "prompt is running") means a previous turn
      // (cancelled, preempted, or still finalising) hasn't released the lock
      // yet. Rather than guessing when the backend is ready — or blocking on a
      // local shadow flag — we retry with a fixed delay until the backend
      // accepts. This covers the preempt path (new prompt interrupting an
      // in-flight one) and the stop-recovery window after a manual cancel.
      const SEND_RETRY_INTERVAL_MS = 500;
      const SEND_RETRY_TIMEOUT_MS = 30_000;
      const sendParams =
        attachments.length > 0
          ? { sessionId: zcodeSid, content: sendText, attachments }
          : { sessionId: zcodeSid, content: sendText };
      const sendT0 = Date.now();
      let sendAttempt = 0;
      while (true) {
        if (turn.cancelled) {
          stopBackendTurn(server, zcodeSid);
          return { stopReason: "cancelled" };
        }
        sendAttempt++;
        // Wait before sending when a recent cancel/preempt makes a busy reject
        // likely — right after stop the backend is in its recovery window and
        // will reject an immediate send. On the first attempt with no recent
        // cancel, send immediately so normal prompts aren't delayed.
        const recentCancel = server.lastCancelledAt.get(zcodeSid);
        const expectBusy =
          sendAttempt > 1 ||
          (recentCancel !== undefined && Date.now() - recentCancel < SEND_RETRY_TIMEOUT_MS);
        if (expectBusy) {
          await sleep(SEND_RETRY_INTERVAL_MS);
          if (turn.cancelled) {
            stopBackendTurn(server, zcodeSid);
            return { stopReason: "cancelled" };
          }
        }
        const sendResp = await backend.request(server.nextId(), "session/send", sendParams, 15000);
        if (!sendResp.error) {
          const accepted = (sendResp.result ?? {}) as { accepted?: boolean };
          if (accepted.accepted) break; // backend took it → turn starts
          throw new Error("zcode send not accepted");
        }
        const sendErrCode = sendResp.error.code;
        const sendErrMsg = (sendResp.error.message ?? "").toLowerCase();
        const isBusy =
          sendErrCode === 1308 ||
          sendErrMsg.includes("prompt is running") ||
          sendErrMsg.includes("already running");
        if (!isBusy) {
          // Non-busy error (auth, malformed, etc.) — don't retry, surface it.
          throw new Error(`zcode send failed: ${sendResp.error.message ?? ""}`);
        }
        if (Date.now() - sendT0 > SEND_RETRY_TIMEOUT_MS) {
          throw new Error(
            `zcode send failed: backend still busy after ${Math.round(SEND_RETRY_TIMEOUT_MS / 1000)}s (${sendResp.error.message ?? ""})`,
          );
        }
        log(
          `  [send] backend busy (${sendResp.error.message ?? ""}), retrying in ${SEND_RETRY_INTERVAL_MS}ms`,
        );
      }

      try {
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
          preempted,
        );

        // Session title: set once on the first end_turn, but ONLY for freshly
        // created sessions. Resumed/loaded sessions already carry a title from
        // their history and must not be overwritten by the first post-load
        // message. sessionTitles enforces set-once within a session;
        // titleEligibleSessions gates which sessions are titled at all.
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
          server.touchSessionSummary(params.sessionId, title);
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
        // ZCODE_ACP_AUTO_COMPACT_THRESHOLD (absolute token count; 0/unset =
        // disabled). Only on end_turn — cancelled/max_turn_requests skips
        // compaction, as does a stall-recovered end_turn (the completion was
        // inferred by the stall heuristic, not confirmed by turn.completed —
        // compressing an in-flight task's context would destroy the work).
        // Best-effort: failures are logged inside maybeAutoCompact, never thrown.
        if (result.stopReason === "end_turn" && !turn.stallRecovered) {
          const { maybeAutoCompact } = await import("../config/auto-compact.js");
          await maybeAutoCompact(server, cx, params.sessionId, zcodeSid);
        }

        return result;
      } catch (e) {
        // Only a transient TurnFailedError is retryable; everything else (send
        // failures, non-transient turn errors, exhausted retries, cancellation)
        // propagates to the caller.
        if (
          e instanceof TurnFailedError &&
          attempt < MAX_TURN_ATTEMPTS &&
          !turn.cancelled &&
          isTransientTurnError(e.turnError)
        ) {
          lastTurnError = e.turnError;
          continue;
        }
        throw e;
      }
    }

    // All retries exhausted on a transient error → degrade gracefully. Keep the
    // session usable so the user can resend the message instead of the editor
    // surfacing a hard error and stopping. Skip auto-compact here: compaction
    // after a failed turn is more likely to confuse state than help.
    const errMsg = formatTurnError(lastTurnError) || "turn failed after retries";
    await sendTextChunk(
      cx,
      params.sessionId,
      `[请求失败：${errMsg}。会话仍可用，请重新发送消息重试。]`,
      randomUUID(),
    );
    return { stopReason: "end_turn" };
  } finally {
    backend.unregisterEventListener(zcodeSid, listener);
    server.pendingTurns.delete(requestId);
    // Turn end = session activity — refresh the discovery summary and mark the
    // session discoverable regardless of outcome (end_turn, cancelled, retries
    // exhausted).
    server.markSessionActive(params.sessionId);
    // Report "running" only while no other turn for the session took over
    // (preempt): the preempting turn's own running:true must survive.
    const stillBusy = [...server.pendingTurns.values()].some((t) => t.zcodeSid === zcodeSid);
    await emitTurnState(stillBusy);
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
  if (typeof params.value !== "string") {
    throw new Error(`unsupported config value type: ${String(params.value)}`);
  }
  // Materialize a lazy session/new placeholder on first use.
  const zcodeSid = await ensureRealSession(server, params.sessionId);
  const { setConfigOption, emitConfigOptionUpdate } = await import("../config/options.js");
  const result = await setConfigOption(server, zcodeSid, params.configId, params.value);
  if (!result) {
    throw new Error(`unsupported config option or switch failed: ${params.configId}`);
  }
  const options = await emitConfigOptionUpdate(server, cx, params.sessionId, zcodeSid, result.kind);
  return { configOptions: options };
}

/**
 * `session/cancel` → stop the in-flight turn immediately. Mirrors the ZCode
 * App's stop button, which sends a stop command directly (there is no
 * "cancel" concept on the client — only stop).
 *
 * We fire `session/stop` here instead of deferring it to the turn loop. The
 * loop is blocked for seconds at a time behind awaits (handleServerRequests
 * waiting on a permission popup; dispatchEvent running per-event; the
 * tool-result path awaiting dispatchEditDiff/dispatchPlanIfChanged backend
 * calls with up to 8s timeouts). A deferred stop only fires once the loop
 * finishes whatever await it is stuck in, so the user's press of stop can lag
 * by the full remaining await window — the turn visibly "keeps running".
 * `session/stop` is fire-and-forget and fully idempotent (the backend no-ops
 * on a session with no active turn, and on a turn already aborted), so firing
 * it eagerly is safe; the loop's `stopSent` guard prevents a second send.
 *
 * `turn.cancelled` is still set so the turn loop switches to its silent-drain
 * path (translate to detect turnDone, but discard every internal event — no
 * text/tool/usage is pushed after the user stopped).
 */
export async function cancel(
  server: ZcodeAcpServer,
  params: acp.CancelNotification,
): Promise<void> {
  const zcodeSid = server.resolveSid(params.sessionId);
  if (!zcodeSid) return;
  // Cancel ALL matching turns for this session (not just the first). While a
  // prior turn is still finalising, pendingTurns holds both it and any newer
  // prompt waiting on the backend's prompt lock; breaking on the first match
  // could leave the live one running. Each turn guards its own stopSent, so
  // multiple matching turns may each fire session/stop once — the backend
  // treats stop as idempotent, so the duplicate is harmless.
  for (const [, turn] of server.pendingTurns) {
    if (turn.zcodeSid === zcodeSid) {
      turn.cancelled = true;
      if (!turn.stopSent) {
        stopBackendTurn(server, zcodeSid);
        turn.stopSent = true;
      }
      // Record cancel time so a prompt arriving in the backend's ~20s
      // model-connection recovery window can fast-fail instead of hanging.
      server.lastCancelledAt.set(zcodeSid, Date.now());
    }
  }
  log(`session/cancel → ${zcodeSid}`);
}

/**
 * Raised by `runEventTurn` when the backend emits `turn.failed`. Carries the
 * structured error object (with its nested `cause`) so `prompt`'s retry loop
 * can classify transient vs fatal via `isTransientTurnError`. The display
 * message is derived from `formatTurnError` at construction time.
 */
class TurnFailedError extends Error {
  readonly turnError: Record<string, unknown>;
  constructor(turnError: Record<string, unknown>) {
    super(formatTurnError(turnError) || "turn failed");
    this.name = "TurnFailedError";
    this.turnError = turnError;
  }
}

/**
 * Fire-and-forget `session/stop` to the backend. Mirrors Python's
 * `_cancel_backend_turn`: send stop with an id (some backends route by id
 * presence), never wait for a response, never throw.
 *
 * The turn-loop cancel site calls this once (guarded by turn.stopSent), then
 * keeps looping until the backend emits turn.completed/turn.failed. The
 * backend's prompt lock releases when ITS finalisation completes — that,
 * not any bridge-side signal, is what the next prompt's send-retry waits on.
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
 * The body is async only to satisfy the lock chain (registration is
 * synchronous; preempt no longer waits). The turn loop itself runs OUTSIDE
 * this lock — only registration + preempt are serialized.
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
 * Cancel any other in-flight turn for this zcodeSid: fire `session/stop` and
 * signal the old turn to stop retrying, then return immediately.
 *
 * We do NOT wait for the old turn's runEventTurn to exit. Previously this spun
 * on `pendingTurns` deletion (the old turn's finally), but that signal only
 * proves "the old turn's loop returned" — NOT "the backend is ready for a new
 * turn". Waiting on it blocked the new prompt in a long loading state while
 * the backend's stop-recovery window elapsed, and it still didn't prevent the
 * next send from racing the backend. The backend's prompt lock is the only
 * authoritative readiness signal: the new prompt's `session/send` retries
 * until the lock releases, so there is nothing useful to wait for here.
 *
 * The old turn's runEventTurn ends on its own once it sees a terminal event
 * from the backend (turn.completed/turn.failed after stop). Until then it
 * keeps dispatching whatever the backend sends for this session — which is
 * correct, because within a single session the backend is the single source
 * of truth and its events should reach the client.
 *
 * Exported for unit tests (multi-turn pendingTurns scenarios).
 */
export function preemptInFlightTurn(
  server: ZcodeAcpServer,
  zcodeSid: string,
  selfRequestId: number | string,
): boolean {
  // Cancel ALL matching turns (mirrors cancel()): pendingTurns can hold more
  // than one entry for this session — e.g. an already-cancelled turn still
  // finalising plus the live one. Breaking on the first match could hit the
  // stale entry and leave the live turn running, so the new prompt's send
  // would retry against a busy backend for 30s and fail. Each turn guards its
  // own stopSent; duplicate stops are idempotent on the backend.
  let found = false;
  for (const [reqId, turn] of server.pendingTurns) {
    if (turn.zcodeSid !== zcodeSid || reqId === selfRequestId) continue;
    turn.cancelled = true; // signal the old turn to stop its retry loops
    if (!turn.stopSent) {
      stopBackendTurn(server, zcodeSid);
      turn.stopSent = true;
    }
    // Record cancel time so the prompt()'s send-retry can use the recovery
    // window as a hint (see session/send retry loop).
    server.lastCancelledAt.set(zcodeSid, Date.now());
    log(`  [preempt] in-flight turn ${reqId} cancelled, proceeding without waiting`);
    found = true;
  }
  return found;
}

// ---------- internals ----------

/** Concatenate text from ACP ContentBlock[] into a prompt string.
 *  Exported for unit testing (the resource_link path is easy to break). */
export function extractPromptText(blocks: acp.ContentBlock[] | undefined): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    // ACP ContentBlock is a discriminated union on `type`. The resource_link
    // variant carries `name` + `uri` flat on the block itself (NOT nested under
    // a `resource_link` key — see ACP schema $defs.ResourceLink). Accessing
    // `block.resource_link` silently dropped every dragged-file attachment.
    const b = block as {
      type?: string;
      text?: string;
      name?: string;
      uri?: string;
      resource?: { text?: string; blob?: string; uri?: string };
    };
    if (b.type === "text" && b.text) {
      parts.push(b.text);
    } else if (b.type === "resource_link" && b.uri) {
      // Convert file:// URIs to absolute paths so the model treats them as
      // readable filesystem locations rather than opaque hyperlinks. Fall
      // back to the path when name is missing OR empty — the ACP schema
      // requires `name`, but a non-compliant client still deserves useful
      // prompt text rather than `[related resource: ](/path)`.
      const path = b.uri.startsWith("file://") ? fileUriToPath(b.uri) : b.uri;
      const label = b.name || path;
      parts.push(`[related resource: ${label}](${path})`);
    } else if (b.type === "resource" && b.resource) {
      // Embedded resource. We don't advertise embeddedContext, but accept text
      // payloads defensively in case a client sends them anyway. Binary
      // payloads (BlobResourceContents) are never decoded — the base64 blob is
      // useless to the model — so rewrite the resource uri into a readable
      // filesystem location (same treatment as resource_link). Dropping it
      // entirely left the prompt empty, which errored on a binary-only drag.
      const r = b.resource;
      if (r.text) {
        parts.push(r.text);
      } else if (r.blob && r.uri) {
        const path = r.uri.startsWith("file://") ? fileUriToPath(r.uri) : r.uri;
        const label = basename(path) || path;
        parts.push(`[related resource: ${label}](${path})`);
      }
    }
  }
  return parts.join("\n").trim();
}

/**
 * ACP `ContentBlock::Image` → zcode `session/send` attachment.
 *
 * zcode's per-attachment normalizer accepts either a `localPath` (absolute FS
 * path, preferred) or `dataBase64` + `mimeType` (raw base64, no data: prefix).
 * ACP `ImageContent` carries `data` (base64) and an optional `uri`; when the
 * uri is a file:// pointer we send localPath so the backend streams from disk
 * instead of re-encoding.
 */
export interface ImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  dataBase64?: string;
  localPath?: string;
}

/** Extension inferred from mimeType for synthesizing a filename. */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/**
 * Extract image attachments from ACP ContentBlock[]. Non-image blocks are
 * ignored (text/resource_link/resource stay owned by `extractPromptText`).
 * Exported for unit testing.
 */
export function extractAttachments(blocks: acp.ContentBlock[] | undefined): ImageAttachment[] {
  const out: ImageAttachment[] = [];
  let imageIndex = 0;
  for (const block of blocks ?? []) {
    const b = block as {
      type?: string;
      data?: string;
      mimeType?: string;
      uri?: string | null;
    };
    if (b.type !== "image") continue;
    imageIndex += 1;
    const mimeType = b.mimeType ?? "image/png";
    // Prefer a file:// uri → localPath so the backend streams from disk.
    const uri = typeof b.uri === "string" ? b.uri : "";
    if (uri.startsWith("file://")) {
      const localPath = fileUriToPath(uri);
      out.push({
        kind: "image",
        filename: basename(localPath) ?? `image-${imageIndex}.${MIME_EXT[mimeType] ?? "png"}`,
        mimeType,
        localPath,
      });
      continue;
    }
    // Otherwise fall back to the base64 payload.
    if (b.data) {
      out.push({
        kind: "image",
        filename: uri
          ? (basename(uri) ?? `image-${imageIndex}.${MIME_EXT[mimeType] ?? "png"}`)
          : `image-${imageIndex}.${MIME_EXT[mimeType] ?? "png"}`,
        mimeType,
        dataBase64: b.data,
        sizeBytes: Math.floor((b.data.length * 3) / 4),
      });
    }
    // An image block with neither a usable uri nor data is dropped defensively.
  }
  return out;
}

/** Best-effort basename from a path/uri (no node:path import for a tiny helper). */
function basename(p: string): string | null {
  const clean = p.replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  return name || null;
}

/** Convert a file:// URI to an absolute filesystem path. */
function fileUriToPath(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    // Not a valid URL — return as-is (best-effort).
    return uri;
  }
}

/**
 * Resume a zcode session with retry on transient timeouts.
 *
 * The backend drops RPCs issued during its cold-start window (between process
 * spawn and `startup.completed`). The first resume after a fresh backend spawn
 * can land in that gap and time out without the backend ever seeing it. A single
 * retry — issued after the startup window has elapsed — succeeds. Non-timeout
 * errors (Invalid params, session not found) fail fast.
 */
async function resumeBackendSession(
  server: ZcodeAcpServer,
  zcParams: Record<string, unknown>,
): Promise<void> {
  const backend = server.ensureBackend();
  const MAX_ATTEMPTS = 2;
  const ATTEMPT_TIMEOUT_MS = 15_000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const resp = await backend.request(
      server.nextId(),
      "session/resume",
      zcParams,
      ATTEMPT_TIMEOUT_MS,
    );
    if (!resp.error) return;
    const isTimeout = resp.error.message === "timeout";
    if (!isTimeout || attempt === MAX_ATTEMPTS) {
      throw new Error(`zcode resume failed: ${resp.error.message ?? ""}`);
    }
    log(
      `session/resume attempt ${attempt}/${MAX_ATTEMPTS} timed out, retrying (backend cold-start window)`,
    );
    await sleep(1000);
  }
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
  preempted: boolean,
): Promise<acp.PromptResponse> {
  const backend = server.ensureBackend();
  const translator = new EventTranslator();
  differ.resetTurn();
  const NO_PROGRESS_MS = 120_000;
  let lastProgress = Date.now();
  let lastStallCheck = Date.now();
  let emittedText = false;
  let emittedOutput = false;
  // Thinking-phase feedback: GLM models spend seconds in CoT before emitting
  // any model.streaming event, during which the backend is silent and the
  // editor shows nothing — users perceive this as "frozen". To bridge that
  // gap we emit ONE agent_thought_chunk hint shortly after the turn starts,
  // but only if no real output (text / reasoning / tool) has arrived yet.
  // It uses a dedicated messageId so it never collides with the real reasoning
  // stream (thought_<chunkMsgId>) and is naturally superseded once content flows.
  let turnStartedAt: number | null = null;
  let thinkingHintSent = false;
  const THINKING_HINT_DELAY_MS = 1200;

  while (Date.now() - lastProgress < NO_PROGRESS_MS) {
    // Drain + handle server→client requests (interaction/*). Refreshes the
    // no-progress timer when any are handled. Pass `turn` so interaction
    // requests become turn-cancel aware (user stop aborts pending popups).
    // Best-effort containment: a throw here would kill the turn loop (and the
    // prompt response with it); warn and keep draining instead.
    let handled = false;
    try {
      handled = await handleServerRequests(server, backend, cx, acpSid, turn);
    } catch (e) {
      warn(`handleServerRequests threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (handled) {
      lastProgress = Date.now();
    }

    if (turn.cancelled) {
      // Cancel requested: ensure stop was fired (cancel()/preempt normally do
      // this, but guard anyway). We do NOT silence subsequent events here — if
      // the backend ignored the stop and kept producing, that content is still
      // valuable to the user and should be displayed (the backend is the single
      // source of truth within a session). Cross-turn contamination is handled
      // separately by the turn-attribution gate below, which discards this
      // turn's leftover events from the *next* turn's queue. The loop exits
      // normally on the terminal event (translator.turnDone below).
      if (!turn.stopSent) {
        stopBackendTurn(server, turn.zcodeSid);
        turn.stopSent = true;
      }
    }

    const ev = await listener.pollEvent(500);
    if (ev === null) {
      // Thinking-phase hint: if the turn has started but produced no output
      // yet (no text/reasoning/tool streamed), and we've been silent longer
      // than the threshold, emit a single "thinking" thought chunk so the
      // editor shows activity instead of a frozen screen. Skipped once any
      // real output has been dispatched, and never sent after cancellation.
      if (
        !turn.cancelled &&
        !thinkingHintSent &&
        turnStartedAt !== null &&
        !emittedText &&
        !emittedOutput &&
        Date.now() - turnStartedAt > THINKING_HINT_DELAY_MS
      ) {
        thinkingHintSent = true;
        await sendSessionUpdate(cx, acpSid, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "正在思考…" },
          messageId: `thinking_${chunkMsgId}`,
        });
      }
      // Stall reconciliation: probe authoritative status after 15s of silence.
      // Skipped while cancelled: we've already fired stop, so the backend will
      // emit its own completion event, and this branch would otherwise push
      // stale output or return a wrong stopReason (end_turn / throw) after the
      // user stopped.
      if (
        !turn.cancelled &&
        translator.turnStarted &&
        Date.now() - lastProgress > 15_000 &&
        Date.now() - lastStallCheck > 15_000
      ) {
        lastStallCheck = Date.now();
        const proj = await monitor.pollOnce();
        if (proj?.status === "idle") {
          // A single idle probe can also fire mid-work: the backend is silent
          // during the model's thinking/connection phase and may report idle
          // while the turn is still alive. Confirm before trusting it — wait
          // briefly, then probe once more. Only a second idle WITH no queued
          // events ends the turn: an event arriving in the window proves the
          // turn is alive (it stays queued for the next poll).
          await sleep(1500);
          if (listener.hasQueuedEvents()) {
            lastProgress = Date.now();
            continue; // alive — events will be consumed by the next poll
          }
          const proj2 = await monitor.pollOnce();
          if (proj2?.status === "idle" && !listener.hasQueuedEvents()) {
            // Turn completed but the event was lost (double-confirmed).
            if (!emittedText) {
              const reply = await fetchLastReply(server, turn.zcodeSid, differ);
              if (reply) {
                registerFetchedReply(translator, reply);
                await sendTextChunk(cx, acpSid, reply.text, chunkMsgId);
              } else if (!emittedOutput) {
                // No text and no output → suspected failure.
                stopBackendTurn(server, turn.zcodeSid);
                throw new RequestError(-32603, "turn produced no output");
              }
            }
            // Heuristic ending: prompt() must skip auto-compact for this
            // turn — the completion was inferred, and compressing an
            // in-flight task's context would destroy the work.
            turn.stallRecovered = true;
            return { stopReason: "end_turn" };
          }
          // Second probe says the backend is still working (or events arrived
          // mid-probe) — keep waiting; queued events are consumed by the next
          // poll iteration.
          lastProgress = Date.now();
          if (proj2?.status === "running") {
            await listener.resubscribe(() => server.nextId());
          }
          continue;
        }
        if (proj?.status === "running") {
          // Backend still working (or recovering from a stop) — keep waiting.
          // The send-retry loop in prompt() already covers the recovery window
          // for the NEXT turn; for this in-flight turn we just resubscribe and
          // let the backend emit its terminal event when ready.
          lastProgress = Date.now();
          await listener.resubscribe(() => server.nextId());
        }
      }
      continue;
    }

    lastProgress = Date.now();
    // Turn-attribution gate: before this turn's own turn.started arrives, any
    // event is leftover from a prior turn (cancelled/preempted but still
    // finalising) that landed in the queue while send was retrying on a busy
    // backend. Discard it — including a prior turn's turn.completed, which
    // would otherwise make this turn exit (cancelled) before it even begins.
    //
    // The gate must run BEFORE translate(): translator flags (turnDone /
    // turnFailed / turnResultType) are sticky, so translating a prior turn's
    // terminal event here would flip them and make THIS turn exit prematurely
    // at the first check after its own turn.started passes the gate.
    //
    // The gate is armed ONLY when this send preempted another prompt. Without
    // preemption no prior-turn residue can exist: the queue can only contain
    // events of a backend-owned turn that was already active at send time
    // (e.g. the main-branch turn auto-resumed after a compaction) — this send
    // was steered into it and produces NO new turn.started, so dropping those
    // events would silently swallow the entire turn's output in the UI.
    if (shouldDropEventForTurnAttribution(ev, translator.turnStarted, preempted)) {
      continue;
    }
    const internalEvents = translator.translate(ev);
    // Capture the turn-start timestamp for the thinking-phase hint above.
    // Done after translate so the flag flip on the turn.started event is
    // observed on the same iteration that processes it.
    if (turnStartedAt === null && translator.turnStarted) {
      turnStartedAt = Date.now();
    }
    for (const iev of internalEvents) {
      if (iev.kind === "TextDelta" || iev.kind === "ReasoningDelta") emittedText = true;
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
        const sideTasks: Promise<void>[] = [
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
        ];
        // EnterPlanMode switches the session mode mid-turn without a
        // session/setMode notification; reconcile immediately so the editor's
        // mode indicator flips without waiting for turn completion.
        if (translator.toolNames.get(payload.toolCallId) === "EnterPlanMode") {
          sideTasks.push(emitModeIfChanged(server, cx, acpSid, turn.zcodeSid));
        }
        await Promise.all(sideTasks);
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
      // User requested cancel (via cancel()/preempt). Whatever the backend's
      // terminal resultType (cancelled / success / failed), honour the user's
      // intent and report cancelled.
      if (turn.cancelled || translator.turnResultType === "cancelled") {
        return { stopReason: "cancelled" };
      }
      if (translator.turnFailed) {
        // Best-effort stop in case the failed turn left a residual lock.
        stopBackendTurn(server, turn.zcodeSid);
        // Throw a TurnFailedError carrying the structured error so the caller
        // (prompt's retry loop) can classify transient vs fatal. The error
        // message is formatted for display when it ultimately reaches the user.
        throw new TurnFailedError(translator.turnError ?? {});
      }
      // Fallback: if no text streamed, surface the last assistant reply.
      if (!emittedText) {
        const reply = await fetchLastReply(server, turn.zcodeSid, differ);
        if (reply) {
          registerFetchedReply(translator, reply);
          await sendTextChunk(cx, acpSid, reply.text, chunkMsgId);
        }
      }
      // Turn-completion diff: emits PlanUpdate (todos) + final usage_update,
      // reconciles any snapshot-only tool events, and replays assistant text
      // that never reached the live event stream.
      //
      // TextDelta/ReasoningDelta are filtered only when the same message was
      // ALREADY streamed live (dedup by backend message id — `translator`
      // records `assistantMessageId` per streamed delta, the differ tags its
      // replay with the same id). The differ's seenMessageIds dedup cannot
      // bridge the two paths because the streaming path uses a client-generated
      // chunkMsgId while the differ keys on the backend's message info.id.
      //
      // Without this per-message dedup the whole reply would be dispatched a
      // second time; without the replay, a backend turn resumed while no
      // listener was attached (e.g. the main-branch turn auto-resumed after
      // compaction, before the user's next send) would leave its entire output
      // invisible in the UI. `fetchLastReply` above only covers the last
      // assistant message, not the whole missing span.
      const snapshot = await buildSnapshot(server, turn.zcodeSid);
      const completionEvents = differ.diff(snapshot);
      for (const iev of completionEvents) {
        if (
          (iev.kind === "TextDelta" || iev.kind === "ReasoningDelta") &&
          iev.messageId &&
          translator.deliveredMessageIds.has(iev.messageId)
        ) {
          continue;
        }
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
 * Turn-attribution gate decision (pure, exported for tests): whether an event
 * observed before this turn's own `turn.started` should be dropped as leftover
 * residue of a prior turn.
 *
 * Residue only exists when this send preempted/cancelled another prompt (its
 * finalising events land in the new listener's queue). Without preemption the
 * queue can only carry events of a backend-owned turn already active at send
 * time — e.g. the main-branch turn auto-resumed after a compaction — which
 * this send was steered into and which emits no new `turn.started`; dropping
 * those events would silently swallow the whole turn's output in the UI.
 */
export function shouldDropEventForTurnAttribution(
  ev: { type: string },
  turnStarted: boolean,
  preempted: boolean,
): boolean {
  return !turnStarted && preempted && ev.type !== "turn.started";
}

/**
 * Register a fetchLastReply-delivered message as text-delivered so the
 * turn-completion diff replay doesn't dispatch the same text a second time
 * (the differ never saw this message — its live events were lost — so its
 * diff would re-emit the TextDelta). Reasoning is NOT registered: it was
 * never streamed either, so the replay dispatching it is pure gain.
 */
function registerFetchedReply(
  translator: EventTranslator,
  reply: { messageId: string | null },
): void {
  if (reply.messageId) translator.deliveredMessageIds.add(reply.messageId);
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
): Promise<{ text: string; messageId: string | null } | null> {
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
          if (text.trim()) return { text, messageId: m.info?.id ?? null };
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
export async function emitModeIfChanged(
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
 * The backend writes the projection's todos asynchronously AFTER the
 * tool-result event, so a single read at result-time races that write and
 * intermittently sees the stale list (the editor's todo panel then lags until
 * the next tool completes). When the signature is unchanged, re-check once
 * after a short delay before giving up.
 *
 * Uses a lightweight `session/read` (no session/messages fetch). Failures are
 * logged and swallowed: plan staleness is cosmetic, not worth crashing the turn.
 */
const PLAN_RECHECK_DELAY_MS = 600;

// Exported for unit tests (plan recheck timing).
export async function dispatchPlanIfChanged(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  differ: ProjectionDiffer,
  chunkMsgId: string,
  recheck = true,
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
    if (events.length === 0) {
      if (!recheck) return;
      const timer = setTimeout(() => {
        void dispatchPlanIfChanged(server, cx, acpSid, zcodeSid, differ, chunkMsgId, false).catch(
          () => {
            /* best-effort: cosmetic staleness only */
          },
        );
      }, PLAN_RECHECK_DELAY_MS);
      timer.unref?.();
      return;
    }
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
