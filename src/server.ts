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
  loadZcodeCredentials,
  mergeEnvWithCreds,
  resolveZcodeCommand,
  ZcodeBackend,
} from "./backend/index.js";
import { BackgroundTaskListener } from "./handlers/background-tasks.js";
import { enqueueSessionSend } from "./handlers/io.js";
import { ClientRegistry } from "./remote/broadcast.js";
import { AGENT_INFO, PROTOCOL_VERSION, log } from "./utils.js";

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
   * Set when the turn was ended by the stall-recovery heuristic (backend
   * reported idle after a silence) rather than a real turn.completed event.
   * prompt() skips auto-compact for such turns — the completion was inferred,
   * and compressing an in-flight task's context would destroy the work.
   */
  stallRecovered?: boolean;
}

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
  /** Currently running turns, keyed by the ACP request id. */
  readonly pendingTurns = new Map<number, PendingTurn>();
  /**
   * Per-session (zcodeSid) preempt lock: a promise chain that serializes the
   * "register self + preempt others" critical section in prompt(). Prevents
   * concurrent prompts from both missing each other and registering at once.
   */
  readonly preemptLocks = new Map<string, Promise<void>>();
  /** Capabilities advertised by connected clients (Zed, JetBrains, remote). */
  clientCapabilities: ClientCapabilities = {};
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
   * Sessions verified as loaded in the CURRENT backend subprocess — populated
   * only after a successful session/create or session/resume RPC. A bare
   * `registerSession` mapping does NOT qualify: the backend answers
   * `session/messages` only for sessions it has loaded, so `session/load`
   * must not skip the resume RPC for a mapping that was never loaded (e.g.
   * re-registered from the durable store by an early ensureRealSession
   * caller, or left behind by a failed resume) — the replay would silently
   * come back empty.
   */
  readonly backendLoadedSessions = new Set<string>();
  /**
   * Sessions eligible for auto-title on first end_turn. Only `session/new`
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
   * Per-session (zcodeSid) background-task listeners. Registered once when a
   * session is created/resumed/loaded and lives across prompts, forwarding
   * background task status + result notifications to the client outside of
   * request handlers. The turn loop's own listener coexists with this one
   * (backend.listeners is now a Set per session).
   */
  readonly backgroundListeners = new Map<string, BackgroundTaskListener>();
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

  /** Next JSON-RPC id for messages we send to zcode. */
  nextId(): number {
    return ++this.msgCounter;
  }

  /** Lazily spawn the zcode backend on first use (initialize doesn't need it). */
  ensureBackend(): ZcodeBackend {
    if (this.backend && !this.backend.isDead) return this.backend;
    const env = mergeEnvWithCreds(loadZcodeCredentials());
    const argv = resolveZcodeCommand();
    this.backend = new ZcodeBackend(argv, env);
    return this.backend;
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
   * The bridge's project directory: first known session cwd, else the bridge
   * process cwd (Zed spawns the server with the worktree root as cwd).
   */
  projectCwd(): string {
    return this.sessionCwds.values().next().value ?? process.cwd();
  }

  /** Best-effort workspace label for the hub discovery payload. */
  workspaceLabel(): string {
    return this.projectCwd();
  }

  /**
   * Ensure a background-task listener is registered for the session. Idempotent
   * — returns the existing listener if already registered (covers resume/load
   * after new, and fork). Lives for the whole session so background agents that
   * finish AFTER `session/prompt` returns still get their status/result
   * forwarded to the client. The turn loop's own listener coexists via the
   * backend's per-session listener Set.
   */
  ensureBackgroundListener(zcodeSid: string): BackgroundTaskListener {
    const existing = this.backgroundListeners.get(zcodeSid);
    if (existing) return existing;
    const backend = this.ensureBackend();
    const listener = new BackgroundTaskListener(this, zcodeSid);
    this.backgroundListeners.set(zcodeSid, listener);
    backend.registerEventListener(zcodeSid, listener);
    log(`  [bg] background listener registered for ${zcodeSid}`);
    return listener;
  }

  /** Resolve the ACP session id for a zcode session id (reverse of resolveSid). */
  resolveAcpSid(zcodeSid: string): string | undefined {
    return this.acpSidByZcodeSid.get(zcodeSid);
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
      // behind an in-flight replay batch for the same session.
      await enqueueSessionSend(acpSid, () =>
        this.clients.broadcast().notify("session/update", { sessionId: acpSid, update }),
      );
      return true;
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

  /** Handle `initialize`: negotiate version + declare agent capabilities. */
  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    const clientInfo = (params.clientInfo as { name?: string; version?: string } | null) ?? null;
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
        mcpCapabilities: { http: false, sse: false },
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
