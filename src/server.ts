/**
 * ZcodeAcpServer — owns shared server state, the backend client, and registers
 * ACP handlers.
 *
 * This is the long-lived container the entry point wires to the ACP stream.
 * Shared state (session map, pending turns, client capabilities) lives here so
 * every handler layer can reach it without globals.
 */

import type * as acp from "@agentclientprotocol/sdk";

import {
  builtinProviderEnv,
  loadZcodeCredentials,
  mergeEnvWithCreds,
  resolveZcodeCommand,
  ZcodeBackend,
} from "./backend/index.js";
import { armSandboxArgv, collectSandboxWorkspaces, sandboxActive } from "./backend/sandbox.js";
import { BackgroundTaskListener } from "./handlers/background-tasks.js";
import { enqueueSessionSend } from "./handlers/io.js";
import { SandboxRestartBatcher, flushSandboxGrants } from "./handlers/sandbox-allow.js";
import { answerProviderRuntimeHeaders } from "./handlers/server-requests.js";
import { SessionTitleListener } from "./handlers/session-titles.js";
import { ClientRegistry } from "./remote/broadcast.js";
import { AGENT_INFO, clientConnectionRoot, PROTOCOL_VERSION, log, warn } from "./utils.js";

/** Client capabilities advertised in the initialize request. */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  auth?: Record<string, unknown>;
  elicitation?: { form?: unknown; url?: unknown };
  _meta?: Record<string, unknown>;
}

/** A pending prompt turn. */
export interface PendingTurn {
  zcodeSid: string;
  cancelled: boolean;
  /** Set once session/stop has been fired for this turn, to avoid re-sending. */
  stopSent?: boolean;
  /**
   * True once the backend ACCEPTED this turn's session/send — the turn may
   * own a running generation from that moment (its turn.started can lag or,
   * on a deaf stream, never arrive). stopBackendTurn's compaction guard only
   * spares turns whose send was NEVER accepted: those own nothing.
   */
  sendAccepted?: boolean;
  /**
   * Foreground execution id from the backend's `turn.started` payload. The
   * v4/command stop targets it — session/stop alone is ignored by the Aug-28
   * app-server (its abort controller is never registered; see AGENTS.md).
   */
  foregroundExecutionId?: string;
  /**
   * Set when the turn was ended by the stall-recovery heuristic (backend
   * reported idle after a silence) rather than a real turn.completed event.
   * prompt() skips auto-compact for such turns — the completion was inferred,
   * and compressing an in-flight task's context would destroy the work.
   */
  stallRecovered?: boolean;
  /**
   * True when this turn belongs to a goal-loop round (ADR-0022) instead of a
   * client prompt. preemptInFlightTurn must SKIP these turns (park the
   * incoming prompt instead of cancelling) — user text merges at the round
   * boundary. ESC/cancel() still cancels them like any pending turn.
   */
  goalLoop?: boolean;
  /**
   * Set by flushSandboxGrants on a goalLoop turn it is about to cancel for a
   * backend restart: the driver then treats the cancel as "re-dispatch the
   * current ticket on the respawned backend" instead of a user ESC pause.
   */
  sandboxRestart?: boolean;
  /**
   * Set when the turn was rejected because a detached auto-compact held the
   * backend prompt lock (busy 1308): the send was never delivered and the
   * caller told the user to resend. The goal-loop driver keys its
   * wait-and-retry off this flag — runOneTurn never queues behind a
   * compaction (the queued listener would inherit the compaction's whole
   * internal-turn stream as residue).
   */
  compactRejected?: boolean;
}

/**
 * How long a "loaded in backend" verification stays trusted. The backend
 * evicts resident runtimes after ~10min idle (observed
 * `session.resident_deactivated`, idleTimeoutMs 600000) and also keeps a
 * small LRU cap, after which every session-scoped RPC fails with
 * "Session is not active" (-32004). Trusting a verification for half the
 * eviction window makes callers redo the resume RPC well before eviction
 * can bite.
 */
export const BACKEND_RESIDENT_TTL_MS = 5 * 60_000;

export class ZcodeAcpServer {
  /** The ZCode subprocess client (lazy — spawned on first use). */
  backend: ZcodeBackend | null = null;
  /** acp_sid → zcode session id (usually identical, but kept for clarity). */
  readonly sessionMap = new Map<string, string>();
  /**
   * Reverse map: zcode session id → acp_sid. The background-task listener only
   * knows the zcode sid (it comes from backend events), but ACP notifications
   * must address the acp_sid the client knows. Usually the two are identical,
   * but forked/loaded sessions can diverge, so we maintain an explicit reverse
   * index rather than assuming equality.
   */
  readonly acpSidByZcodeSid = new Map<string, string>();
  /**
   * Sessions returned by `session/new` whose backend session has not been
   * created yet (acp_sid → { cwd }). session/new defers `session/create` until
   * the session is first used, so an editor startup that never prompts leaves
   * no empty session in the backend or the App's task index. `ensureRealSession`
   * materializes these on first use; entries live only as long as the bridge
   * process (a never-used placeholder vanishes with it).
   *
   * `creating` holds the in-flight materialization promise while a first-use
   * create is running, so concurrent first-uses (e.g. a raced double prompt)
   * share one `session/create` instead of creating two backend sessions.
   */
  readonly pendingSessions = new Map<
    string,
    {
      cwd: string;
      creating?: Promise<string>;
      /** Client-provided MCP servers from session/new, replayed verbatim into
       * the backend's session/create when the lazy session materializes. The
       * backend's mcpServers schema matches the ACP array shape (stdio entries
       * carry command/args/env; remote entries carry type/url), so entries are
       * passed through unchanged. */
      mcpServers?: acp.McpServer[];
    }
  >();
  /**
   * Session cwds (acp_sid → cwd), recorded at session/new and lazy-recovery.
   * Unlike pendingSessions this survives materialization — the hub discovery
   * payload needs a workspace label for live sessions, whose pending entries
   * are deleted on first use.
   */
  readonly sessionCwds = new Map<string, string>();
  /**
   * Client-provided MCP servers per ACP session id. Like sessionCwds this
   * survives materialization: the backend treats mcpServers as per-load
   * runtime config, NOT persisted session state, so every later backend
   * load/resume/reload (idle eviction, respawn, drain) must re-send them or
   * the session silently loses its client MCP tools (#193).
   */
  readonly sessionMcpServers = new Map<string, acp.McpServer[]>();
  /**
   * In-flight `session/resume` single-flight, keyed by backend session id
   * (ADR-0017 first-entry race): the hub answers the App's incubation request
   * as soon as the TUI's bridge REGISTERS — before the TUI's boot-resume
   * finishes — so the App's `session/load` for the SAME backend session can
   * run concurrently and both would send `session/resume`. Concurrent callers
   * instead join the first flight (see resumePreservingModel); the loser's
   * `session/messages` query then lands AFTER hydration, not mid-restore
   * (a mid-restore query returns a prefix and the first-entry replay "ends
   * in the middle").
   */
  readonly resumeInFlight = new Map<string, Promise<unknown>>();
  /**
   * Backend session ids whose last settle poll hit RESUME_SETTLE_CAP_MS while
   * hydration was still growing (see fetchMessagesSettled): a later plain
   * session/messages read can still land mid-restore, so already-live load /
   * resume paths re-settle before replaying (fetchMessagesForReplay). Cleared
   * by any settle that reaches two stable reads.
   */
  readonly hydrationUnsettled = new Set<string>();
  /**
   * Largest session/messages snapshot length ever observed by a settle for a
   * backend session id. A re-settle (marker armed by a capped settle) treats
   * one non-growing read that reaches this watermark as caught-up: big
   * sessions' reads take seconds each, and demanding the full two-stable
   * plateau inside the cap again meant the marker never cleared — every
   * session/load re-paid a capped settle (observed 2026-09-20 on a 7413-
   * message session: 22–56s loads). Reset on backend respawn — a rehydrating
   * session starts growing from zero again.
   */
  readonly hydrationWatermark = new Map<string, number>();
  /**
   * Backend session ids with a DETACHED auto-compact in flight (see
   * runAutoCompactDetached in config/auto-compact.ts). The turn that armed it
   * has already returned — cancel/preempt must not touch the compaction, the
   * drain gate must not escalate on it, and a concurrent prompt's busy-retry
   * extends its budget to the compaction settle bound instead of failing.
   */
  readonly autoCompactInFlight = new Set<string>();
  /**
   * Last compact terminal state per backend session id, recorded from the
   * backend's `state.updated` notification (reasons `session_compacted` /
   * `session_compact_cancelled` / `session_compact_failed`) — the RPC ack
   * alone cannot distinguish success from a swallowed background failure
   * (see ZcodeBackend.onCompactOutcome).
   */
  readonly compactOutcomes = new Map<string, { reason: string; at: number }>();
  /**
   * Last model/thought choice per backend session id (config spelling), set
   * by every switch path (setConfigOption + the setModel/setThoughtLevel
   * extensions) and re-applied after every resume — the backend's own
   * selection entry can be lost (see LazySessionRecord.modelChoice), and a
   * resumed session silently reverts to the workspace default while the
   * editor dropdown still shows the user's choice. Survives backend
   * respawns on purpose (it is per-session, not per-process state).
   */
  readonly sessionModelChoices = new Map<string, { model?: string; thought?: string }>();
  /**
   * True once THIS backend process rejected a session/send with the
   * whole-turn busy error (-32010 "A prompt is already running for this
   * session"). 0.16.9 source semantics (sendPrompt's activeAbortController
   * guard, server-operations.ts): the busy window spans the ENTIRE turn, so
   * a mid-turn send can never be silently accepted as steer — while set, the
   * prompt path skips the drain gate's pre-send poll and lets the send
   * busy-retry loop be the single readiness authority. 0.16.5 accepts
   * mid-generation sends as (silently dropped) steer input, so backends
   * that never showed the rejection keep the full drain gate. Behavioral
   * evidence only — no version sniffing. Reset on backend respawn.
   */
  observedSendBusyReject = false;
  /**
   * Sandbox dynamic-allow state (ADR-0011): realpaths granted for this
   * bridge lifetime ("仅此一次" answers) — folded into the Seatbelt profile
   * on the next backend respawn in ensureBackend().
   */
  readonly sandboxOnceAllows = new Set<string>();
  /**
   * Deny paths already asked about, per ACP session — the debounce behind
   * the allow popup (the model retries the same path and must not re-ask).
   * Value is the ask timestamp: Infinity after a user decision or a
   * structural hint; a FAILED ask (timeout / dead channel / killed by
   * another grant's restart) keeps its timestamp and re-asks after the
   * cooldown (see handleSandboxDenial).
   */
  readonly sandboxAskedPaths = new Map<string, Map<string, number>>();
  /**
   * EACCES ("Permission denied") paths already hinted, per ACP session — the
   * model routinely probes unreadable directories and each real path gets
   * exactly one hint (see the filesystem-permission scan in session.ts's
   * turn loop; kept separate from sandboxAskedPaths so one flow's debounce
   * never silences the other).
   */
  readonly fsDeniedPaths = new Map<string, Set<string>>();
  /**
   * Continuation prompts waiting to run after a sandbox allow restart, per
   * ACP session — set by the batch flush, consumed by prompt() after the
   * interrupted turn unwinds (the new turn tells the model the write is now
   * permitted and to resume the task).
   */
  readonly sandboxContinuations = new Map<string, string>();
  /**
   * Batched sandbox allow-restarts (ADR-0011): approvals collect for one
   * window, then flushSandboxGrants() (handlers/sandbox-allow.ts) performs a
   * single cancel-wave + continuation + backend close. One restart per
   * popup used to kill the sibling popups still pending on other denied
   * paths.
   */
  readonly sandboxRestartBatcher = new SandboxRestartBatcher((grants) =>
    flushSandboxGrants(this, grants),
  );
  /**
   * Whether the current backend subprocess was spawned under sandbox-exec.
   * Process-level fact (not config wish): EPERM in tool output can only come
   * from a sandboxed process, and applySandboxFlip() needs to detect a
   * config-armed sandbox facing an unsandboxed live backend.
   */
  backendSandboxed = false;
  /**
   * Currently running turns, keyed by the ACP request id (JSON-RPC ids may be
   * numbers or strings; set/delete always use the same value, so the wider
   * key type is only for honesty).
   */
  readonly pendingTurns = new Map<number | string, PendingTurn>();
  /**
   * Per-session (zcodeSid) preempt lock: a promise chain that serializes the
   * "register self + preempt others" critical section in prompt(). Prevents
   * concurrent prompts from both missing each other and registering at once.
   */
  readonly preemptLocks = new Map<string, Promise<void>>();
  /** Capabilities advertised by connected clients (Zed, JetBrains, remote). */
  clientCapabilities: ClientCapabilities = {};
  /**
   * Client name from `initialize` clientInfo ("martty", "Zed", …). Gates
   * client-specific behavior (the TUI resume history replay).
   */
  clientName: string | null = null;
  /**
   * Sticky: some client named ≈"martty" completed `initialize` this process.
   * `clientName` alone is last-write-wins across the stdio editor and remote
   * WS attaches (a phone app initializing between the TUI's initialize and
   * its session/new would blank it mid-boot), so martty-gated behavior reads
   * this flag instead.
   */
  marttyClientSeen = false;
  /**
   * Connection roots (clientConnectionRoot identity) of connections known to
   * be Martty — recorded at THAT connection's `initialize`, never inherited
   * from the process-wide sticky flag (a phone app initializing after the TUI
   * must not become a dock target). The quota dock refresher (ADR-0021)
   * targets exactly these connections with `config_option_update`s, and
   * buildConfigOptions appends the pseudo `quota` option only for them;
   * editors must not see it.
   */
  readonly marttyConnectionRoots = new Set<unknown>();
  /**
   * Latest formatted quota dock string (ADR-0021), or null when the last
   * refresh failed / has nothing to show. Maintained by src/quota/live.ts;
   * read by buildConfigOptions when appending the read-only `quota` option.
   */
  quotaDock: string | null = null;
  /**
   * One-shot banner-handshake scope (see BOOT_RESUME_TRIGGER): the
   * `connectionContext` identity of the client whose boot-resumed session/new
   * armed the trigger. Only THAT connection's first `session/prompt` can
   * spend it — prompts from other attached clients (a phone app racing the
   * boot window) never disarm it. Null once spent or when the auto-submit was
   * lost (the same connection's first prompt was something else).
   */
  bootResumeTriggerConnection: unknown = null;
  /**
   * Hub session-create binding (remote create, ADR-0016): when the hub
   * incubates a TUI for a remote session-create it pre-generates the ACP
   * session id (ZCODE_ACP_BOOT_CREATE_SESSION + ZCODE_ACP_RESUME_SESSION), so
   * the TUI window at boot AND the attaching phone adopt the SAME session on
   * their first session/new — without it each mints its own placeholder and
   * the phone's conversation never reaches the window (two sessions, updates
   * dropped on the sessionId mismatch). Unlike the one-shot resume env, the
   * bind persists for the bridge's lifetime; each connection claims it once.
   */
  bootCreateBindSession: string | null = null;
  /** Connection roots that already claimed the create bind (see above). */
  readonly bootCreateBindClaimed = new Set<unknown>();
  /**
   * All connected ACP clients (the stdio editor plus any remote WebSocket
   * clients). Handlers push notifications through `clients.broadcast()` so
   * every attached client sees the same stream; the registry replaces the old
   * single `acpClient` reference. Background listeners use it to push
   * `session/update` notifications outside request handlers.
   */
  readonly clients = new ClientRegistry();
  /**
   * Lightweight session summaries for the remote hub's discovery API
   * (acp_sid → { title, updatedAt, hasActivity }). In-memory only — the hub
   * holds no business state and the bridge dies with its editor, so
   * persistence would buy nothing. Maintained by `touchSessionSummary` at
   * session registration, title set, and turn completion. `hasActivity` gates
   * the discovery payload: an editor restart auto-resumes its stored
   * placeholder, materializing an empty backend session — never-used sessions
   * stay invisible to remote clients until first real use.
   */
  readonly sessionSummaries = new Map<
    string,
    { title?: string; updatedAt: number; hasActivity?: boolean }
  >();
  /** Session titles already set, to enforce set-once (acp_sid → title). */
  readonly sessionTitles = new Map<string, string>();
  /**
   * Placeholders minted by a REMOTE-driven session/new (the hub's create-bind
   * or any serve-mode mint). Remote clients have no editor-side session
   * storage, so discovery advertises these in the ACTIVE session list even
   * before the first turn (while they are still pure placeholders). Locally
   * minted ones stay invisible until first use.
   */
  readonly remoteCreatedSessions = new Set<string>();
  /**
   * Sessions verified as loaded in the CURRENT backend subprocess, with the
   * verification timestamp — populated only after a successful
   * session/create or session/resume RPC and refreshed when a turn runs. A
   * bare `registerSession` mapping does NOT qualify, and neither does an old
   * timestamp: the backend answers `session/messages` only for sessions with
   * a live resident runtime, so `session/load` must not skip the resume RPC
   * for those (the replay would silently come back empty). Use
   * `markBackendLoaded`/`isBackendSessionLive` instead of touching the map.
   */
  readonly backendLoadedSessions = new Map<string, number>();
  /**
   * Sessions eligible for the one-shot auto-title. Only `session/new`
   * populates this — resumed/loaded sessions already carry a title, so their
   * first post-load message must NOT overwrite it. (sessionTitles alone can't
   * distinguish "freshly created" from "resumed but not yet titled in-process".)
   */
  readonly titleEligibleSessions = new Set<string>();
  /** Last mode id advertised to the client (acp_sid → modeId), for change detection. */
  readonly lastMode = new Map<string, string>();
  /**
   * Timestamp of the last cancel (user stop or preempt), keyed by zcodeSid.
   * Set in cancel() and preemptInFlightTurn(); read in runEventTurn's stall
   * reconciliation to fast-fail turns that collide with the backend's
   * ~20s model-connection recovery window after a mid-stream abort.
   */
  readonly lastCancelledAt = new Map<string, number>();
  /** Per-session ProjectionDiffers (persists across turns). */
  readonly differs = new Map<
    string,
    import("./translators/projection-differ.js").ProjectionDiffer
  >();
  /** Per-session model cache for configOptions model dropdown. */
  readonly modelCache = new Map<string, string>();
  /**
   * Per-session (zcodeSid) FULL model-availability list, captured from the
   * `session/create` snapshot (`settings.model.available`). Only create/resume
   * return the complete list with authoritative `reasoning.defaultLevel` —
   * `session/read` answers `modelAvailability:"current"` (just the active
   * model). Model switches need a target's default reasoning level, so this
   * cache is the lookup; an entry that declares no levels simply has none.
   */
  readonly modelAvailability = new Map<
    string,
    Array<{ providerId?: string; modelId?: string; defaultLevel?: string }>
  >();
  /**
   * Per-session (zcodeSid) background-task listeners. Registered once when a
   * session is created/resumed/loaded and lives across prompts, forwarding
   * background task status + result notifications to the client outside of
   * request handlers. The turn loop's own listener coexists with this one
   * (backend.listeners is now a Set per session).
   */
  readonly backgroundListeners = new Map<string, BackgroundTaskListener>();
  /**
   * Backend instance each session's out-of-band listeners were registered on.
   * The backend can be REPLACED mid-session (sandbox arm-flip, dynamic allow
   * batches, dead-reader recovery) and listeners are per-instance — when this
   * map's entry differs from the current backend, ensureBackgroundListener
   * re-registers (also called from the prompt path so a respawn heals on the
   * next turn, not just on resume/load).
   */
  readonly backgroundListenerBackend = new Map<string, ZcodeBackend>();
  /**
   * Sessions (zcodeSid) whose background NOTIFICATION turn (the model
   * summarising a finished background task) is currently running, → start
   * time. Maintained by BackgroundTaskListener; read by the prompt path to
   * extend the send busy-retry budget — a notification turn is a real model
   * turn and easily outlives the normal 30s busy window, after which the
   * user's prompt would fail outright (#194-adjacent UX).
   */
  readonly notifyTurnActiveSince = new Map<string, number>();
  /**
   * Sessions (acpSid) whose title was set by MANUAL user intent (the remote
   * rename endpoint, or a `session.titleUpdated` push with source "custom"
   * from another surface). The backend's later `generated` title pushes must
   * not override these (SessionTitleListener).
   */
  readonly titleUserSetBy = new Set<string>();
  /**
   * Per-Bash-callId stdout snapshot already streamed via terminal_output. Used
   * by dispatchTerminalUpdate for two dedup guards:
   *   - progress: diff cumulative stdoutTail snapshots, emit only the suffix.
   *   - result:   if present, the output was already streamed → skip replay.
   * Presence of a key also signals "progress fired for this call" (absent =
   * short command with no progress, so the result emits output once).
   */
  readonly terminalSentData = new Map<string, string>();
  /** Monotonic id counter; base 10_000_000 to avoid collisions with zcode-originated ids. */
  private msgCounter = 10_000_000;

  /**
   * Headless serve mode (ADR-0014): this bridge was hub-spawned for ONE known
   * project (the process cwd). session/new then ignores client-supplied cwds
   * and always uses the process cwd — the remote create-whitelist stays
   * closed end to end (a client cannot steer a serve bridge into another
   * directory).
   */
  readonly serveMode: boolean;

  constructor(opts: { serveMode?: boolean } = {}) {
    this.serveMode = opts.serveMode === true;
  }

  /** Next JSON-RPC id for messages we send to zcode. */
  nextId(): number {
    return ++this.msgCounter;
  }

  /**
   * Lazily spawn the zcode backend on first use (initialize doesn't need it).
   * With the sandbox armed (ZCODE_ACP_SANDBOX=1 globally, or any live
   * workspace's .zcode/acp/sandbox.json — ADR-0011), the spawn is wrapped in
   * a Seatbelt profile built from the live workspace roots — session/new
   * records cwds before any backend RPC (lazy placeholders), so the whitelist
   * is complete by the time the backend materializes here.
   */
  ensureBackend(): ZcodeBackend {
    if (this.backend && !this.backend.isDead) return this.backend;
    // builtinProviderEnv injects the CLI's built-in provider table the way the
    // desktop host does — a bare .app-bundle CLI cannot find it on its own.
    const env = { ...mergeEnvWithCreds(loadZcodeCredentials()), ...builtinProviderEnv() };
    let argv = resolveZcodeCommand();
    this.backendSandboxed = sandboxActive(this.sandboxRoots());
    if (this.backendSandboxed) {
      const { workspaces, extraAllow } = collectSandboxWorkspaces(this.sandboxRoots());
      argv = armSandboxArgv(argv, {
        workspaces,
        extraAllow: [...extraAllow, ...this.sandboxOnceAllows],
      });
      // Birth-mark the wrapped process: the marker is inherited down any
      // spawn chain (a hub (re)spawned below a sandboxed backend carries
      // it), and the hub's boot check uses it to self-relaunch outside the
      // sandbox via launchd — a hub born inside Seatbelt cannot open the
      // visible terminal (macOS TCC attributes its `open -a Terminal` to
      // "Sandbox" and Terminal silently refuses), and Seatbelt itself can
      // never be escaped from within.
      env.ZCODE_ACP_SANDBOX_ACTIVE = "1";
    }
    const backend = new ZcodeBackend(argv, env);
    this.backend = backend;
    // Fresh backend process: every session rehydrates from scratch, so the
    // settle bookkeeping from the previous instance is void.
    this.hydrationUnsettled.clear();
    this.hydrationWatermark.clear();
    this.compactOutcomes.clear();
    // …and the send-semantics evidence: the respawned process may be an
    // older build that still accepts mid-turn sends as steer.
    this.observedSendBusyReject = false;
    // Answer the provider runtime-headers handshake the moment it ARRIVES:
    // the backend asks before every model request on a zhipu-account provider,
    // and outside a turn loop (compact's internal turn, session/goal set) the
    // queued request went unanswered until the backend's 180s cap killed the
    // generation ("Captcha verification request timed out" — auto-compact
    // silently failed this way; see answerProviderRuntimeHeaders). The reply
    // work (config reads, CLI resolution) is deferred off the shared reader
    // loop; the backend waits seconds for this handshake, a tick is free.
    // Captures the LOCAL instance: a respawned backend must never receive
    // replies for a frame the dying one asked.
    backend.providerRuntimeHeadersResponder = (id, params) => {
      setImmediate(() => {
        try {
          answerProviderRuntimeHeaders(
            backend,
            id,
            "interaction/requestProviderRuntimeHeaders",
            params,
          );
        } catch (e) {
          warn(
            `provider runtime headers responder threw, declining: ` +
              `${e instanceof Error ? e.message : String(e)}`,
          );
          try {
            backend.sendReply(id, { headersApplied: false, errorMessage: "bridge error" });
          } catch {
            /* backend gone — nothing to answer */
          }
        }
      });
      return true;
    };
    // Record compact terminal states (per-session) as they arrive — compact()
    // reads the entry after its lock wait to detect failures the RPC never
    // reports.
    backend.onCompactOutcome = (sid, reason) => {
      this.compactOutcomes.set(sid, { reason, at: Date.now() });
    };
    return backend;
  }

  /**
   * Mark every in-flight turn cancelled — used right before killing the
   * backend WHOLESALE (sandbox arm-flip / allow restart). Those turn loops
   * would otherwise wait on a dead reader with no stall signal (the backend
   * is gone, so no events ever arrive) and hang until the freeze watchdog,
   * ~10 minutes per turn. stopSent: no stop pair is needed — the entire
   * process group dies with the backend.
   */
  cancelAllPendingTurns(skipGoalLoop = false): void {
    for (const turn of this.pendingTurns.values()) {
      if (skipGoalLoop && turn.goalLoop) continue;
      turn.cancelled = true;
      turn.stopSent = true;
    }
  }

  /**
   * Workspace roots that parametrize the sandbox decision/profile: every live
   * session's cwd, falling back to the bridge's own cwd before any session.
   */
  sandboxRoots(): Set<string> {
    const roots = new Set(this.sessionCwds.values());
    if (roots.size === 0) roots.add(process.cwd());
    return roots;
  }

  /**
   * Project-level sandbox flip (ADR-0011): flipping `enabled: true` in a live
   * workspace's .zcode/acp/sandbox.json arms the sandbox mid-run, without a
   * global env. If the flip happened after the current backend spawned
   * unsandboxed, kill it — the caller's next ensureBackend() respawns under
   * the profile, and prompt()'s subscribe recovery reloads the session. The
   * reverse (flipping back to false) never restarts a live sandboxed backend;
   * the next natural respawn drops the wrap. Best-effort: a failed kill
   * leaves things as they were (the sandbox arms on a later respawn).
   */
  async applySandboxFlip(): Promise<void> {
    if (this.backendSandboxed) return;
    if (!this.backend || this.backend.isDead) return;
    if (!sandboxActive(this.sandboxRoots())) return;
    warn("sandbox: project config armed mid-run — restarting backend under sandbox-exec");
    this.cancelAllPendingTurns();
    try {
      await this.backend.close();
    } catch (e) {
      warn(`sandbox: backend kill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Resolve the zcode session id for an ACP session id. */
  resolveSid(acpSid: string): string | undefined {
    return this.sessionMap.get(acpSid);
  }

  /**
   * Register the acp_sid ↔ zcode_sid mapping both ways. Use this instead of
   * `sessionMap.set(...)` directly so the reverse index stays in sync (the
   * background-task listener needs the reverse lookup to address notifications).
   */
  registerSession(acpSid: string, zcodeSid: string): void {
    this.sessionMap.set(acpSid, zcodeSid);
    this.acpSidByZcodeSid.set(zcodeSid, acpSid);
    this.touchSessionSummary(acpSid);
  }

  /** Record that a session is loaded in the current backend subprocess (now). */
  markBackendLoaded(acpSid: string): void {
    this.backendLoadedSessions.set(acpSid, Date.now());
  }

  /**
   * True when the session was verified backend-loaded recently enough that the
   * backend's resident idle eviction (~10min) can't have dropped it. Stale or
   * unknown entries count as NOT live so callers redo the session/resume RPC.
   */
  isBackendSessionLive(acpSid: string): boolean {
    const at = this.backendLoadedSessions.get(acpSid);
    return at !== undefined && Date.now() - at < BACKEND_RESIDENT_TTL_MS;
  }

  /** Update a session's discovery summary (title sticky once set). */
  touchSessionSummary(acpSid: string, title?: string): void {
    const existing = this.sessionSummaries.get(acpSid);
    this.sessionSummaries.set(acpSid, {
      title: title ?? existing?.title,
      updatedAt: Date.now(),
      // A title only exists once the session produced content (auto-title on
      // first end_turn, or a stored title adopted on resume/load).
      hasActivity: existing?.hasActivity || title !== undefined,
    });
  }

  /**
   * Mark a session as having real interaction (a prompt turn ran, or history
   * was replayed on load). Gates the hub discovery payload — never-used
   * sessions stay invisible to remote clients until first use.
   */
  markSessionActive(acpSid: string): void {
    const existing = this.sessionSummaries.get(acpSid);
    this.sessionSummaries.set(acpSid, {
      title: existing?.title,
      updatedAt: Date.now(),
      hasActivity: true,
    });
  }

  /**
   * The bridge's project directory: the cwd of the most recently active
   * session, else the bridge process cwd (Zed spawns the server with the
   * worktree root as cwd). Recent-activity wins over Map order — insertion
   * order is arbitrary across load/resume timing, and a single polluted
   * entry ("/") must never decide the label for every session. Roots of "/"
   * are skipped entirely: they can only come from a client fallback, never a
   * real worktree.
   */
  projectCwd(): string {
    let best = "";
    let bestAt = -1;
    for (const [acpSid, cwd] of this.sessionCwds) {
      if (!cwd || cwd === "/") continue;
      const at = this.sessionSummaries.get(acpSid)?.updatedAt ?? 0;
      if (at > bestAt) {
        best = cwd;
        bestAt = at;
      }
    }
    return best || process.cwd();
  }

  /** Best-effort workspace label for the hub discovery payload. */
  workspaceLabel(): string {
    return this.projectCwd();
  }

  /**
   * Live goal-loop drivers by backend session id (ADR-0022). Membership = a
   * loop is RUNNING for that session (terminal drivers deregister in the
   * run() finally). The prompt path consults this to park user prompts on
   * the driver instead of preempting its turns.
   */
  readonly goalLoops = new Map<string, import("./goal-loop/driver.js").GoalLoopDriver>();

  /**
   * zcodeSids that already got the goal-loop recovery hint on session/load
   * this bridge process (each editor (re)attach would otherwise replay it).
   */
  readonly goalLoopLoadHints = new Set<string>();

  /**
   * Ensure a background-task listener is registered for the session. Idempotent
   * — returns the existing listener if already registered (covers resume/load
   * after new, and fork). Lives for the whole session so background agents that
   * finish AFTER `session/prompt` returns still get their status/result
   * forwarded to the client. The turn loop's own listener coexists via the
   * backend's per-session listener Set.
   */
  ensureBackgroundListener(zcodeSid: string): BackgroundTaskListener {
    const backend = this.ensureBackend();
    const existing = this.backgroundListeners.get(zcodeSid);
    if (existing && this.backgroundListenerBackend.get(zcodeSid) === backend) return existing;
    // Fresh session, or the backend was respawned since registration —
    // (re-)register on the CURRENT instance; the old instance's listener set
    // died with it, so there is no duplicate-registration risk.
    const listener = existing ?? new BackgroundTaskListener(this, zcodeSid);
    this.backgroundListeners.set(zcodeSid, listener);
    backend.registerEventListener(zcodeSid, listener);
    // The session-scoped title listener rides the same registration site and
    // lifetime: one registration covers both out-of-band consumers.
    backend.registerEventListener(zcodeSid, new SessionTitleListener(this, zcodeSid));
    this.backgroundListenerBackend.set(zcodeSid, backend);
    log(`  [bg] background listener registered for ${zcodeSid}`);
    return listener;
  }

  /**
   * Terminal records for in-flight background tasks before the backend
   * subprocess is torn down — the CLI's in-memory task registry dies silently
   * with the adapter, so without this the client's task cards hang in
   * in_progress forever (#194). Best-effort; called from shutdown paths.
   */
  async emitBackgroundTaskShutdownRecords(): Promise<void> {
    for (const listener of this.backgroundListeners.values()) {
      try {
        await listener.emitShutdownRecords();
      } catch (e) {
        warn(
          `shutdown task records failed for ${listener.zcodeSid}: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** Resolve the ACP session id for a zcode session id (reverse of resolveSid). */
  resolveAcpSid(zcodeSid: string): string | undefined {
    return this.acpSidByZcodeSid.get(zcodeSid);
  }

  /**
   * Every ACP alias attached to the same backend conversation — at least
   * [acpSid] itself. Two clients can hold DIFFERENT acpSids for one
   * conversation (a fresh session/new placeholder in one, a session/list id
   * resumed in another), and clients route session-scoped notifications by
   * the payload sessionId. Anything emitted under the prompting client's id
   * alone is silently dropped by every client holding another alias, so
   * session-scoped emits (updates, turnState, prompt echo) must loop this
   * list. A client holding two aliases of one conversation gets both copies —
   * pathological, accepted.
   */
  sessionAliases(acpSid: string): string[] {
    const zcodeSid = this.sessionMap.get(acpSid);
    if (!zcodeSid) return [acpSid];
    const aliases: string[] = [];
    for (const [sid, zsid] of this.sessionMap) {
      if (zsid === zcodeSid) aliases.push(sid);
    }
    return aliases.length > 0 ? aliases : [acpSid];
  }

  /**
   * Push a `session/update` notification to the client from OUTSIDE a request
   * handler (used by the background-task listener). Resolves the acp_sid from
   * the zcode_sid and no-ops (returning false) if the client or session is
   * unknown. Never throws — callers run in the event loop and must not crash
   * the bridge on a notification failure.
   */
  async notifyByZcodeSid(zcodeSid: string, update: acp.SessionUpdate): Promise<boolean> {
    if (this.clients.size === 0) return false;
    const acpSid = this.resolveAcpSid(zcodeSid);
    if (!acpSid) return false;
    try {
      // Broadcast notify swallows per-client failures internally (warn only).
      // Serialized through the replay guard so a background emission queues
      // behind an in-flight replay batch for the same session. Emitted per
      // attached alias (sessionAliases) so a client holding this conversation
      // under a different ACP id receives it too.
      let sent = false;
      for (const alias of this.sessionAliases(acpSid)) {
        await enqueueSessionSend(alias, () =>
          this.clients.broadcast().notify("session/update", { sessionId: alias, update }),
        );
        sent = true;
      }
      return sent;
    } catch (e) {
      log(`notifyByZcodeSid: session/update failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Whether the client declared `_meta.terminal_output` (Zed's Bash UI hook). */
  supportsTerminalOutput(): boolean {
    const meta = this.clientCapabilities._meta ?? {};
    return meta["terminal_output"] === true;
  }

  /**
   * Whether the client supports form-based elicitation (`clientCapabilities.
   * elicitation.form`). When true, AskUserQuestion / ExitPlanMode can use the
   * richer `elicitation/create` form UI; otherwise they fall back to
   * `session/request_permission`.
   */
  supportsElicitationForm(): boolean {
    return this.clientCapabilities.elicitation?.form != null;
  }

  /**
   * Whether a martty TUI is (or was) attached to this bridge process. Same
   * semantics as session.ts's isMarttyClient: the sticky flag wins because
   * clientName is last-write-wins across multi-client attaches. Used to gate
   * surfaces where martty's rendering is the limiting factor — its
   * request_permission overlay draws only the title, so plan approval needs
   * the elicitation form there; editors render toolCall.content and must NOT
   * be pushed to the form (its descriptions are plain text in Zed).
   */
  hasMarttyClient(): boolean {
    return this.marttyClientSeen || (this.clientName ?? "").toLowerCase().includes("martty");
  }

  /**
   * OR-merge capabilities from a newly connected client. Each connection runs
   * its own `initialize`; boolean capabilities are unioned across clients so a
   * feature advertised by ANY attached client (Zed or a remote one) enables the
   * richer interaction path, and `_meta` flags (e.g. terminal_output) merge
   * shallowly. Idempotent for re-connecting clients with equal capabilities.
   */
  mergeClientCapabilities(caps: ClientCapabilities): void {
    const cur = this.clientCapabilities;
    const next: ClientCapabilities = { ...cur, ...caps };
    next.fs = {
      readTextFile: cur.fs?.readTextFile || caps.fs?.readTextFile,
      writeTextFile: cur.fs?.writeTextFile || caps.fs?.writeTextFile,
    };
    next.terminal = cur.terminal || caps.terminal;
    next.elicitation = {
      form: cur.elicitation?.form || caps.elicitation?.form,
      url: cur.elicitation?.url || caps.elicitation?.url,
    };
    if (cur._meta || caps._meta) next._meta = { ...cur._meta, ...caps._meta };
    this.clientCapabilities = next;
  }

  /** Handle `initialize`: negotiate version + declare agent capabilities.
   *  `client` is the calling connection's AgentContext — martty identity is
   *  recorded PER CONNECTION here, so later non-martty attaches never inherit
   *  quota-dock targeting from the sticky process flag. */
  async initialize(
    params: acp.InitializeRequest,
    client?: acp.AgentContext,
  ): Promise<acp.InitializeResponse> {
    const clientInfo = (params.clientInfo as { name?: string; version?: string } | null) ?? null;
    this.clientName = clientInfo?.name ?? null;
    if (client) this.clients.nameConnection(client, this.clientName ?? "");
    if ((this.clientName ?? "").toLowerCase().includes("martty")) {
      this.marttyClientSeen = true;
      const root = clientConnectionRoot(client);
      if (root !== undefined) this.marttyConnectionRoots.add(root);
    }
    this.mergeClientCapabilities((params.clientCapabilities as ClientCapabilities) ?? {});
    log(
      `initialize: client protocolVersion=${params.protocolVersion}` +
        `, client=${clientInfo?.name ?? "unknown"}` +
        `, version=${clientInfo?.version ?? "unknown"}` +
        `, elicitation.form=${this.clientCapabilities.elicitation?.form == null ? "no" : "yes"}`,
    );

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { ...AGENT_INFO },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
        // http MCP configs are forwarded verbatim to the backend (session/
        // create + resume), which mounts them fine — the declaration was the
        // only blocker keeping clients from sending http servers (#180).
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: { list: {}, resume: {}, fork: {} },
        // Read-only session file access lives on the bridge's loopback /fs
        // endpoint, hub-proxied at /api/instances/{id}/fs/* (ADR-0004).
        _meta: { zcode: { fs: true } },
      },
      // The GLM API key is read from ~/.zcode/v2/config.json by the ZCode
      // backend subprocess; the editor never needs to supply credentials.
      // Declared as AuthMethodAgent (no `type` field → defaults to "agent"),
      // which the ACP registry CI accepts as "agent self-handles auth".
      authMethods: [
        {
          id: "zcode-credentials",
          name: "ZCode built-in credentials",
          description:
            "Reads the GLM API key from ~/.zcode/v2/config.json managed by the ZCode desktop app. No editor-side credentials required.",
        },
      ],
    };
  }
}
