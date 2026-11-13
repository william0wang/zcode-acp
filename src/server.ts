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
  type BackendKind,
  loadZcodeCredentials,
  mergeEnvWithCreds,
  resolveZcodeCommand,
  type ZcodeLifecycleSnapshot,
  zcodeDataBaseDirEnv,
  ZcodeBackend,
} from "./backend/index.js";
import { armSandboxArgv, collectSandboxWorkspaces, sandboxActive } from "./backend/sandbox.js";
import { clearClosedSessionIds } from "./closed-sessions.js";
import {
  captureGate,
  ensureWorkflowPolicyPushed,
  resolveWorkflowGate,
  type WorkflowGate,
} from "./config/workflow-gate.js";
import { BackgroundTaskListener } from "./handlers/background-tasks.js";
import { emitSessionTurnState, enqueueSessionSend, TURN_STATE_METHODS } from "./handlers/io.js";
import { SandboxRestartBatcher, flushSandboxGrants } from "./handlers/sandbox-allow.js";
import {
  answerProviderRuntimeHeaders,
  sweepOrphanedServerRequests,
} from "./handlers/server-requests.js";
import { SessionTitleListener } from "./handlers/session-titles.js";
import { isSessionGoneError } from "./handlers/session.js";
import { pushInteractionIfOffline } from "./push/push.js";
import { ClientRegistry } from "./remote/broadcast.js";
import { envWithLoginShell } from "./remote/login-shell-env.js";
import { stopAllWorkflowRunPollers } from "./workflow/poller.js";
import { AGENT_INFO, clientConnectionRoot, PROTOCOL_VERSION, log, warn } from "./utils.js";

/** `session/list`'s `sessionIds` array schema cap (upstream index.ts) — the
 * batch tombstone-liveness oracle chunks at this bound. */
const SESSION_IDS_QUERY_BATCH = 64;

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
  /**
   * Backend kind this bridge serves (ADR-0023): fixed "zcode" until the dsh
   * adapter lands (its port wires --backend / ZCODE_ACP_BACKEND selection).
   * Capability gates read `backendCapabilities(backendKind)` — the single
   * enforcement point — so flipping the kind flips every gated surface.
   */
  readonly backendKind: BackendKind = "zcode";
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
   * session starts growing from zero again. The entry's PRESENCE is also the
   * generation marker: "this backend instance has settle-observed the store
   * (0 = observed empty is a valid write)". Replay paths re-settle a session
   * with NO entry instead of trusting a plain read (fetchMessagesForReplay);
   * session/create and fork seed 0 because a fresh store is complete by
   * construction.
   */
  readonly hydrationWatermark = new Map<string, number>();
  /**
   * Backend session ids with a compaction in flight — detached auto-compact
   * (see runAutoCompactDetached in config/auto-compact.ts) AND manual
   * /compact or direct session/compact calls (extensions.ts compact()
   * registers the same flag). The turn that armed it has already returned —
   * cancel/preempt must not touch the compaction, the drain gate must not
   * escalate on it, a concurrent prompt HOLDS on this flag instead of racing
   * the compact lock, and a busy-retry extends its budget to the compaction
   * settle bound instead of failing.
   */
  readonly autoCompactInFlight = new Set<string>();

  /**
   * Workflow display names for run-settle push titles (runId → name). Set at
   * launch time (settings/workflow.ts — the launch request knows the name);
   * read by the background-task arm sites and cleared by the poller's
   * teardown. Model-launched runs carry no name (title falls back to the run
   * id prefix).
   */
  readonly workflowRunNames = new Map<string, string>();
  /**
   * Bridge-side session-scoped "always allow" grants for the workflow
   * approval tools (SESSION_ALWAYS_TOOLS, src/interaction/adapter.ts):
   * zcodeSid → tool names the client approved for this session. The v3 wire
   * crops the backend's own session-always option, so the bridge re-offers
   * it and mirrors the grant here — the semantic copy of upstream's
   * in-memory grantSessionPermission, which dies with the backend runtime
   * (this map therefore clears at every backend respawn).
   */
  readonly sessionAutoAllows = new Map<string, Set<string>>();
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
  readonly sessionModelChoices = new Map<
    string,
    { model?: string; thought?: string; at?: number }
  >();
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
   * Dynamic-workflow gate verdict for the CURRENT backend generation
   * (desktop-host parity, src/config/workflow-gate.ts): an anonymous remote
   * read resolved ONCE per backend spawn and pinned to that instance — a
   * server-side mode flip lands at the next respawn. session/create·resume
   * params await it (workflowFlag in handlers/session.ts); the process-wide
   * policy push chains off it in ensureBackend. Null before the first spawn
   * reads as disabled (fail-closed).
   */
  backendWorkflowGate: Promise<WorkflowGate> | null = null;
  /**
   * Per-backend-generation marker for the dynamic-workflow policy push: set
   * when `workspace/updateDynamicWorkflowPolicy` has been sent (spawn-time for
   * an enabled verdict, or on the first gate consumption after a local
   * override flips on — ensureWorkflowPolicyPushed). Reset at every spawn.
   */
  workflowPolicyPushed = false;
  /**
   * The push shape the current generation carried ("onDemand" | "alwaysOn" |
   * "boolean" | null) — a mode change re-arms the once-per-generation guard
   * (config/workflow-gate.ts). Reset at every spawn.
   */
  workflowPolicyPushedMode: "onDemand" | "alwaysOn" | "boolean" | null = null;
  /**
   * True once this backend generation ACCEPTED a mode-carrying policy push —
   * only then may session/create·resume carry `dynamicWorkflowMode` (3.15.1;
   * older strict schemas reject the key with no cheap retry on that path).
   * Reset at every spawn.
   */
  workflowModeOnWire = false;
  /**
   * True once this backend generation rejected the per-session `toolDenylist`
   * key on session/create·resume (pre-toolDenylist strict schema). While set,
   * the key is omitted up front instead of paying a rejected round-trip per
   * session — the tool policy is NOT applied on such a backend (warned once).
   * Reset at every spawn.
   */
  toolDenylistRejected = false;
  /**
   * `session/lifecycle/getState` availability on the CURRENT backend build:
   * null = not yet probed, true/false = the pinned verdict (app-server <
   * 0.17.1 answers method-not-found). Pinned per backend generation like
   * toolDenylistRejected — a respawned process may be an older build.
   */
  backendLifecycleApi: boolean | null = null;
  /**
   * `session/list`'s `sessionIds` key acceptance on the CURRENT backend build:
   * null = not yet probed, true = rejected (strict zod "Unrecognized key" —
   * fall back to per-id lifecycle probes), false = accepted. Pinned per
   * backend generation like toolDenylistRejected.
   */
  sessionIdsQueryRejected: boolean | null = null;
  /**
   * The full slash-command list (set once by buildAgentApp in index.ts).
   * Read by the gate-aware menu catch-up (resendMenuAfterGateSettled in
   * handlers/session.ts): a cold bridge's session/new snapshot predates the
   * workflow verdict, so the materialization path re-sends the menu once the
   * gate has settled.
   */
  allCommands: Array<{ name: string; description: string; input?: { hint: string } }> | null = null;
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
   *
   * Armed ONLY for a MARTTY connection (marttyConnectionRoots — the
   * per-connection identity, NOT the sticky process flag): the create-bind
   * path lets an attaching phone's session/new claim the same bind, and a
   * sticky-gated arm there re-pointed the handshake at the phone — the TUI's
   * auto-submitted trigger then missed the ack and reached the model
   * (observed live from the mobile app, 2026-09-23).
   */
  bootResumeTriggerConnection: unknown = null;
  /**
   * Per-connection `connectionContext` roots that have already submitted at
   * least one prompt. Backs the unarmed trigger fallback in runPrompt: a
   * martty connection's FIRST prompt is a candidate for the banner
   * handshake; anything after it is real user input.
   */
  readonly connectionPromptSeen = new Set<unknown>();
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
  /**
   * Sessions retired from discovery by a remote close (ADR-0006), with the
   * retirement time. Trailing activity from the dying conversation — a turn
   * that outlives the force-close settle bound, a late title push — must not
   * re-advertise them; a genuine later use clears the stamp via
   * `markSessionActive` (the close's documented re-arm).
   */
  readonly discoveryRetiredAt = new Map<string, number>();
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
   * for those (the replay would silently come back empty). Cleared wholesale
   * on backend respawn (resetBackendGeneration). Use
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
   * Backend sessions (zcodeSid) whose runtime plan flag is ON. EnterPlanMode/
   * ExitPlanMode flip the execution state's `planEnabled` WITHOUT touching
   * `runtime.config.mode`, so every v3 read (session/read settings, state
   * patches) keeps reporting the underlying mode — plan is invisible there
   * (verified in upstream source: session-mode-port.ts sets only the flag;
   * mapSessionSettings reads app.getMode()). Tracked here from the
   * SessionModeChanged events (v3 wire: generic `session.updated` with a raw
   * {mode, planEnabled} payload) and folded into every mode the bridge
   * displays or advertises.
   */
  readonly sessionPlanActive = new Set<string>();
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
   * `session/create`/`resume` snapshot (`settings.model.available`). Only
   * create/resume return the complete list with authoritative
   * `reasoning.defaultLevel` — `session/read` answers
   * `modelAvailability:"current"` (just the active model). Model switches
   * resolve the target's reasoning level from this cache first; an entry that
   * declares no levels simply has none (the backend's own "level-less" verdict).
   */
  readonly modelAvailability = new Map<
    string,
    Array<{ providerId?: string; modelId?: string; defaultLevel?: string; levels?: string[] }>
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
   * Backend sessions (zcodeSid → turnId) whose CURRENT turn was NOT driven by
   * a bridge prompt — background-subagent wake turns (`inputSource:
   * "background_task"`), `subagent_message` turns, control-only turns. The
   * turn loop only exists while a bridge-driven prompt is registered, so
   * without this bookkeeping those turns produce messages (via the background
   * listener's forwarding) while every running indicator reads idle: no
   * `turnState running:true`, `/status` idle, `replayMeta.turnActive` false —
   * the desktop showed a live streaming conversation as idle (observed live
   * 2026-11-12 on the mapon session: a sub-agent Review returned after the
   * main turn ended, the backend auto-continued for an hour, desktop idle).
   *
   * Upstream parity: the app-server's own taskActivityTracker
   * (packages/zcode-server-cli/src/server-core/taskActivityTracker.ts) keys
   * its running-session set off `turn.started` / `turn.terminal` facts
   * regardless of origin, and deriveZCodeTaskStatus reads
   * `runtime.activeTurnId` — a turn is a turn whoever started it. This map is
   * the bridge's mirror of that fact, fed by BackgroundTaskListener (which
   * sees every session event out-of-band). Maintained per turnId so an
   * interleaved turn's terminal cannot clear a newer active one; cleared on
   * backend respawn (resetBackendGeneration) and session close.
   */
  readonly foreignActiveTurns = new Map<string, string>();
  /**
   * Last USER-originated action (session/prompt or session/cancel, stamped via
   * noteUserActivity) on this bridge, epoch ms. Read by pushSettled's quiet
   * window: a settle within `push.quietMs` of it means the user is still at
   * the desk and the "come back" ping would be noise. Bridge-internal rounds
   * (sandbox continuations, goal-loop rounds) never stamp, so a settle long
   * after the user left still pushes.
   */
  lastUserActivityAt = 0;
  /**
   * Sessions (acpSid) whose title was set by MANUAL user intent (the remote
   * rename endpoint, or a `session.titleUpdated` push with source "custom"
   * from another surface). The backend's later `generated` title pushes must
   * not override these (SessionTitleListener).
   */
  readonly titleUserSetBy = new Set<string>();
  /**
   * Backend sessions (zcodeSid) whose FIRST auto title is already final: the
   * provisional seed has been replaced by (or settled as) the one allowed
   * generated title. Every later `generated` push is ignored — only a manual
   * rename (`custom` push, /rename, or the remote endpoint) may change the
   * title again. In-memory is sufficient: after a restart the backend re-pushes
   * the SAME stored title, so re-adopting it once is idempotent.
   */
  readonly autoTitleFinalized = new Set<string>();
  /**
   * Per-Bash-callId stdout snapshot already streamed via terminal_output. Used
   * by dispatchTerminalUpdate for two dedup guards:
   *   - progress: diff cumulative stdoutTail snapshots, emit only the suffix.
   *   - result:   if present, the output was already streamed → skip replay.
   * Presence of a key also signals "progress fired for this call" (absent =
   * short command with no progress, so the result emits output once).
   */
  readonly terminalSentData = new Map<string, string>();
  /**
   * Backend toolCallIds whose ACP tool card has been dispatched to clients
   * (backend callId → acp card id; identical on the live dispatch path). Feeds
   * the workflow-run guard in BackgroundTaskListener: a workflow background
   * task folds its progress into the CreateWorkflow card only when that card
   * is actually visible — otherwise the generic [background] card remains.
   * Bounded FIFO (old ids age out; callIds are never reused by the backend).
   */
  readonly dispatchedToolCalls = new Map<string, string>();
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
    // Offline-push hook (§5.1): fires inside requestAny's zero-clients branch.
    // The gate (clients.size / ACTIVE) lives in the push module; this wiring is
    // the only connection between the remote layer and the push module.
    this.clients.noClientsObserver = (method, params) =>
      pushInteractionIfOffline(this, method, params);
    // Orphaned-interaction sweep (see sweepOrphanedServerRequests): asks no
    // turn loop will ever poll — above all a background workflow run's — are
    // forwarded, pushed or settled instead of silently timing out. Unref'd,
    // never keeps the process alive; a no-op while the queue is empty.
    const sweep = setInterval(() => {
      void sweepOrphanedServerRequests(this).catch(() => undefined);
    }, 2_000);
    sweep.unref();
  }

  /** Next JSON-RPC id for messages we send to zcode. */
  nextId(): number {
    return ++this.msgCounter;
  }

  /**
   * Record that the ACP card for a backend tool call was dispatched (called
   * from dispatchEvent's ToolCallNew branch). Bounded: when the cap is hit the
   * oldest id ages out — a workflow run arms its poller within seconds of the
   * card appearing, so stale entries are irrelevant.
   */
  noteDispatchedToolCall(backendCallId: string, acpCallId: string): void {
    this.dispatchedToolCalls.set(backendCallId, acpCallId);
    if (this.dispatchedToolCalls.size > 2048) {
      const oldest = this.dispatchedToolCalls.keys().next().value;
      if (oldest !== undefined) this.dispatchedToolCalls.delete(oldest);
    }
  }

  /**
   * Lazily spawn the zcode backend on first use (initialize doesn't need it).
   * With the sandbox armed (ZCODE_ACP_SANDBOX=1 globally, or any live
   * workspace's .zcode/acp/sandbox.json — ADR-0011), the spawn is wrapped in
   * a Seatbelt profile built from the live workspace roots — session/new
   * records cwds before any backend RPC (lazy placeholders), so the whitelist
   * is complete by the time the backend materializes here.
   *
   * Async because the spawn env completes from a login-shell probe that must
   * never run synchronously (it would freeze this process's event loop for the
   * probe's full timeout). The in-flight probe is shared, so concurrent
   * callers pay for ONE shell.
   */
  async ensureBackend(): Promise<ZcodeBackend> {
    if (this.backend && !this.backend.isDead) return this.backend;
    // Dynamic-workflow gate (desktop-host parity): kick the remote verdict off
    // FIRST so the fetch parallels the login-shell probe and the spawn; the
    // verdict is pinned to THIS backend generation. The assignment happens
    // only in this spawn branch (re-entry on a live backend returns above),
    // so exactly one gate resolution — and one policy push (below) — exists
    // per backend instance. resolveWorkflowGate is fail-closed by design; the
    // catch is belt-and-braces so the field can never hold a rejected
    // promise (create/resume params await it). captureGate attaches the
    // settled-value collector AT CREATION so the first workflowGateNow read
    // after settlement sees the verdict (a read-time collector would be one
    // microtask late — enough to filter the first `/` menu of a session).
    const workflowGate = captureGate(
      resolveWorkflowGate().catch((): WorkflowGate => ({
        mode: "unknown",
        enabled: false,
        source: "default",
      })),
    );
    this.backendWorkflowGate = workflowGate;
    // Fresh backend generation: the policy-push marker from the previous
    // instance is void (its push went to a dead process), and the in-memory
    // session-always grants mirror the backend's own session ruleset, which
    // dies with the runtime.
    this.workflowPolicyPushed = false;
    this.workflowPolicyPushedMode = null;
    this.workflowModeOnWire = false;
    this.sessionAutoAllows.clear();
    // builtinProviderEnv injects the CLI's built-in provider table the way the
    // desktop host does — a bare .app-bundle CLI cannot find it on its own.
    // zcodeDataBaseDirEnv translates the bridge's ZCODE_HOME into the CLI's
    // own ZCODE_DATA_BASE_DIR spelling so both sides read the same data tree.
    // The login-shell completion goes FIRST so the provider/builtin env below
    // overrides it. An editor-launched bridge (Zed's extension host, a JetBrains
    // plugin) inherits launchd's environment — a bare PATH with no version
    // managers in it — so a backend spawned from it cannot find `node`, `npx`
    // or the user's own tools even though they work in a terminal. The CLI
    // shells out to project tooling (npm scripts, local binaries), so a
    // completed PATH changes what a session can actually do.
    const env = {
      ...(await envWithLoginShell()),
      ...mergeEnvWithCreds(loadZcodeCredentials()),
      ...builtinProviderEnv(),
      ...zcodeDataBaseDirEnv(),
    };
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
    // The backend's working directory is inherited from THIS process, which the
    // launch path already put in the project directory: a remote TUI window's
    // `.command` script `cd`s before exec (terminalTuiScript), and the headless
    // serve spawn passes `cwd` (defaultSpawnServe). Forcing a single `cwd` here
    // would be both redundant and wrong — the backend is one process shared by
    // every session, while the directory belongs to each window/session.
    const backend = new ZcodeBackend(argv, env);
    this.backend = backend;
    this.resetBackendGeneration();
    // Verdict observability (one line per spawn — a dark gate was previously
    // indistinguishable from an enabled one in the logs) plus the first enable
    // channel: the process-wide policy push, fire-and-forget through the
    // flip-aware helper (never awaited here — the per-session create/resume
    // flag is the second channel and must not depend on this flight). A
    // backend that dies before the gate resolves just fails the push
    // best-effort inside the helper.
    void workflowGate.then((gate) => {
      log(`workflow-gate: remote verdict mode=${gate.mode} source=${gate.source}`);
      if (gate.mode === "unknown") {
        warn("workflow-gate: client-config fetch failed — gate reads disabled (fail-closed)");
      }
      ensureWorkflowPolicyPushed(this);
    });
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
    // Feed `session/lifecycle/changed` pushes (>= 0.17.1) into the
    // backend-loaded stamps: a resident teardown (idle TTL / LRU eviction,
    // close) voids the stamps the moment it happens instead of at the next
    // BACKEND_RESIDENT_TTL_MS boundary. `ready` transitions deliberately do
    // NOT re-stamp — see applyLifecycleSnapshot.
    backend.onLifecycleChanged = (snap) => {
      this.applyLifecycleSnapshot(snap);
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
   * State void at every backend spawn — the previous process's residents,
   * hydration bookkeeping, compaction outcomes and send-semantics evidence all
   * died with it. Called from ensureBackend on every (re)spawn; exposed as a
   * method so the generation-reset contract itself is testable without
   * spawning a real backend.
   */
  resetBackendGeneration(): void {
    // Fresh backend process: every session rehydrates from scratch, so the
    // settle bookkeeping from the previous instance is void.
    this.hydrationUnsettled.clear();
    this.hydrationWatermark.clear();
    this.compactOutcomes.clear();
    // …and the send-semantics evidence: the respawned process may be an
    // older build that still accepts mid-turn sends as steer.
    this.observedSendBusyReject = false;
    // …and the toolDenylist schema verdict: the respawned build may accept it.
    this.toolDenylistRejected = false;
    // …and the session/lifecycle/getState verdict: the respawned build may
    // predate the family (0.17.1).
    this.backendLifecycleApi = null;
    // …and the session/list sessionIds-key verdict: the respawned build may
    // accept the batch query.
    this.sessionIdsQueryRejected = null;
    // …and the backend-loaded stamps: they vouch for residents of a process
    // that no longer exists. A surviving stamp kept isBackendSessionLive true
    // across a respawn, so session/load skipped the resume RPC and read a
    // backend that never loaded the session — the replay came back empty
    // (the backend's "Session is not active" is swallowed by fetchMessages),
    // or a prefix when a sibling client's re-resume was still hydrating.
    this.backendLoadedSessions.clear();
    // …and the foreign-turn tracking: the turns it holds ran on the dead
    // process and no terminal event will ever arrive for them. Best-effort
    // settle broadcast so a client left mid-"running" by the crash doesn't
    // spin until the session is next used — but the value is the /status
    // union (pendingTurns ∪ remaining foreign entries): a backend-lost
    // recovery respawn happens INSIDE runOneTurn with the turn still
    // registered, and a bare false would read the recovering session as idle
    // for the whole recovery turn (found in review 2026-11).
    for (const zcodeSid of [...this.foreignActiveTurns.keys()]) {
      this.foreignActiveTurns.delete(zcodeSid);
      const acpSid = this.acpSidByZcodeSid.get(zcodeSid);
      if (!acpSid) continue;
      const stillBusy =
        [...this.pendingTurns.values()].some((t) => t.zcodeSid === zcodeSid) ||
        this.foreignActiveTurns.has(zcodeSid);
      void emitSessionTurnState(this, acpSid, stillBusy);
    }
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

  /**
   * Apply a `session/lifecycle/changed` snapshot (>= 0.17.1) to the
   * backend-loaded stamps: a teardown transition (starting is the tail of a
   * teardown-driven re-activation, stopping/unloaded/faulted are the teardown
   * itself) voids every ACP alias of the backend session so the next use
   * re-resumes instead of trusting a stamp that predates the transition.
   *
   * `ready` deliberately does NOT re-stamp. Instance-ready and
   * projection-applied are two separate completion conditions upstream, and a
   * foreign activation (the v4 gateway's cold-resume, an automation wake)
   * rebuilds the runtime WITHOUT the bridge's per-load mcpServers (#193) and
   * toolDenylist (#340) — blessing it here would make session/load skip its
   * resume flight + settle and replay from a possibly mid-hydration
   * projection. The getState probe in ensureBackendResident is the only
   * ready-verifier: it fires on non-replay paths alone. Backend sessions
   * without an ACP mapping (other clients' sessions) are ignored.
   */
  applyLifecycleSnapshot(snap: ZcodeLifecycleSnapshot): void {
    if (snap.state === "ready") return;
    let touched = false;
    for (const [acpSid, zcodeSid] of this.sessionMap) {
      if (zcodeSid !== snap.sessionId) continue;
      if (this.backendLoadedSessions.delete(acpSid)) touched = true;
    }
    if (touched) {
      log(`lifecycle: ${snap.sessionId} → ${snap.state} — backend-loaded stamps voided`);
    }
  }

  /**
   * Connection roots whose clients render steered text locally (martty's
   * Send Now cell), by backend session. `_session/steering` records the
   * steerer when the agent takes the message; the drain echo
   * (echoSteeredInputs) excludes those roots so the steerer does not see
   * the injected text twice. Bounded per session — most sessions have one
   * steering client, whose root dedupes to a single entry. Accepted
   * trade-off: a later backend-internal guide (plan-approval feedback) that
   * drains for the same session skips that client's echo too.
   */
  readonly steerEchoSuppressedRoots = new Map<string, unknown[]>();

  /** Record a steering client's connection root for the drain-echo exclusion. */
  suppressSteerEcho(zcodeSid: string, root: unknown): void {
    if (root === undefined || root === null) return;
    const roots = this.steerEchoSuppressedRoots.get(zcodeSid) ?? [];
    if (!roots.includes(root)) roots.push(root);
    this.steerEchoSuppressedRoots.set(zcodeSid, roots.slice(-4));
  }

  /** Roots to exclude from this session's steer-drain echo (empty = none). */
  steerEchoExclusions(zcodeSid: string): Set<unknown> {
    return new Set(this.steerEchoSuppressedRoots.get(zcodeSid) ?? []);
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
    // Genuine use re-arms discovery after a remote close (ADR-0006): the
    // retirement stamp only ever suppressed TRAILING activity of the retired
    // conversation, and it must not suppress the next real one.
    this.discoveryRetiredAt.delete(acpSid);
    // And it clears the DURABLE close record for every spelling — the next
    // serve-bridge respawn must not re-retire a conversation the user
    // deliberately reopened (self-heal, both halves). No write when nothing
    // is recorded.
    clearClosedSessionIds([acpSid, this.resolveSid(acpSid)]);
    // Self-heal soft-delete tombstones (ADR-0031 amendment): using a session
    // again cancels its tombstone — the session itself, and project-wide when
    // the workspace had gone fully invisible (project delete). Fire-and-forget
    // best-effort; never blocks or breaks the activity path.
    void this.reviveTombstonesFor(acpSid);
  }

  /**
   * Retire a session from remote discovery (the ADR-0006 close): drop the
   * summary and the remote-created placeholder, and stamp the retirement so
   * activity landing AFTER the close cannot re-advertise the conversation.
   */
  retireDiscovery(acpSid: string): void {
    this.sessionSummaries.delete(acpSid);
    this.remoteCreatedSessions.delete(acpSid);
    this.discoveryRetiredAt.set(acpSid, Date.now());
  }

  /**
   * True when the session is currently retired from remote discovery — the
   * remote-close stamp an AUTO `session/load` checks so a client reconnect
   * ladder cannot resurrect the conversation (ADR-0006 follow-up): the load
   * replays history but skips the re-arm and answers
   * `_meta.zcode.sessionClosed: true`.
   */
  isDiscoveryRetired(acpSid: string): boolean {
    return this.discoveryRetiredAt.has(acpSid);
  }

  /**
   * True when the session was retired from discovery at or after `sinceMs` —
   * the guard a turn's settle path checks (`turnStartedAt`): a turn that was
   * already running when the close retired the conversation belongs to the
   * retired conversation, and its terminal activity must not resurrect it.
   */
  wasDiscoveryRetiredSince(acpSid: string, sinceMs: number): boolean {
    const at = this.discoveryRetiredAt.get(acpSid);
    return at !== undefined && at >= sinceMs;
  }

  /**
   * Which of `ids` the CURRENT backend can no longer serve — the oracle
   * behind tombstone retirement (#376). Uses the EXISTING backend only
   * (never spawns: the session/new revival path is fire-and-forget and must
   * stay free) and answers with the ids ABSENT from
   * `session/list {sessionIds}` — upstream drops both physically deleted and
   * soft-deleted (time_deleted) sessions there, and resume refuses both the
   * same way, so both deserve retirement while bridge-tombstoned sessions
   * (no time_deleted) keep reviving per the ADR-0031 self-heal contract.
   *
   * A backend whose schema predates the `sessionIds` key (strict zod
   * "Unrecognized key", verdict pinned per generation) falls back to per-id
   * `session/lifecycle/getState` probes (>= 0.17.1). Failure semantics: a
   * chunk that ERRORS or a thrown transport aborts further probing and
   * returns what earlier chunks already PROVED gone (each entry carries its
   * own positive evidence); an id with no verdict is simply absent — the
   * caller treats it as "revive blindly" (the pre-#376 behavior): a probe
   * hiccup must never un-revive a session the store still has.
   */
  async probeGoneBackendSessions(ids: string[]): Promise<Set<string>> {
    const gone = new Set<string>();
    const backend = this.backend;
    const unique = [...new Set(ids)].filter((id) => typeof id === "string" && id);
    if (!backend || unique.length === 0) return gone;
    try {
      if (this.sessionIdsQueryRejected !== true) {
        for (let i = 0; i < unique.length; i += SESSION_IDS_QUERY_BATCH) {
          const chunk = unique.slice(i, i + SESSION_IDS_QUERY_BATCH);
          const resp = await backend.request(
            this.nextId(),
            "session/list",
            { sessionIds: chunk },
            15000,
          );
          if (resp.error) {
            if (
              this.sessionIdsQueryRejected === null &&
              /unrecognized key/i.test(resp.error.message ?? "")
            ) {
              this.sessionIdsQueryRejected = true;
              log(
                "session/list sessionIds unsupported on this backend build — per-id lifecycle probes",
              );
            }
            if (this.sessionIdsQueryRejected === true) {
              // Redo the whole set through the per-id probe — chunking state
              // before the rejection is not worth carrying.
              return await this.probeGoneViaLifecycle(backend, unique);
            }
            return gone; // transient RPC failure — no verdict
          }
          this.sessionIdsQueryRejected = false;
          const present = new Set(
            (
              (resp.result as { sessions?: Array<{ sessionId?: string }> } | undefined)?.sessions ??
              []
            )
              .map((s) => s.sessionId)
              .filter((sid): sid is string => typeof sid === "string"),
          );
          for (const id of chunk) if (!present.has(id)) gone.add(id);
        }
        return gone;
      }
      return await this.probeGoneViaLifecycle(backend, unique);
    } catch {
      return gone; // best-effort: no verdict
    }
  }

  /** Per-id fallback oracle: `session/lifecycle/getState`'s "Session not
   * found" is the same resume-refused verdict as the batch face. Unavailable
   * on pre-0.17.1 builds — no oracle, no retirement. */
  private async probeGoneViaLifecycle(backend: ZcodeBackend, ids: string[]): Promise<Set<string>> {
    const gone = new Set<string>();
    if (this.backendLifecycleApi === false) return gone;
    for (const id of ids) {
      try {
        const resp = await backend.request(
          this.nextId(),
          "session/lifecycle/getState",
          { sessionId: id },
          5000,
        );
        if (resp.error) {
          const message = resp.error.message ?? "";
          if (resp.error.code === -32601 || /method not found/i.test(message)) {
            this.backendLifecycleApi = false;
            log("lifecycle getState unsupported on this backend build — no retirement oracle");
            return gone;
          }
          if (isSessionGoneError(message)) gone.add(id);
          continue; // other errors: no verdict for this id
        }
        this.backendLifecycleApi = true;
      } catch {
        // per-id failure: no verdict for this id
      }
    }
    return gone;
  }

  /**
   * Tombstone revival behind markSessionActive. Guarded, not destructured:
   * several test suites mock tasks-index PARTIALLY (without this export), and
   * a missing index or unknown cwd must never surface on the activity path.
   */
  private async reviveTombstonesFor(acpSid: string): Promise<void> {
    try {
      const tasksIndex = await import("./tasks-index.js");
      if (typeof tasksIndex.reviveTombstonesOnActivity !== "function") return;
      await tasksIndex.reviveTombstonesOnActivity({
        taskId: this.resolveSid(acpSid) ?? acpSid,
        workspacePath: this.sessionCwds.get(acpSid),
        probeGone: (ids) => this.probeGoneBackendSessions(ids),
      });
    } catch {
      // best-effort — a tombstone revival failure must never break a turn
    }
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
  async ensureBackgroundListener(zcodeSid: string): Promise<BackgroundTaskListener> {
    const backend = await this.ensureBackend();
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
    // Workflow-run pollers poll the backend — stop them before the pipe
    // closes (mirrors the listener records below).
    stopAllWorkflowRunPollers();
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
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        // http MCP configs are forwarded verbatim to the backend (session/
        // create + resume), which mounts them fine — the declaration was the
        // only blocker keeping clients from sending http servers (#180).
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: { list: {}, resume: {}, fork: {} },
        // Read-only session file access lives on the bridge's loopback /fs
        // endpoint, hub-proxied at /api/instances/{id}/fs/* (ADR-0004).
        // turnState: the out-of-band running notifications this bridge emits,
        // old and new spellings (#311) — see TURN_STATE_METHODS.
        _meta: { zcode: { fs: true, turnState: [...TURN_STATE_METHODS] } },
      },
      // Credentials come from the ZCode side — the desktop app's config.json
      // / provider_config.json, or `zcode-acp setup`'s saved accounts — and
      // the editor never supplies any. Declared as AuthMethodAgent (no `type`
      // field → defaults to "agent"), which the ACP registry CI accepts as
      // "agent self-handles auth". `authenticate` (the readiness check behind
      // this declaration) lives in handlers/authenticate.ts.
      authMethods: [
        {
          id: "zcode-credentials",
          name: "ZCode built-in credentials",
          description:
            "Reads the GLM API key from the ZCode desktop app's credential files (~/.zcode/v2) or a saved zcode-acp account. No editor-side credentials required.",
        },
      ],
      // Cross-adapter steering extension (#352): `_session/steering` injects
      // into the running turn via the v4 command API. Convention:
      // InitializeResponse._meta.steering.supported (codex-acp /
      // claude-agent-acp); `timings` is this bridge's additive declaration —
      // `now` (guide into the live turn) and `next` (queue for the next
      // boundary), carried by the request's _meta.steering.priority.
      _meta: { steering: { supported: true, timings: ["now", "next"] } },
    };
  }
}
