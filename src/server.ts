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
}

export class ZcodeAcpServer {
  /** The ZCode subprocess client (lazy — spawned on first use). */
  backend: ZcodeBackend | null = null;
  /** acp_sid → zcode session id (usually identical, but kept for clarity). */
  readonly sessionMap = new Map<string, string>();
  /** Currently running turns, keyed by the ACP request id. */
  readonly pendingTurns = new Map<number, PendingTurn>();
  /**
   * Per-session (zcodeSid) preempt lock: a promise chain that serializes the
   * "register self + preempt others" critical section in prompt(). Prevents
   * concurrent prompts from both missing each other and registering at once.
   */
  readonly preemptLocks = new Map<string, Promise<void>>();
  /** Capabilities advertised by the connected client (Zed, JetBrains, ...). */
  clientCapabilities: ClientCapabilities = {};
  /** Session titles already set, to enforce set-once (acp_sid → title). */
  readonly sessionTitles = new Map<string, string>();
  /**
   * Sessions eligible for auto-title on first end_turn. Only `session/new`
   * populates this — resumed/loaded sessions already carry a title, so their
   * first post-load message must NOT overwrite it. (sessionTitles alone can't
   * distinguish "freshly created" from "resumed but not yet titled in-process".)
   */
  readonly titleEligibleSessions = new Set<string>();
  /** Last mode id advertised to the client (acp_sid → modeId), for change detection. */
  readonly lastMode = new Map<string, string>();
  /** Per-session ProjectionDiffers (persists across turns). */
  readonly differs = new Map<
    string,
    import("./translators/projection-differ.js").ProjectionDiffer
  >();
  /** Per-session model cache for configOptions model dropdown. */
  readonly modelCache = new Map<string, string>();
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

  /** Handle `initialize`: negotiate version + declare agent capabilities. */
  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    const clientInfo = (params.clientInfo as { name?: string; version?: string } | null) ?? null;
    this.clientCapabilities = (params.clientCapabilities as ClientCapabilities) ?? {};
    log(
      `initialize: client protocolVersion=${params.protocolVersion}` +
        `, client=${clientInfo?.name ?? "unknown"}` +
        `, version=${clientInfo?.version ?? "unknown"}`,
    );

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { ...AGENT_INFO },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, resume: {}, fork: {} },
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
