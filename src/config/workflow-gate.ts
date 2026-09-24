/**
 * Dynamic-workflow availability gate (desktop-host parity).
 *
 * The desktop's Host utility process decides whether the dynamic-workflow
 * feature (workflow tools, `/workflow` expansion) is available from an
 * ANONYMOUS remote config endpoint — no local toggle, no env override in
 * production (packaged desktop builds strip `ZCODE_DYNAMIC_WORKFLOW_MODE`
 * on purpose). A headless app-server never resolves the gate itself
 * (fail-closed false), so the bridge plays the Host:
 *
 *   GET {origin}/api/v1/client/configs?app_version=&platform=
 *   → data.configs.dynamicWorkflow.mode ∈ disabled|onDemand|alwaysOn
 *   → enabled = mode !== "disabled"
 *
 * Fail-closed everywhere: a missing key, an unknown value, an HTTP error, a
 * fetch throw, or the 6s timeout all read as disabled — a gray-flag read must
 * never block ordinary chat (upstream returns the default verdict on failure
 * for the same reason). The verdict is resolved ONCE per backend spawn
 * (server.backendWorkflowGate, src/server.ts ensureBackend) and pinned to
 * that backend's lifetime; a server-side mode flip becomes visible at the
 * next respawn.
 */

import { arch, platform } from "node:os";

import { AGENT_INFO, log } from "../utils.js";

/** Remote verdict vocabulary (upstream DYNAMIC_WORKFLOW_MODES). */
const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;

export interface WorkflowGate {
  mode: "disabled" | "onDemand" | "alwaysOn" | "unknown";
  /** mode !== "disabled" — the consumption-side fold (onDemand ≡ alwaysOn today). */
  enabled: boolean;
  /** Observability only: "remote" verdict vs the fail-closed "default". */
  source: "remote" | "default";
}

/** The fail-closed verdict every failure path collapses to. */
const GATE_DISABLED: WorkflowGate = { mode: "unknown", enabled: false, source: "default" };

/** API origin; overridable for testing and for a self-hosted gateway. */
function apiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_ENDPOINT_ORIGIN ?? env.ZCODE_BASE_URL ?? "https://zcode.z.ai";
}

const CLIENT_CONFIG_PATH = "/api/v1/client/configs";
const GATE_TIMEOUT_MS = 6000;

/**
 * Resolve the gate from the anonymous client-config endpoint. NEVER throws —
 * every failure shape returns the disabled verdict. `fetchImpl` is injectable
 * so tests run without network.
 */
export async function resolveWorkflowGate(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<WorkflowGate> {
  try {
    const query = new URLSearchParams({
      app_version: AGENT_INFO.version,
      // Upstream sends `<platform>-<arch>` ("darwin-arm64" — the desktop's
      // resolveClientPlatformKey spelling), not the bare platform name.
      platform: `${platform()}-${arch()}`,
    });
    const resp = await fetchImpl(`${apiOrigin()}${CLIENT_CONFIG_PATH}?${query}`, {
      method: "GET",
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    });
    if (!resp.ok) return GATE_DISABLED;
    const body = (await resp.json()) as {
      data?: { configs?: { dynamicWorkflow?: { mode?: unknown } | null } };
    } | null;
    const mode = body?.data?.configs?.dynamicWorkflow?.mode;
    if (typeof mode !== "string" || !(DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(mode)) {
      return GATE_DISABLED;
    }
    return {
      mode: mode as (typeof DYNAMIC_WORKFLOW_MODES)[number],
      enabled: mode !== "disabled",
      source: "remote",
    };
  } catch {
    return GATE_DISABLED;
  }
}

/**
 * Settled-gate snapshots, keyed by the (per-backend-generation) promise stored
 * in `server.backendWorkflowGate`. A promise exposes no sync read, so the
 * settled value must be cached by a collector attached when the promise is
 * CREATED (`captureGate`) — a read-time collector would return null on the
 * first `workflowGateNow` call even for an already-settled promise, hiding
 * the workflow commands from the first `/` menu after every boot.
 */
const settledGates = new WeakMap<Promise<WorkflowGate>, WorkflowGate>();

/** The gate-bearing half of ZcodeAcpServer (structural, for tests). */
export interface WorkflowGateHolder {
  backendWorkflowGate: Promise<WorkflowGate> | null;
}

/**
 * Attach the settled-value collector at CREATION and return the same promise.
 * Every assignment to `server.backendWorkflowGate` must go through this (the
 * spawn branch of `ensureBackend`) so the verdict is synchronously readable
 * the moment it settles.
 */
export function captureGate(promise: Promise<WorkflowGate>): Promise<WorkflowGate> {
  void promise.then(
    (gate) => settledGates.set(promise, gate),
    () => settledGates.set(promise, GATE_DISABLED),
  );
  return promise;
}

/**
 * Belt-and-braces: record the settled value an awaiter just observed. Sites
 * that await `server.backendWorkflowGate` directly (workflowFlag,
 * requireWorkflowEnabled) call this afterwards so a promise created outside
 * `captureGate` still becomes readable without a microtask of delay.
 */
export function rememberGate(promise: Promise<WorkflowGate>, value: WorkflowGate): void {
  settledGates.set(promise, value);
}

/**
 * Synchronously read the SETTLED gate verdict for the current backend
 * generation: null while the promise is pending or absent (fail-closed —
 * callers treat null as disabled), otherwise the resolved value. The
 * creation-time collector (`captureGate`) keeps this immediate for settled
 * promises; the read-time attach below only covers exotic promises that never
 * went through it.
 */
export function workflowGateNow(server: WorkflowGateHolder): WorkflowGate | null {
  const promise = server.backendWorkflowGate;
  if (!promise) return null;
  const settled = settledGates.get(promise);
  if (settled) return settled;
  void promise.then(
    (gate) => settledGates.set(promise, gate),
    () => settledGates.set(promise, GATE_DISABLED),
  );
  return null;
}

/** Slash-command names advertised only while the workflow gate is enabled. */
const GATED_COMMAND_NAMES = new Set(["workflow", "workflows"]);

/**
 * Send-time filter for the advertised `/` menu: the workflow commands ride the
 * static list but must only reach clients when the gate is enabled (the list is
 * built once at startup, so send time is the only reliable filter point).
 * Applied by index.ts at every sendAvailableCommands* call site — the io.ts
 * helpers deliberately take no server.
 */
export function filterWorkflowCommands<T extends { name: string }>(
  server: WorkflowGateHolder,
  commands: readonly T[],
): T[] {
  if (workflowGateNow(server)?.enabled) return [...commands];
  return commands.filter((c) => !GATED_COMMAND_NAMES.has(c.name));
}

/**
 * Minimal backend surface the policy push needs — structural, so tests can
 * pass a plain fake (the real ZcodeBackend satisfies it).
 */
export interface WorkflowPolicyTarget {
  request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ error?: { code?: number | string; message?: string } }>;
}

const POLICY_PUSH_TIMEOUT_MS = 10_000;

/**
 * Push the process-wide dynamic-workflow policy to the backend
 * (`workspace/updateDynamicWorkflowPolicy {enabled:true}`) — the first of the
 * two enable channels (the per-session `dynamicWorkflowEnabled` flag on
 * create/resume is the second; the backend ORs them). The workspace ref is
 * echoed only, never used for lookup — the policy applies to the whole
 * backend process and affects sessions created/resumed AFTER the call
 * (upstream dynamic-workflow-policy.ts). Best-effort: never throws, failures
 * only log — the per-session flag keeps working even when the push lands on
 * an older backend.
 */
export async function pushDynamicWorkflowPolicy(
  backend: WorkflowPolicyTarget,
  nextId: () => number,
  cwd: string,
): Promise<void> {
  try {
    const resp = await backend.request(
      nextId(),
      "workspace/updateDynamicWorkflowPolicy",
      { workspace: { workspacePath: cwd, workspaceKey: cwd }, enabled: true },
      POLICY_PUSH_TIMEOUT_MS,
    );
    if (resp.error) {
      if (resp.error.code === -32601) {
        // Backend build without the method — a no-op, not a failure
        // (precedent: workspace/updateProviderRegistry, handlers/session.ts).
        log("workflow-gate: backend has no workspace/updateDynamicWorkflowPolicy — skipped");
      } else {
        log(`workflow-gate: policy push failed: ${resp.error.message}`);
      }
    }
  } catch (e) {
    log(`workflow-gate: policy push threw (${e instanceof Error ? e.message : String(e)})`);
  }
}
