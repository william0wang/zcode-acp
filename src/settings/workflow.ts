/**
 * Dynamic-workflow management plane — the backend-facing half (plan §7).
 *
 * The desktop manages saved workflows over its private v4 channel + GUI; ACP
 * has no resource-management family at all, so the Settings API is the ONLY
 * surface a remote App has. This module owns the wire translation:
 *
 * - `workflows/*` (session-less file ops) carry the bridge's primary project
 *   cwd as the workspace ref — the same derivation the hub discovery payload
 *   uses (collectSessions → server.projectCwd()).
 * - `v4/conversation/workflowRun*` queries are session-scoped: callers hand
 *   over an ACP session id, this module resolves the backend zcodeSid.
 * - start/resume go through `v4/command` with `request()` so the response IS
 *   the terminal CommandAck — the gateway awaits the side effect (script
 *   compile included), which is why those timeouts are the longest here.
 *
 * Every RPC goes through `backend.request`, which NEVER throws — it resolves
 * `{error}`. Errors surface as {@link WorkflowApiError} carrying the HTTP
 * status in `code` and a short machine-readable `reason` token, so the route
 * layer never has to re-classify.
 */

import { randomUUID } from "node:crypto";

import { rememberGate, type WorkflowGate } from "../config/workflow-gate.js";
import { ensureRealSession } from "../handlers/session.js";
import { lookupLazySession, rememberLazySession } from "../lazy-sessions.js";
import type { ZcodeAcpServer } from "../server.js";
import { log, warn } from "../utils.js";

/** Workflow scope vocabulary (upstream workflows/* `scope`). */
export type WorkflowScope = "project" | "global";

/**
 * A workflow failure the route layer can map directly: `code` is the HTTP
 * status, `reason` a short token for clients ("session_busy",
 * "workflow_disabled", …), and `message` the human-readable detail (for
 * `compile_failed` it carries the backend's bounded diagnostics).
 */
export class WorkflowApiError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string, message?: string) {
    super(message ?? reason);
    this.code = code;
    this.reason = reason;
  }
}

// Timeouts: file ops and run listings are quick local scans; v4 queries are
// in-memory/journal reads; the command timeout is the longest because the
// gateway only answers AFTER the side effect settles (startSavedWorkflow
// compiles the script before accepting).
const TIMEOUT_FILE_MS = 10_000;
const TIMEOUT_V4_MS = 8_000;
const TIMEOUT_COMMAND_MS = 20_000;

/** One v4 command ack (upstream CommandAck — status/reasonCode/result). */
interface CommandAck {
  status?: unknown;
  reasonCode?: unknown;
  message?: unknown;
  result?: Record<string, unknown>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Await the per-backend gate verdict and refuse when the feature is off.
 * The upstream v4 start/resume commands are NOT gated by the backend policy
 * (port presence is their only gate), so the bridge guards itself — a
 * headless backend would otherwise happily run workflows the remote config
 * disabled. A null gate means NO backend was ever spawned (an App-only flow
 * that never chatted): spawn one — ensureBackend starts the gate fetch — and
 * await the fresh verdict, so a cold bridge reports the real answer instead
 * of a false 403. An actual fetch failure still settles disabled
 * (fail-closed, like the gate itself).
 */
export async function requireWorkflowEnabled(server: ZcodeAcpServer): Promise<WorkflowGate> {
  if (!server.backendWorkflowGate) {
    await server.ensureBackend().catch((): undefined => undefined);
  }
  const promise = server.backendWorkflowGate;
  const gate = promise ? await promise : null;
  if (promise && gate) rememberGate(promise, gate);
  if (!gate?.enabled) throw new WorkflowApiError(403, "workflow_disabled");
  return gate;
}

/** Workspace ref for session-less `workflows/*` calls (collectSessions shape). */
function workspaceRef(server: ZcodeAcpServer): { workspacePath: string; workspaceKey: string } {
  const cwd = server.projectCwd();
  return { workspacePath: cwd, workspaceKey: cwd };
}

/** Send one backend RPC, mapping an error response to a thrown 502. */
async function rpc(
  server: ZcodeAcpServer,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const backend = await server.ensureBackend();
  const resp = await backend.request(server.nextId(), method, params, timeoutMs);
  if (resp.error) {
    throw new WorkflowApiError(
      502,
      "backend_error",
      `backend ${method} failed: ${resp.error.message ?? "unknown error"}`,
    );
  }
  return (resp.result ?? {}) as Record<string, unknown>;
}

/**
 * Fold a `workflows/*` business failure (`{ok:false, reason, detail?}` in the
 * RESULT — these ops do not use RPC errors) into a thrown error with the
 * matching HTTP code.
 */
function throwIfOpFailed(result: Record<string, unknown>, method: string): void {
  if (result["ok"] !== false) return;
  const reason = typeof result["reason"] === "string" ? result["reason"] : "failed";
  const detail = typeof result["detail"] === "string" ? result["detail"] : undefined;
  const code =
    reason === "invalid_name"
      ? 400
      : reason === "not_found"
        ? 404
        : reason === "target_exists"
          ? 409
          : 502;
  throw new WorkflowApiError(code, reason, detail ?? `${method}: ${reason}`);
}

/** Clamp a limit into [1, max], falling back when absent/invalid. */
function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.min(max, Math.max(1, n));
}

// ---------- session-less workflows/* file operations ----------

/** `workflows/list` — entries + `invalid[]` + `dir` (present even when missing). */
export async function listWorkflows(
  server: ZcodeAcpServer,
  scope?: WorkflowScope,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  return rpc(
    server,
    "workflows/list",
    { workspace: workspaceRef(server), ...(scope ? { scope } : {}) },
    TIMEOUT_FILE_MS,
  );
}

/** `workflows/get` — script + meta for one saved workflow (directed scope). */
export async function getWorkflow(
  server: ZcodeAcpServer,
  scope: WorkflowScope,
  name: string,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  const result = await rpc(
    server,
    "workflows/get",
    { workspace: workspaceRef(server), name, scope },
    TIMEOUT_FILE_MS,
  );
  throwIfOpFailed(result, "workflows/get");
  return result;
}

/** `workflows/updateMeta` — read-modify-write of the frontmatter only. */
export async function updateWorkflowMeta(
  server: ZcodeAcpServer,
  scope: WorkflowScope,
  name: string,
  meta: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  const result = await rpc(
    server,
    "workflows/updateMeta",
    { workspace: workspaceRef(server), name, meta, scope },
    TIMEOUT_FILE_MS,
  );
  throwIfOpFailed(result, "workflows/updateMeta");
  return result;
}

/** `workflows/delete` — unlink by scope root (name validated before path join). */
export async function deleteWorkflow(
  server: ZcodeAcpServer,
  scope: WorkflowScope,
  name: string,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  const result = await rpc(
    server,
    "workflows/delete",
    { workspace: workspaceRef(server), name, scope },
    TIMEOUT_FILE_MS,
  );
  throwIfOpFailed(result, "workflows/delete");
  return result;
}

/**
 * `workflows/move` — global→project ONLY (upstream design: promoting the
 * other way goes through SaveWorkflow in a project session). The scope path
 * segment exists for URL symmetry; the wire params carry no scope key
 * (upstream schema is `{workspace, name}`).
 */
export async function moveWorkflow(
  server: ZcodeAcpServer,
  scope: WorkflowScope,
  name: string,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  void scope;
  const result = await rpc(
    server,
    "workflows/move",
    { workspace: workspaceRef(server), name },
    TIMEOUT_FILE_MS,
  );
  throwIfOpFailed(result, "workflows/move");
  return result;
}

/**
 * `workflows/runs` — journal-backed run history (survives restarts), scoped
 * by name when given. Limit clamps to the upstream 1..50 window.
 */
export async function listRuns(
  server: ZcodeAcpServer,
  opts: { scope?: WorkflowScope; name?: string; limit?: number } = {},
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  return rpc(
    server,
    "workflows/runs",
    {
      workspace: workspaceRef(server),
      limit: clampLimit(opts.limit, 20, 50),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.scope ? { scope: opts.scope } : {}),
    },
    TIMEOUT_FILE_MS,
  );
}

// ---------- v4 conversation run queries ----------

/**
 * Resolve an ACP session id to the backend zcodeSid for READ-ONLY run
 * queries — without materializing anything. In-memory mappings first, then
 * the durable alias store's recorded zcodeSid; a lazy placeholder that was
 * never used has no backend session and no run history, so 404 is the honest
 * answer (and cheaper than a create).
 */
export function resolveWorkflowZcodeSid(server: ZcodeAcpServer, acpSid: string): string {
  const mapped = server.resolveSid(acpSid) ?? lookupLazySession(acpSid)?.zcodeSid;
  if (!mapped) {
    throw new WorkflowApiError(
      404,
      "unknown_session",
      `session ${acpSid} is not known to this bridge — cannot query its workflow runs`,
    );
  }
  return mapped;
}

/** `v4/conversation/workflowRuns` — restart-discovery list incl. `resumable`. */
export async function conversationRuns(
  server: ZcodeAcpServer,
  zcodeSid: string,
  limit?: number,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  return rpc(
    server,
    "v4/conversation/workflowRuns",
    { sessionId: zcodeSid, limit: clampLimit(limit, 64, 64) },
    TIMEOUT_V4_MS,
  );
}

/** `v4/conversation/workflowRunEvents` — journal events, cursor never expires. */
export async function runEvents(
  server: ZcodeAcpServer,
  zcodeSid: string,
  runId: string,
  afterSequence?: number,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  return rpc(
    server,
    "v4/conversation/workflowRunEvents",
    { sessionId: zcodeSid, runId, ...(afterSequence !== undefined ? { afterSequence } : {}) },
    TIMEOUT_V4_MS,
  );
}

/** `v4/conversation/workflowRunArtifacts` — artifact inventory with versions. */
export async function runArtifacts(
  server: ZcodeAcpServer,
  zcodeSid: string,
  runId: string,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  return rpc(
    server,
    "v4/conversation/workflowRunArtifacts",
    { sessionId: zcodeSid, runId },
    TIMEOUT_V4_MS,
  );
}

/** `v4/conversation/workflowRunArtifactData` — board item pagination. */
export async function runArtifactData(
  server: ZcodeAcpServer,
  zcodeSid: string,
  runId: string,
  artifactId: string,
  afterSequence?: number,
  limit?: number,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  return rpc(
    server,
    "v4/conversation/workflowRunArtifactData",
    {
      sessionId: zcodeSid,
      runId,
      artifactId,
      ...(afterSequence !== undefined ? { afterSequence } : {}),
      ...(limit !== undefined ? { limit: clampLimit(limit, 200, 500) } : {}),
    },
    TIMEOUT_V4_MS,
  );
}

/** `v4/conversation/workflowRunArtifactRead` — raw bytes in ≤512KiB chunks. */
export async function runArtifactRead(
  server: ZcodeAcpServer,
  zcodeSid: string,
  runId: string,
  artifactId: string,
  version: number,
  offset: number,
  limit?: number,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  return rpc(
    server,
    "v4/conversation/workflowRunArtifactRead",
    {
      sessionId: zcodeSid,
      runId,
      artifactId,
      version,
      offset,
      // Upstream caps the chunk param at 512KiB of bytes — clamp, don't 400:
      // a client asking for more still gets the maximum legal chunk.
      ...(limit !== undefined ? { limit: Math.min(limit, 512 * 1024) } : {}),
    },
    TIMEOUT_V4_MS,
  );
}

/** `v4/conversation/workflowRunWorkspace` — world-read/world-run rows. */
export async function runWorkspace(
  server: ZcodeAcpServer,
  zcodeSid: string,
  runId: string,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  return rpc(
    server,
    "v4/conversation/workflowRunWorkspace",
    { sessionId: zcodeSid, runId },
    TIMEOUT_V4_MS,
  );
}

/** `v4/conversation/workflowRunNodeResult` — one node's bounded result. */
export async function runNodeResult(
  server: ZcodeAcpServer,
  zcodeSid: string,
  runId: string,
  siteId: string,
  ordinal: number,
): Promise<Record<string, unknown>> {
  await requireWorkflowEnabled(server);
  return rpc(
    server,
    "v4/conversation/workflowRunNodeResult",
    { sessionId: zcodeSid, runId, siteId, ordinal },
    TIMEOUT_V4_MS,
  );
}

// ---------- start / resume (v4/command launch protocol) ----------

/**
 * Map a CommandAck rejection's reasonCode (a fault-namespace string like
 * `fault.command.savedWorkflowStartRejected.session_busy`) to an HTTP status.
 * Matched by substring — the prefix varies per command, the suffix token is
 * the stable part. Unmapped reasons are a backend-side fault: 502.
 */
function codeForCommandReason(reasonCode: string): number {
  if (reasonCode.includes("session_busy") || reasonCode.includes("not_resumable")) return 409;
  if (reasonCode.includes("not_found")) return 404;
  if (reasonCode.includes("invalid_name") || reasonCode.includes("invalid_args")) return 400;
  if (reasonCode.includes("compile_failed")) return 422;
  if (reasonCode.includes("capabilityUnsupported")) return 501;
  return 502;
}

/** The short token for an ack rejection: the fault namespace's last segment. */
function reasonToken(reasonCode: string, status: unknown): string {
  if (reasonCode) {
    const tail = reasonCode.split(".").pop()!;
    if (tail) return tail;
  }
  return typeof status === "string" && status ? status : "command_failed";
}

/**
 * Send one v4 command envelope and await the terminal ack. `request()` (not
 * `send()`) is deliberate: the gateway resolves the RPC only after the side
 * effect settles, so a compile failure is reported HERE instead of surfacing
 * as a run that never starts. Neither startSavedWorkflow nor resumeWorkflowRun
 * requires a baseRevision (workflowRuns is revision-exempt upstream).
 */
async function sendCommand(
  server: ZcodeAcpServer,
  type: "startSavedWorkflow" | "resumeWorkflowRun",
  zcodeSid: string,
  payload: Record<string, unknown>,
): Promise<CommandAck> {
  const backend = await server.ensureBackend();
  const envelope = {
    commandId: randomUUID(),
    clientId: "zcode-acp-server",
    sessionId: zcodeSid,
    type,
    payload,
    issuedAt: Date.now(),
  };
  const resp = await backend.request(server.nextId(), "v4/command", envelope, TIMEOUT_COMMAND_MS);
  if (resp.error) {
    throw new WorkflowApiError(
      502,
      "command_failed",
      `v4/command ${type} failed: ${resp.error.message ?? "unknown error"}`,
    );
  }
  return (resp.result ?? {}) as CommandAck;
}

/** Throw the ack-shaped rejection (status ≠ accepted). */
function throwAckRejection(ack: CommandAck, type: string): never {
  const reasonCode = typeof ack.reasonCode === "string" ? ack.reasonCode : "";
  const fallback =
    `v4/command ${type} ${typeof ack.status === "string" ? ack.status : "failed"}` +
    (reasonCode ? ` (${reasonCode})` : "");
  throw new WorkflowApiError(
    codeForCommandReason(reasonCode),
    reasonToken(reasonCode, ack.status),
    typeof ack.message === "string" && ack.message ? ack.message : fallback,
  );
}

/**
 * Map an APP-provided session id to the backend zcodeSid. Uses the full
 * resolution path (in-memory mapping, durable-store recovery, lazy
 * materialization) — the same facility every session-scoped extension method
 * goes through (`resolveSidOrThrow` → `ensureRealSession`). The backend
 * enforces idleness at start time (`session_busy`); the bridge does not
 * pre-check.
 */
async function mapProvidedSession(server: ZcodeAcpServer, acpSid: string): Promise<string> {
  try {
    return await ensureRealSession(server, acpSid);
  } catch (e) {
    throw new WorkflowApiError(
      404,
      "unknown_session",
      `session ${acpSid} could not be resolved: ${messageOf(e)}`,
    );
  }
}

/**
 * Drop every bridge-side registration for an alias THIS launch minted (the
 * /resume adoption's discard pattern: pending entry, cwd, both mapping
 * directions, liveness cache, remote advertisement), then close the backend
 * session best-effort. Only ever called for bridge-CREATED sessions — an
 * APP-provided session is the caller's asset and is never closed here. The
 * durable store record survives on purpose: `session/close` only evicts the
 * resident runtime (the stored session stays resumable), the same residue a
 * manual session close leaves.
 */
async function discardCreatedSession(
  server: ZcodeAcpServer,
  acpSid: string,
  zcodeSid: string | undefined,
): Promise<void> {
  server.pendingSessions.delete(acpSid);
  server.remoteCreatedSessions.delete(acpSid);
  server.sessionCwds.delete(acpSid);
  server.sessionMap.delete(acpSid);
  if (zcodeSid) server.acpSidByZcodeSid.delete(zcodeSid);
  server.backendLoadedSessions.delete(acpSid);
  if (!zcodeSid) return;
  try {
    const backend = await server.ensureBackend();
    const resp = await backend.request(
      server.nextId(),
      "session/close",
      { sessionId: zcodeSid },
      10_000,
    );
    if (resp.error) {
      log(`workflow-start: session/close cleanup failed: ${resp.error.message ?? "unknown error"}`);
    }
  } catch (e) {
    warn(`workflow-start: session/close cleanup threw (${messageOf(e)})`);
  }
}

export interface StartSavedWorkflowInput {
  scope?: WorkflowScope;
  name: string;
  args?: Record<string, unknown>;
  /** Existing session to launch in (must be idle). Absent → new session. */
  acpSessionId?: string;
}

export interface StartSavedWorkflowResult {
  acpSessionId: string;
  runId?: string;
  toolCallId?: string;
}

/**
 * Launch a saved workflow in a session the App can see and attach to.
 *
 * 1. Resolve the launch session: the caller's `acpSessionId`, or a NEWLY
 *    minted placeholder materialized through the bridge's own session
 *    registration path (`ensureRealSession`) — so the create carries the
 *    workflow flag, the alias mapping + durable record exist, and the App's
 *    session list / a later load-resume work like any editor-created session.
 * 2. `v4/command startSavedWorkflow` on that session; await the ack.
 * 3. `accepted` → `{acpSessionId, runId, toolCallId}` straight from the ack's
 *    result (the App's progress card joins on toolCallId).
 * 4. anything else — a non-accepted ack or a THROWN send (timeout, -32601,
 *    transport) — → close/discard a session WE created (never an
 *    APP-provided one) and rethrow with the reasonCode-mapped status.
 *
 * Consent semantics (upstream: "the hub click IS the consent"): calling this
 * API deliberately skips the backend's permission popup, matching the
 * desktop's launch button.
 */
export async function startSavedWorkflow(
  server: ZcodeAcpServer,
  input: StartSavedWorkflowInput,
): Promise<StartSavedWorkflowResult> {
  await requireWorkflowEnabled(server);

  let zcodeSid: string;
  let createdAcpSid: string | null = null;
  if (input.acpSessionId) {
    zcodeSid = await mapProvidedSession(server, input.acpSessionId);
  } else {
    createdAcpSid = randomUUID();
    const cwd = server.projectCwd();
    server.pendingSessions.set(createdAcpSid, { cwd });
    server.sessionCwds.set(createdAcpSid, cwd);
    rememberLazySession(createdAcpSid, cwd);
    // Remote-created: the App has no editor-side session storage, so the
    // active-session list must advertise this id for as long as the bridge
    // lives (collectSessions reads exactly this set).
    server.remoteCreatedSessions.add(createdAcpSid);
    try {
      zcodeSid = await ensureRealSession(server, createdAcpSid);
    } catch (e) {
      await discardCreatedSession(server, createdAcpSid, undefined);
      throw new WorkflowApiError(502, "session_create_failed", messageOf(e));
    }
  }

  let ack: CommandAck;
  try {
    ack = await sendCommand(server, "startSavedWorkflow", zcodeSid, {
      name: input.name,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.args ? { args: input.args } : {}),
    });
  } catch (e) {
    // The command died in transport (timeout / -32601 / dead pipe / a failed
    // ensureBackend): the ack-path cleanup below never runs, so run it here —
    // a session WE created must not linger as a phantom alias while the
    // backend may still be executing the command. Only bridge-created
    // sessions are discarded (an APP-provided one is the caller's asset).
    if (createdAcpSid) await discardCreatedSession(server, createdAcpSid, zcodeSid);
    if (e instanceof WorkflowApiError) throw e;
    throw new WorkflowApiError(502, "command_failed", messageOf(e));
  }
  if (ack.status !== "accepted") {
    if (createdAcpSid) await discardCreatedSession(server, createdAcpSid, zcodeSid);
    throwAckRejection(ack, "startSavedWorkflow");
  }
  const result = (ack.result ?? {}) as { runId?: unknown; toolCallId?: unknown };
  return {
    acpSessionId: input.acpSessionId ?? createdAcpSid!,
    ...(typeof result.runId === "string" ? { runId: result.runId } : {}),
    ...(typeof result.toolCallId === "string" ? { toolCallId: result.toolCallId } : {}),
  };
}

/**
 * Resume a stopped run (resumable set: cancelled ∪ failed-Interrupted — the
 * `resumable` flag on the run list is the caller's judgment source). Runs in
 * the caller-named session; success is a bare `accepted` ack (no result).
 */
export async function resumeWorkflowRun(
  server: ZcodeAcpServer,
  input: { runId: string; acpSessionId: string; name?: string },
): Promise<void> {
  await requireWorkflowEnabled(server);
  const zcodeSid = await mapProvidedSession(server, input.acpSessionId);
  const ack = await sendCommand(server, "resumeWorkflowRun", zcodeSid, {
    workId: input.runId,
    ...(input.name ? { name: input.name } : {}),
  });
  if (ack.status !== "accepted") throwAckRejection(ack, "resumeWorkflowRun");
}

// ---------- create prompt (frozen desktop copy) ----------

/**
 * Frozen copy of the desktop's prefilled "create workflow" prompt — verbatim
 * from packages/ui/src/settings/saved-workflows/savedWorkflowLaunchPrompt.ts
 * (`buildSavedWorkflowCreatePrompt`, lines 27-40 @ ZCode 3.14.3). Intentionally
 * a copy, not a dependency: the desktop repo is not importable here, and the
 * text is a UX contract ("prefill the draft, never auto-send") that should not
 * drift silently with a desktop update. Do not edit the wording by hand.
 */
const WORKFLOW_CREATE_PROMPT_PROJECT =
  "Help me design a workflow and save it to this project once it works: ";
const WORKFLOW_CREATE_PROMPT_GLOBAL =
  'Help me design a workflow and save it as a global workflow (scope: "global") with SaveWorkflow once it works: ';

/** The prefilled prompt for the "create via conversation" entry point. */
export function workflowCreatePrompt(scope?: WorkflowScope): string {
  return scope === "global" ? WORKFLOW_CREATE_PROMPT_GLOBAL : WORKFLOW_CREATE_PROMPT_PROJECT;
}
