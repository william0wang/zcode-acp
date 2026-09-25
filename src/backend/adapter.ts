/**
 * BackendAdapter — the seam between the bridge and its agent-harness backend
 * (ADR-0023, revised 2026-09-25).
 *
 * One bridge process owns exactly one backend subprocess, and the capability
 * table below is the SINGLE enforcement point for value-add surfaces: handlers
 * consult `backendCapabilities(kind)` instead of branching on the backend.
 * The backend-kind selection flag lands with the dsh adapter (PR2); until
 * then every bridge is zcode and the table is all-true, so gating through it
 * is behavior-neutral by construction.
 */

import type {
  ZcodeInteractionPermissionParams,
  ZcodeInteractionUserInputParams,
  ZcodeResponse,
} from "./types.js";

/** A supported backend harness. `dsh` = DeepSeek Harness (`dsh --profile acp`). */
export type BackendKind = "zcode" | "dsh";

/** Parse a user-supplied backend name; undefined when unrecognized. */
export function parseBackendKind(raw: string): BackendKind | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "zcode" || v === "dsh") return v;
  return undefined;
}

/**
 * Feature flags the bridge consults before registering value-add surfaces
 * (slash commands, settings routes, auto-behaviors). Keyed off the backend
 * KIND — not a live adapter — because registration happens at startup /
 * initialize, before the lazy backend ever spawns. A false entry means the
 * surface stays dark (no menu entry, no route) and an out-of-band invocation
 * answers with a friendly downgrade message, never a raw backend error.
 */
export interface BackendCapabilities {
  /** session/fork + /fork. */
  fork: boolean;
  /** session/compact + /compact. */
  compact: boolean;
  /** Threshold-based auto-compaction after end_turn. */
  autoCompact: boolean;
  /** Permission-mode config option + session/setMode + /mode. */
  modes: boolean;
  /** EnterPlanMode/ExitPlanMode plan flow (backend-tool driven). */
  plans: boolean;
  /** Form-based elicitation (AskUserQuestion / plan-review forms). */
  elicitation: boolean;
  /** Seatbelt sandbox wrapping (backend spawn argv). */
  sandbox: boolean;
  /** /mcp listing (reads the ZCode desktop config + plugins — zcode-only source). */
  mcpListing: boolean;
  /** Incremental streaming deltas. */
  streaming: boolean;
  /**
   * Image attachments on prompts. False when the adapter drops them —
   * advertising the capability anyway would silently eat user input.
   */
  image: boolean;
  /**
   * Stop needs a post-cancel drain (probe-until-idle + session/close
   * escalation). True for zcode, whose session/stop was historically ignored;
   * false for a backend whose cancel is a real cancel — draining it would
   * only escalate against a live session.
   */
  drain: boolean;
  /**
   * session/resume on an already-active session succeeds as a no-op. False
   * means adoption paths must skip the resume RPC when the target session is
   * already live in this backend process (the backend rejects duplicates).
   */
  resumeIdempotent: boolean;
  /** Settings API management surface (ADR-0025 route families). */
  settings: boolean;
  /** /workflow + /workflows slash commands (dynamic workflow, ADR-0029). */
  workflowCommands: boolean;
  /** Settings API dynamic-workflow route family + run poller (ADR-0029). */
  workflowRoutes: boolean;
  /** POST /settings/backend/restart (backend respawn orchestration). */
  backendRestart: boolean;
  /** Martty boot-resume banner handshake (DSH_TUI_AUTOPROMPT arming). */
  bootResumeHandshake: boolean;
  /**
   * GLM Coding Plan quota surfaces (dock refresher + pseudo-option). The
   * /quota command and account/usage_stats get their own per-backend wiring
   * with the dsh port (dsh pins quota to Opencode Go per ADR-0023).
   */
  quota: boolean;
}

/** zcode: every value-add surface available. */
const ZCODE_CAPABILITIES: BackendCapabilities = Object.freeze({
  fork: true,
  compact: true,
  autoCompact: true,
  modes: true,
  plans: true,
  elicitation: true,
  sandbox: true,
  mcpListing: true,
  streaming: true,
  image: true,
  drain: true,
  resumeIdempotent: true,
  settings: true,
  workflowCommands: true,
  workflowRoutes: true,
  backendRestart: true,
  bootResumeHandshake: true,
  quota: true,
});

/**
 * dsh starting point for the port (PR2): verified against
 * @deepseek-ai/dsh 0.1.7-rc.2 (`.zcode/scratch/research-dsh-017-facts.md`) —
 * no fork on the ACP wire, no compact/modes/plans/elicitation, committed-
 * chunk updates only, no image attachments, session/cancel is a real cancel,
 * session/resume rejects an already-active session.
 */
const DSH_CAPABILITIES: BackendCapabilities = Object.freeze({
  fork: false,
  compact: false,
  autoCompact: false,
  modes: false,
  plans: false,
  elicitation: false,
  sandbox: false,
  mcpListing: false,
  streaming: false,
  image: false,
  drain: false,
  resumeIdempotent: false,
  settings: false,
  workflowCommands: false,
  workflowRoutes: false,
  backendRestart: false,
  bootResumeHandshake: false,
  quota: false,
});

/** Capability table for a backend kind (pure — no adapter instance needed). */
export function backendCapabilities(kind: BackendKind): BackendCapabilities {
  return kind === "dsh" ? DSH_CAPABILITIES : ZCODE_CAPABILITIES;
}

/** A server→client request that we must reply to. */
export interface ServerRequest {
  id: number | string;
  method: string;
  params:
    ZcodeInteractionPermissionParams | ZcodeInteractionUserInputParams | Record<string, unknown>;
}

/** Listener for backend event pushes on a given session. */
export interface EventListener {
  handleEvent(event: import("./types.js").ZcodeEvent): void;
}

/**
 * The backend seam. Concrete implementations spawn their harness over stdio
 * and demultiplex its JSON-RPC stream; the bridge core only ever sees this.
 * Backend creation follows the async spawn contract of ADR-0023 (revised):
 * the SERVER packs creation policy (workflow-gate verdict, env layers,
 * arrival responders, per-generation registry resets) and the ADAPTER owns
 * process/wire mechanics.
 */
export interface BackendAdapter {
  /** Feature flags for this backend's kind (see {@link backendCapabilities}). */
  readonly capabilities: BackendCapabilities;

  /** True once the backend's read loop is gone — further requests fail fast. */
  get isDead(): boolean;

  /**
   * Synchronous request/response. Returns `{error}` on dead backend, broken
   * pipe, or timeout — never throws.
   */
  request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ZcodeResponse>;

  /** Send a message with an id but WITHOUT registering a pending response. */
  send(method: string, params?: Record<string, unknown>): void;

  /** Fire-and-forget notification (no id, no response). */
  notify(method: string, params?: Record<string, unknown>): void;

  /** Reply to a backend server→client request with a result. */
  sendReply(id: number | string, result: unknown): void;

  /** Reply to a backend server→client request with an error. */
  sendError(id: number | string, code: number, message: string): void;

  /** Non-blocking drain of pending server→client requests. */
  pollServerRequests(): ServerRequest[];

  /**
   * Re-queue server→client requests that belong to a different session
   * (prepended to preserve arrival order).
   */
  requeueServerRequests(reqs: ServerRequest[]): void;

  registerEventListener(sessionId: string, listener: EventListener): void;
  unregisterEventListener(sessionId: string, listener: EventListener): void;

  /** Kill the whole backend process group and wait for it to die. */
  close(): Promise<void>;
}
