/**
 * Dynamic-workflow availability gate (desktop-host parity).
 *
 * The desktop's Host utility process decides whether the dynamic-workflow
 * feature (workflow tools, `/workflow` expansion) is available from an
 * ANONYMOUS remote config endpoint; a headless app-server never resolves the
 * gate itself (fail-closed false), so the bridge plays the Host:
 *
 *   GET {origin}/api/v1/client/configs?app_version=&platform=
 *   → data.configs.dynamicWorkflow.mode ∈ disabled|onDemand|alwaysOn
 *   → enabled = mode !== "disabled"
 *
 * LOCAL OVERRIDE (upstream headless-host tier): upstream's shared contract
 * (dynamic-workflow-feature.ts) defines a three-tier `ZCODE_DYNAMIC_WORKFLOW_MODE`
 * env policy, and the tier for Hosts WITHOUT a desktop main — the bridge's
 * exact position — reads the process env DIRECTLY as an ops/developer setting,
 * short-circuiting before any network action. The bridge adds a config-file
 * layer on top (workflow.mode in ~/.config/zcode-acp/config.json — the App
 * settings toggle writes it via PUT /settings/workflow-gate) with the repo's
 * usual precedence: config file > env > remote verdict.
 *
 * Fail-closed everywhere: a missing key, an unknown value, an HTTP error, a
 * fetch throw, or the 6s timeout all read as disabled — a gray-flag read must
 * never block ordinary chat (upstream returns the default verdict on failure
 * for the same reason). "Key absent" and "fetch failed" stay distinguishable
 * for observability (mode "disabled" vs "unknown", both source "default") —
 * the upstream contract folds both to disabled, the split only feeds logs and
 * the 403 error body. The REMOTE verdict is resolved ONCE per backend spawn
 * (server.backendWorkflowGate, src/server.ts ensureBackend) and pinned to
 * that backend's lifetime; the override is re-read LIVE on every consumption
 * (the user-config convention), so an App toggle flip takes effect on the
 * next gate read without restarting the bridge.
 */

import { arch, platform } from "node:os";

import { loadUserConfig } from "./user-config.js";
import { AGENT_INFO, log } from "../utils.js";

/** Remote verdict vocabulary (upstream DYNAMIC_WORKFLOW_MODES). */
export const DYNAMIC_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type DynamicWorkflowMode = (typeof DYNAMIC_WORKFLOW_MODES)[number];

/**
 * Upstream-parity normalization (`normalizeDynamicWorkflowMode`): trim + domain
 * check; undefined for anything else. Invalid values are DROPPED, never fatal.
 */
export function normalizeWorkflowMode(value: unknown): DynamicWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (DYNAMIC_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as DynamicWorkflowMode)
    : undefined;
}

export interface WorkflowGate {
  mode: DynamicWorkflowMode | "unknown";
  /** mode !== "disabled" — the consumption-side fold (onDemand ≡ alwaysOn today). */
  enabled: boolean;
  /**
   * Observability only (upstream vocabulary): "override" (local switch) vs
   * "remote" verdict vs the fail-closed "default".
   */
  source: "remote" | "override" | "default";
}

/**
 * The upstream fold for "server answered but the key is absent/invalid": a
 * plain disabled verdict — "服务端撤掉 key 等于关闭" (dynamic-workflow-feature.ts),
 * not a failure.
 */
const GATE_KEY_ABSENT: WorkflowGate = { mode: "disabled", enabled: false, source: "default" };

/**
 * Bridge-only split: a fetch that never produced a verdict (HTTP error, throw,
 * timeout, invalid envelope) is UNRESOLVED, not "server said off" — the 403
 * body and /settings/all can tell "the feature was pulled" from "the config
 * fetch is broken" (bug doc 2026-09-29 §5).
 */
const GATE_UNRESOLVED: WorkflowGate = { mode: "unknown", enabled: false, source: "default" };

/** API origin; overridable for testing and for a self-hosted gateway. */
function apiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_ENDPOINT_ORIGIN ?? env.ZCODE_BASE_URL ?? "https://zcode.z.ai";
}

const CLIENT_CONFIG_PATH = "/api/v1/client/configs";
const GATE_TIMEOUT_MS = 6000;

/**
 * Resolve the REMOTE verdict from the anonymous client-config endpoint. NEVER
 * throws — every failure shape returns a disabled verdict. `fetchImpl` is
 * injectable so tests run without network. The LOCAL override is layered on
 * top by {@link workflowOverrideNow} / the effective-* folds, not here.
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
    if (!resp.ok) return GATE_UNRESOLVED;
    const body = (await resp.json()) as {
      data?: { configs?: { dynamicWorkflow?: { mode?: unknown } | null } };
    } | null;
    const mode = normalizeWorkflowMode(body?.data?.configs?.dynamicWorkflow?.mode);
    // Absent key or an invalid value are the SAME upstream fold: the server
    // pulled the flag, the gate is off — not a fetch failure.
    if (!mode) return GATE_KEY_ABSENT;
    return { mode, enabled: mode !== "disabled", source: "remote" };
  } catch {
    return GATE_UNRESOLVED;
  }
}

/** Upstream env (headless-host tier reads process env directly). */
const WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE";

/** The override verdict: always a CONCRETE mode (never "unknown"), source fixed. */
export interface WorkflowOverrideGate {
  mode: DynamicWorkflowMode;
  enabled: boolean;
  source: "override";
}

/**
 * The LOCAL switch, re-read LIVE on every call: config-file `workflow.mode`
 * (the App settings toggle) over the upstream env var. Live reads are the
 * user-config convention — a flip takes effect on the next gate consumption
 * without restarting the bridge. Returns null when no override is set (the
 * caller falls back to the pinned remote verdict). An invalid env value is
 * silently dropped (upstream normalize semantics); an invalid file value never
 * reaches here (the config loader already warned and ignored it).
 */
export function workflowOverrideNow(
  env: NodeJS.ProcessEnv = process.env,
): WorkflowOverrideGate | null {
  const mode = loadUserConfig(env).workflow?.mode ?? normalizeWorkflowMode(env[WORKFLOW_MODE_ENV]);
  if (!mode) return null;
  return { mode, enabled: mode !== "disabled", source: "override" };
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
    () => settledGates.set(promise, GATE_UNRESOLVED),
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
    () => settledGates.set(promise, GATE_UNRESOLVED),
  );
  return null;
}

/**
 * Synchronous EFFECTIVE verdict: local override (live) first, else the pinned
 * remote verdict. null while the remote fetch is pending and no override is
 * set (callers treat null as disabled — fail-closed).
 */
export function effectiveWorkflowGateNow(server: WorkflowGateHolder): WorkflowGate | null {
  return workflowOverrideNow() ?? workflowGateNow(server);
}

/**
 * Awaited EFFECTIVE verdict: a set override short-circuits WITHOUT touching
 * the backend or the network (upstream folds the override ahead of every
 * network action — a cold App-only bridge answers the switch alone);
 * otherwise the pinned remote verdict (null when none was ever started).
 */
export async function effectiveWorkflowGate(
  server: WorkflowGateHolder,
): Promise<WorkflowGate | null> {
  const override = workflowOverrideNow();
  if (override) return override;
  const promise = server.backendWorkflowGate;
  if (!promise) return null;
  const gate = await promise;
  rememberGate(promise, gate);
  return gate;
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
  if (effectiveWorkflowGateNow(server)?.enabled) return [...commands];
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

/**
 * The policy-push half of the server (structural, for tests): the live backend
 * plus the per-generation "already pushed" marker, reset at every spawn.
 */
export interface WorkflowPolicyServer extends WorkflowGateHolder {
  readonly backend: WorkflowPolicyTarget | null;
  workflowPolicyPushed: boolean;
  nextId(): number;
  projectCwd(): string;
}

/**
 * Flip-aware second enable channel: the spawn-time push only covers a backend
 * born under an ENABLED verdict; a local override flipped on later (the App
 * settings toggle) must still reach the backend process. Once per backend
 * generation — the boolean check keeps the per-create/resume call site free.
 */
export function ensureWorkflowPolicyPushed(server: WorkflowPolicyServer): void {
  if (server.workflowPolicyPushed) return;
  if (!effectiveWorkflowGateNow(server)?.enabled) return;
  const backend = server.backend;
  if (!backend) return;
  server.workflowPolicyPushed = true;
  void pushDynamicWorkflowPolicy(backend, () => server.nextId(), server.projectCwd());
}
