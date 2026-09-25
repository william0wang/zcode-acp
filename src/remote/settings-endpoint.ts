/**
 * Settings API routes (ADR-0025), served on the bridge's loopback server and
 * re-served by the hub behind the token.
 *
 * The handler is a single factory mounted in both places, so the two routes
 * cannot drift. Everything here is a thin translation layer over
 * `src/settings/*`: parse the request, call the module, map the outcome to a
 * status code and an **effect class** the client can act on.
 *
 * Effect classes are the contract's most important field. A write answers
 * `immediate` when the running backend picks it up by itself (the provider
 * table is polled every ~1s; skills enablement is read live) and
 * `needs-restart` when the agent read it once at startup (MCP servers, hooks,
 * subagent markdown). A client that ignores this shows the user a toggle that
 * appears to do nothing.
 *
 * Error mapping is deliberately coarse — the module's messages are already
 * actionable, so they are passed through as `error` rather than re-coded.
 * Only the validation failures that indicate a malformed request get a 400;
 * an unreachable or failing upstream gets 502/504 (the request may still have
 * been carried out, so the client retries with the same idempotency key);
 * everything else is a 500, because it means the environment is wrong.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { backendCapabilities } from "../backend/adapter.js";
import { loadAllModels } from "../config/options.js";
import type { ZcodeAcpServer } from "../server.js";
import { warn } from "../utils.js";
import {
  removeModel,
  readProviderConfig,
  updateProvider,
  upsertModel,
} from "../settings/provider-config.js";
import {
  readCliConfig,
  readHooks,
  removeMcpServer,
  setHooksEnabled,
  setMcpServerEnabled,
  updateHookEntry,
  upsertMcpServer,
  validateMcpServer,
  type HookEventName,
} from "../settings/cli-config.js";
import {
  BUILT_IN_AGENTS,
  createAgent,
  deleteAgent,
  listAgents,
  setAgentEnabled,
  setBuiltInAgentModel,
  updateAgent,
} from "../settings/agents-config.js";
import {
  copySkillToUser,
  deleteSkill,
  listSkills,
  setSkillEnabledByPath,
} from "../settings/skills.js";
import { listBackups, readJsonDocument, writeJsonAtomic } from "../settings/atomic-write.js";
import { BrokenConfigError, UpstreamError } from "../settings/errors.js";
import {
  appBundlePath,
  appUpdateState,
  checkForAppUpdate,
  fetchReleaseManifest,
  installedAppVersion,
  isNewerVersion,
  resetAppUpdateStateForTest as resetAppUpdateForTest,
  startAppUpdate,
  type ReleaseChannel,
  type ReleaseFile,
} from "../settings/app-update.js";
import { readUsageStats, type UsageRange } from "../settings/usage-stats.js";
import {
  conversationRuns,
  deleteWorkflow,
  getWorkflow,
  listRuns,
  listWorkflows,
  moveWorkflow,
  requireWorkflowEnabled,
  resolveWorkflowZcodeSid,
  resumeWorkflowRun,
  runArtifactData,
  runArtifactRead,
  runArtifacts,
  runEvents,
  runNodeResult,
  runWorkspace,
  startSavedWorkflow,
  updateWorkflowMeta,
  workflowCreatePrompt,
  WorkflowApiError,
  type WorkflowScope,
} from "../settings/workflow.js";
import {
  codingPlanProviderIds,
  isCodingPlanProvider,
  markResetHistoryRead,
  readResetStatus,
  requestResetOpportunity,
  resolveResetAuthorization,
  useResetCard,
  type ResetType,
} from "../settings/coding-plan.js";
import { queryQuota } from "../quota/index.js";
import { zcodeCliConfigPath, zcodePersonalProviderPath } from "../utils.js";

/** Body size cap. Settings payloads are small; hooks are the largest. */
const MAX_BODY_BYTES = 256 * 1024;

type Effect = "immediate" | "needs-restart";

interface OkBody {
  ok: true;
  effect?: Effect;
  [key: string]: unknown;
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, code: number, error: string): void {
  sendJson(res, code, { ok: false, error });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function bool(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

function num(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Decode one path segment, treating a malformed escape as a bad request.
 *
 * `decodeURIComponent` throws on a truncated escape (`/settings/mcp/%E0`),
 * which would otherwise fall through to the route-level catch and answer 500
 * with a warn — the request was malformed, the server is fine.
 */
function segment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BadRequest(`malformed percent-encoding in path segment: ${raw}`);
  }
}

/** A request the client got wrong — always a 400, never a 500. */
class BadRequest extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map a module error to a status code.
 *
 * Three classes, and the distinction matters for retry: a broken environment
 * (a damaged config file) is a 500 the client cannot fix; an UPSTREAM failure —
 * the reset API or the release manifest being unreachable, timing out, or
 * answering 5xx — is a 502/504, which tells the client "your request may have
 * been carried out, ask again with the same idempotency key" rather than "you
 * built the request wrong". Only a genuine business rejection is a 400.
 *
 * Classification is structural, never message-matching (#240's original bug
 * shape): the settings modules throw typed errors at the site where the
 * intent is known (`BadRequest` here, `BrokenConfigError`/`UpstreamError` in
 * src/settings/errors.ts), and Node's own network failures carry their errno
 * structurally — `fetch` wraps it in `cause.code` (an `AggregateError` nests
 * it in `cause.errors[].code`), the http client sets `error.code` directly,
 * and the AbortSignal timeout surfaces as a DOMException named TimeoutError.
 * A bare `Error` is the default and stays a 400: the bulk of those are the
 * modules' own request validation ("timeoutMs must be a positive number" is
 * the client's fault, not a gateway timeout).
 */
function statusFor(error: unknown): number {
  if (error instanceof BadRequest) return 400;
  if (error instanceof BrokenConfigError) return 500;
  if (error instanceof UpstreamError) return 502;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return 504;
    const err = error as NodeJS.ErrnoException & {
      cause?: { code?: unknown; errors?: Array<{ code?: unknown }> };
    };
    const codes = [
      err.code,
      err.cause?.code,
      ...(err.cause?.errors ?? []).map((e) => e.code),
    ].filter((c): c is string => typeof c === "string");
    if (
      codes.some(
        (c) =>
          /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNABORTED|EPIPE)$/u.test(c) ||
          // undici's own failure family — e.g. a destroyed socket surfaces as
          // cause.code UND_ERR_SOCKET ("fetch failed" with no errno).
          /^UND_ERR_/u.test(c),
      )
    ) {
      return 502;
    }
    if (codes.some((c) => /^(EACCES|EPERM|EISDIR|ENOTDIR)$/u.test(c))) return 500;
  }
  return 400;
}

/**
 * Build the settings router.
 *
 * `server` is the bridge to operate on. It is only needed by
 * `/settings/backend/restart`, which has a backend to restart; the hub's
 * machine-level mount passes none and answers 501 on that route. Passing it
 * through the closure (rather than a module singleton) keeps two bridges in one
 * process — a test, or a future multi-workspace mode — from disturbing each
 * other's backend.
 *
 * Routes are matched on `url.pathname` after an optional `/api` prefix is
 * stripped, so one factory serves `/settings/…` on the loopback server and
 * `/api/settings/…` on the hub.
 */
export function createSettingsHandler(
  server?: ZcodeAcpServer,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/^\/api/u, "").replace(/\/+$/u, "") || "/";
    void route(req, res, url, path, server ?? null).catch((error) => {
      // A rejected path segment is the client's fault, not the server's — say
      // so with a 400 instead of logging a warn and answering 500.
      if (error instanceof BadRequest) {
        if (!res.writableEnded) sendError(res, 400, error.message);
        return;
      }
      warn(
        `settings: unhandled route error: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.writableEnded) sendError(res, 500, "internal error");
    });
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  server: ZcodeAcpServer | null,
): Promise<void> {
  const method = req.method ?? "GET";

  // Capability gates (ADR-0023): a backend kind without a surface gets 404 —
  // the route does not exist for it. The machine-level mount (no server)
  // proxies per-instance bridges, which enforce their own kind's table.
  const caps = backendCapabilities(server?.backendKind ?? "zcode");
  const workflowRoute =
    path === "/settings/workflows" ||
    path === "/settings/workflow-create-prompt" ||
    path === "/settings/workflow-runs" ||
    path.startsWith("/settings/workflows/") ||
    path.startsWith("/settings/workflow-runs/");
  if (workflowRoute && !caps.workflowRoutes) return sendError(res, 404, "not found");
  if (path === "/settings/backend/restart" && !caps.backendRestart) {
    return sendError(res, 404, "not found");
  }
  if (!workflowRoute && path !== "/settings/backend/restart" && !caps.settings) {
    return sendError(res, 404, "not found");
  }

  // ---- reads ----
  if (method === "GET") {
    if (path === "/settings/all") return void (await handleAll(res, server));
    if (path === "/settings/models") return void (await handleModels(res));
    if (path === "/settings/skills") return void (await handleSkills(res));
    if (path === "/settings/mcp") return void (await handleMcp(res));
    if (path === "/settings/hooks") return void (await handleHooks(res));
    if (path === "/settings/agents") return void (await handleAgents(res));
    if (path === "/settings/backups") return void (await handleBackups(res));
    if (path === "/settings/usage") return void (await handleUsage(res, url));
    if (path === "/settings/quota") return void (await handleQuota(res));
    if (path === "/settings/reset-cards") return void (await handleResetCards(res, url));
    if (path === "/settings/pending-restart") return void (await handlePendingRestart(res, server));
    if (path === "/settings/app-update") return void (await handleAppUpdate(res, url));
    // ---- dynamic-workflow management (per-instance; see the section comment
    // below the write block) ----
    if (path === "/settings/workflows") return void (await handleWorkflowList(res, server, url));
    if (path === "/settings/workflows/runs")
      return void (await handleWorkflowRuns(res, server, url));
    if (path === "/settings/workflow-create-prompt") {
      return void (await handleWorkflowCreatePrompt(res, server, url));
    }
    if (path === "/settings/workflow-runs") {
      return void (await handleConversationRuns(res, server, url));
    }
    if (path.startsWith("/settings/workflows/")) {
      const parts = path.slice("/settings/workflows/".length).split("/").map(segment);
      if (parts.length === 2)
        return void (await handleWorkflowGet(res, server, parts[0]!, parts[1]!));
    }
    if (path.startsWith("/settings/workflow-runs/")) {
      const parts = path.slice("/settings/workflow-runs/".length).split("/").map(segment);
      // [runId, kind, …] — events | artifacts | artifacts/{id}/data |
      // artifacts/{id}/read | workspace | nodes/{siteId}/{ordinal}
      if (parts.length === 2 && parts[1] === "events") {
        return void (await handleRunEvents(res, server, url, parts[0]!));
      }
      if (parts.length === 2 && parts[1] === "artifacts") {
        return void (await handleRunArtifacts(res, server, url, parts[0]!));
      }
      if (parts.length === 4 && parts[1] === "artifacts" && parts[3] === "data") {
        return void (await handleRunArtifactData(res, server, url, parts[0]!, parts[2]!));
      }
      if (parts.length === 4 && parts[1] === "artifacts" && parts[3] === "read") {
        return void (await handleRunArtifactRead(res, server, url, parts[0]!, parts[2]!));
      }
      if (parts.length === 2 && parts[1] === "workspace") {
        return void (await handleRunWorkspace(res, server, url, parts[0]!));
      }
      if (parts.length === 4 && parts[1] === "nodes") {
        return void (await handleRunNodeResult(res, server, url, parts[0]!, parts[2]!, parts[3]!));
      }
    }
    return sendError(res, 404, "not found");
  }

  // ---- writes ----
  if (method === "PUT" || method === "POST" || method === "DELETE") {
    // A body that cannot be parsed is the CLIENT's fault — 400, not the 500
    // the outer catch would produce. Everything downstream goes through
    // `guard`, which maps module errors to their own status.
    let body: Record<string, unknown> = {};
    if (method !== "DELETE") {
      try {
        body = await readBody(req);
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : String(error));
        return;
      }
    }

    if (method === "PUT" && path.startsWith("/settings/providers/")) {
      const id = segment(path.slice("/settings/providers/".length));
      return void (await handleUpdateProvider(res, id, body));
    }
    if (method === "POST" && path === "/settings/models") {
      return void (await handleUpsertModel(res, body));
    }
    if (method === "DELETE" && path.startsWith("/settings/models/")) {
      const rest = path.slice("/settings/models/".length);
      const sep = rest.indexOf("/");
      if (sep <= 0) return sendError(res, 400, "expected /settings/models/{providerId}/{modelId}");
      const providerId = segment(rest.slice(0, sep));
      const modelId = segment(rest.slice(sep + 1));
      return void (await handleRemoveModel(res, providerId, modelId));
    }
    if (method === "POST" && path === "/settings/skills/enable") {
      return void (await handleSkillEnable(res, body));
    }
    if (method === "POST" && path === "/settings/skills/copy-to-user") {
      return void (await handleSkillCopy(res, body));
    }
    if (method === "DELETE" && path.startsWith("/settings/skills/")) {
      const skillPath = segment(path.slice("/settings/skills/".length));
      return void (await handleSkillDelete(res, skillPath));
    }
    if (method === "PUT" && path.startsWith("/settings/mcp/")) {
      const name = segment(path.slice("/settings/mcp/".length));
      return void (await handleMcpUpsert(res, name, body));
    }
    if (method === "DELETE" && path.startsWith("/settings/mcp/")) {
      const name = segment(path.slice("/settings/mcp/".length));
      return void (await guard(res, async () => {
        await removeMcpServer(name);
        return { ok: true as const, effect: "needs-restart" as Effect };
      }));
    }
    if (method === "POST" && path === "/settings/mcp/enable") {
      return void (await handleMcpEnable(res, body));
    }
    if (method === "PUT" && path.startsWith("/settings/hooks/")) {
      return void (await handleHookUpdate(res, path.slice("/settings/hooks/".length), body));
    }
    if (method === "POST" && path === "/settings/hooks/enabled") {
      const enabled = bool(body, "enabled");
      if (enabled === undefined) return sendError(res, 400, "enabled (boolean) is required");
      return void (await guard(res, async () => {
        await setHooksEnabled(enabled);
        return { ok: true as const, effect: "needs-restart" as Effect };
      }));
    }
    if (
      (method === "POST" || method === "PUT") &&
      path.startsWith("/settings/agents/") &&
      path.endsWith("/enable")
    ) {
      const name = segment(path.slice("/settings/agents/".length, -"/enable".length));
      return void (await handleAgentEnable(res, name, body));
    }
    if (method === "PUT" && path.startsWith("/settings/agents/")) {
      const name = segment(path.slice("/settings/agents/".length));
      return void (await handleAgentUpsert(res, name, body));
    }
    if (method === "DELETE" && path.startsWith("/settings/agents/")) {
      const name = segment(path.slice("/settings/agents/".length));
      return void (await guard(res, async () => {
        await deleteAgent(name);
        return { ok: true as const, effect: "needs-restart" as Effect };
      }));
    }
    if (method === "POST" && path === "/settings/backups/restore") {
      return void (await handleBackupRestore(res, body));
    }
    if (method === "POST" && path === "/settings/reset-cards/use") {
      return void (await handleResetUse(res, body));
    }
    if (method === "POST" && path === "/settings/reset-cards/opportunity") {
      return void (await handleResetOpportunity(res, body));
    }
    if (method === "POST" && path === "/settings/reset-cards/history-read") {
      return void (await handleResetHistoryRead(res, body));
    }
    if (method === "POST" && path === "/settings/backend/restart") {
      return void (await handleBackendRestart(res, server));
    }
    if (method === "POST" && path === "/settings/app-update/install") {
      return void (await handleAppUpdateInstall(res, body));
    }
    // ---- dynamic-workflow management (writes) ----
    if (method === "PUT" && path.startsWith("/settings/workflows/") && path.endsWith("/meta")) {
      const rest = path.slice("/settings/workflows/".length, -"/meta".length);
      const parts = rest.split("/").map(segment);
      if (parts.length !== 2) {
        return sendError(res, 400, "expected /settings/workflows/{scope}/{name}/meta");
      }
      return void (await handleWorkflowMeta(res, server, parts[0]!, parts[1]!, body));
    }
    if (method === "DELETE" && path.startsWith("/settings/workflows/")) {
      const parts = path.slice("/settings/workflows/".length).split("/").map(segment);
      if (parts.length !== 2) {
        return sendError(res, 400, "expected /settings/workflows/{scope}/{name}");
      }
      return void (await handleWorkflowDelete(res, server, parts[0]!, parts[1]!));
    }
    if (method === "POST" && path.startsWith("/settings/workflows/") && path.endsWith("/move")) {
      const rest = path.slice("/settings/workflows/".length, -"/move".length);
      const parts = rest.split("/").map(segment);
      if (parts.length !== 2) {
        return sendError(res, 400, "expected /settings/workflows/{scope}/{name}/move");
      }
      return void (await handleWorkflowMove(res, server, parts[0]!, parts[1]!));
    }
    if (method === "POST" && path.startsWith("/settings/workflows/") && path.endsWith("/start")) {
      const rest = path.slice("/settings/workflows/".length, -"/start".length);
      const parts = rest.split("/").map(segment);
      if (parts.length !== 2) {
        return sendError(res, 400, "expected /settings/workflows/{scope}/{name}/start");
      }
      return void (await handleWorkflowStart(res, server, parts[0]!, parts[1]!, body));
    }
    if (
      method === "POST" &&
      path.startsWith("/settings/workflow-runs/") &&
      path.endsWith("/resume")
    ) {
      const runId = segment(path.slice("/settings/workflow-runs/".length, -"/resume".length));
      if (!runId || runId.includes("/")) {
        return sendError(res, 400, "expected /settings/workflow-runs/{runId}/resume");
      }
      return void (await handleWorkflowResume(res, server, runId, body));
    }
    return sendError(res, 404, "not found");
  }

  sendError(res, 405, "method not allowed");
}

/**
 * Run a write and translate its failure into a status code.
 *
 * A `needs-restart` effect also arms the pending flag, which is what
 * `GET /settings/pending-restart` reports and what the backend restart clears.
 */
async function guard(res: ServerResponse, fn: () => Promise<OkBody>): Promise<void> {
  try {
    const body = await fn();
    if (body.effect === "needs-restart") pendingRestartWrites += 1;
    sendJson(res, 200, body);
  } catch (error) {
    sendError(res, statusFor(error), error instanceof Error ? error.message : String(error));
  }
}

/**
 * How many `needs-restart` writes this process has recorded since the last
 * backend restart. Process-scoped on purpose: it answers "does THIS bridge need
 * a restart", and a restart of one bridge says nothing about another's.
 */
let pendingRestartWrites = 0;

/** Test seam: drop the counter so a suite starts from a known state. */
export function resetPendingRestartForTest(): void {
  pendingRestartWrites = 0;
}

async function handlePendingRestart(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
): Promise<void> {
  // Only a mount with a backend can answer this honestly. The hub is a SEPARATE
  // process from any bridge, so its copy of the counter is never cleared by a
  // bridge's restart: it would report "restart needed" forever, with no request
  // the client could make to satisfy it. Point at the per-instance spelling
  // instead, which relays to the bridge that actually served the write.
  if (!server) {
    sendError(
      res,
      409,
      "pending-restart is per-bridge — use /api/instances/{id}/settings/pending-restart",
    );
    return;
  }
  await guard(res, async () => ({
    ok: true as const,
    pendingRestart: pendingRestartWrites > 0,
    writes: pendingRestartWrites,
  }));
}

// ---------- reads ----------

async function handleAll(res: ServerResponse, server: ZcodeAcpServer | null): Promise<void> {
  // Local config files are the environment: a failure here means the machine's
  // ZCode install is broken, so the whole request fails rather than returning a
  // half-populated screen.
  let models: unknown;
  let skills: unknown;
  let mcp: unknown;
  let hooks: unknown;
  let agents: unknown;
  try {
    [models, skills, mcp, hooks, agents] = await Promise.all([
      handleModelsPayload(),
      listSkills(),
      readMcpView(),
      readHooks(),
      listAgents(),
    ]);
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
    return;
  }
  // The two optional sections degrade independently: no local agent database and
  // no decryptable credential store are normal states on a machine that never
  // ran an agent or never linked a coding plan, and a first-screen render must
  // not fail because one of them is unavailable.
  const usage = await readUsageStats("7d").catch(() => ({
    available: false as const,
    range: "7d" as const,
    summary: { totalTokens: 0, requestCount: 0, models: 0 },
    models: [],
    daily: [],
  }));
  // Reset cards are NOT fetched here: `readResetStatus` needs a providerId and
  // makes a network call per provider, which a first-screen snapshot must not
  // do. The client gets eligibility only, and calls
  // `GET /settings/reset-cards?providerId=…` for the cards themselves.
  const resetCards = await resetCardEligibility();
  // Workflow gate: an independent degrade like usage — the machine-level mount
  // has no backend (and so no gate) and reports `{available:false}`; a mount
  // with a bridge reports the pinned verdict for its current backend.
  const workflow = server ? await readWorkflowGateBlock(server) : { available: false as const };
  sendJson(res, 200, { ok: true, models, skills, mcp, hooks, agents, usage, resetCards, workflow });
}

/**
 * The gate verdict for `/settings/all`, folded to the disabled default on any
 * failure. A bridge whose backend was never spawned (App-only flow) gets one
 * here: ensureBackend starts the gate fetch, so the snapshot reports the real
 * verdict instead of a false disabled.
 */
async function readWorkflowGateBlock(server: ZcodeAcpServer): Promise<{
  enabled: boolean;
  mode: string;
  source: string;
}> {
  try {
    if (!server.backendWorkflowGate) {
      await server.ensureBackend().catch((): undefined => undefined);
    }
    const gate = server.backendWorkflowGate ? await server.backendWorkflowGate : null;
    return gate ?? { enabled: false, mode: "unknown", source: "default" };
  } catch {
    return { enabled: false, mode: "unknown", source: "default" };
  }
}

/**
 * Which providers could spend a reset card, and whether the machine has a
 * decryptable credential store to try with.
 *
 * Deliberately offline and cheap: eligibility is a provider-id shape check, and
 * credential presence is the decrypt step. A provider listed here with
 * `credentials: false` means the section should render disabled rather than
 * error, because the store is encrypted per machine and its absence is normal.
 *
 * Only `credentials_unavailable` (the store is missing or unreadable) counts as
 * "no credentials" — a store that decrypts but lacks a JWT is a linked-account
 * problem the status call will report precisely, so the snapshot says
 * `credentials: true` and lets that call answer.
 */
async function resetCardEligibility(): Promise<{
  providers: string[];
  credentials: boolean;
  reason?: string;
}> {
  const providers = codingPlanProviderIds();
  try {
    await resolveResetAuthorization(providers[0]!);
    return { providers, credentials: true };
  } catch (error) {
    const reason = messageOf(error);
    return { providers, credentials: reason !== "credentials_unavailable", reason };
  }
}

async function handleModelsPayload(): Promise<unknown> {
  const available = loadAllModels();
  const personal = await readProviderConfig();
  const rules = personal.config.providerConfigRules.providerRules;
  return {
    available,
    providers: rules.map((rule) => ({
      providerId: rule.providerId,
      providerName: rule.providerName,
      enabled: rule.enabled !== false,
      modelIds: rule.config?.personalModelIds ?? [],
      baseUrl: rule.config?.api?.baseUrl,
      apiType: rule.config?.api?.type,
    })),
    modelRules: [
      ...personal.config.modelConfigRules.providerModelRules,
      ...personal.config.modelConfigRules.manualProviderModelRules,
    ].map((rule) => ({
      providerId: rule.providerId,
      modelId: rule.modelId,
      enabled: rule.config.enabled !== false,
      contextWindow: rule.config.properties?.contextWindow,
      reasoningLevels: rule.config.optionSpecs?.reasoningLevel?.values,
    })),
  };
}

async function handleModels(res: ServerResponse): Promise<void> {
  await guard(res, async () => ({ ok: true as const, models: await handleModelsPayload() }));
}

async function handleSkills(res: ServerResponse): Promise<void> {
  await guard(res, async () => ({ ok: true as const, skills: await listSkills() }));
}

async function readMcpView(): Promise<unknown> {
  const doc = await readCliConfig();
  const servers = doc.mcp?.servers ?? {};
  return {
    servers: Object.entries(servers).map(([name, config]) => ({
      name,
      type: config.type ?? "stdio",
      command: config.command,
      args: config.args,
      url: config.url,
      env: config.env,
      headers: config.headers,
      enabled: config.enabled !== false,
    })),
  };
}

async function handleMcp(res: ServerResponse): Promise<void> {
  await guard(res, async () => ({ ok: true as const, mcp: await readMcpView() }));
}

async function handleHooks(res: ServerResponse): Promise<void> {
  await guard(res, async () => {
    const hooks = await readHooks();
    return {
      ok: true as const,
      hooks,
      // Surface the gate explicitly: hooks are inert without it, and a client
      // that only shows the tree makes a working config look broken.
      enabled: hooks.enabled === true,
    };
  });
}

async function handleAgents(res: ServerResponse): Promise<void> {
  await guard(res, async () => ({
    ok: true as const,
    agents: await listAgents(),
    builtIn: [...BUILT_IN_AGENTS],
  }));
}

async function handleBackups(res: ServerResponse): Promise<void> {
  await guard(res, async () => {
    const [provider, cli] = await Promise.all([
      listBackups(zcodePersonalProviderPath()),
      listBackups(zcodeCliConfigPath()),
    ]);
    return { ok: true as const, backups: { providerConfig: provider, cliConfig: cli } };
  });
}

// ---------- writes ----------

async function handleUpdateProvider(
  res: ServerResponse,
  providerId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const enabled = bool(body, "enabled");
  const providerName = str(body, "providerName");
  if (enabled === undefined && providerName === undefined) {
    sendError(res, 400, "nothing to update — send enabled and/or providerName");
    return;
  }
  await guard(res, async () => {
    await updateProvider(providerId, {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(providerName !== undefined ? { providerName } : {}),
    });
    return { ok: true as const, effect: "immediate" as Effect };
  });
}

async function handleUpsertModel(
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const providerId = str(body, "providerId");
  const modelId = str(body, "modelId");
  if (!providerId || !modelId) {
    sendError(res, 400, "providerId and modelId are required");
    return;
  }
  await guard(res, async () => {
    await upsertModel(providerId, modelId, {
      ...(bool(body, "enabled") !== undefined ? { enabled: bool(body, "enabled") } : {}),
      ...(num(body, "contextWindow") !== undefined
        ? { properties: { contextWindow: num(body, "contextWindow") } }
        : {}),
      ...(Array.isArray(body["reasoningLevels"])
        ? { optionSpecs: { reasoningLevel: { values: body["reasoningLevels"] as string[] } } }
        : {}),
    });
    return { ok: true as const, effect: "immediate" as Effect };
  });
}

async function handleRemoveModel(
  res: ServerResponse,
  providerId: string,
  modelId: string,
): Promise<void> {
  await guard(res, async () => {
    await removeModel(providerId, modelId);
    return { ok: true as const, effect: "immediate" as Effect };
  });
}

async function handleSkillEnable(
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const skillPath = str(body, "path");
  const enable = bool(body, "enable");
  if (!skillPath || enable === undefined) {
    sendError(res, 400, "path and enable are required");
    return;
  }
  await guard(res, async () => {
    await setSkillEnabledByPath(skillPath, enable);
    return { ok: true as const, effect: "immediate" as Effect };
  });
}

async function handleSkillCopy(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const skillPath = str(body, "path");
  if (!skillPath) {
    sendError(res, 400, "path is required");
    return;
  }
  await guard(res, async () => {
    const target = await copySkillToUser(skillPath);
    return { ok: true as const, effect: "immediate" as Effect, path: target };
  });
}

async function handleSkillDelete(res: ServerResponse, skillPath: string): Promise<void> {
  await guard(res, async () => {
    await deleteSkill(skillPath);
    return { ok: true as const, effect: "immediate" as Effect };
  });
}

async function handleMcpUpsert(
  res: ServerResponse,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  // Type-check the known fields before they land: a value the runtime rejects
  // (an `args` string where it wants an array) would take out every server on
  // the next start, not just this one.
  const verdict = validateMcpServer(name, body);
  if (verdict !== true) {
    sendError(res, 400, typeof verdict === "string" ? verdict : "invalid MCP server config");
    return;
  }
  await guard(res, async () => {
    await upsertMcpServer(name, body as never);
    return { ok: true as const, effect: "needs-restart" as Effect };
  });
}

async function handleMcpEnable(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const name = str(body, "name");
  const enabled = bool(body, "enabled");
  if (!name || enabled === undefined) {
    sendError(res, 400, "name and enabled are required");
    return;
  }
  await guard(res, async () => {
    await setMcpServerEnabled(name, enabled);
    return { ok: true as const, effect: "needs-restart" as Effect };
  });
}

async function handleHookUpdate(
  res: ServerResponse,
  rest: string,
  body: Record<string, unknown>,
): Promise<void> {
  const parts = rest.split("/");
  if (parts.length !== 2) {
    sendError(res, 400, "expected /settings/hooks/{event}/{matcherIndex}");
    return;
  }
  const event = segment(parts[0]!) as HookEventName;
  const matcherIndex = Number(parts[1]);
  const hookIndex = num(body, "hookIndex");
  if (!Number.isInteger(matcherIndex) || hookIndex === undefined || !Number.isInteger(hookIndex)) {
    sendError(res, 400, "matcherIndex (path) and hookIndex (body) must be integers");
    return;
  }
  await guard(res, async () => {
    await updateHookEntry(event, matcherIndex, hookIndex, {
      ...(str(body, "command") !== undefined ? { command: str(body, "command") } : {}),
      ...(bool(body, "enabled") !== undefined ? { enabled: bool(body, "enabled") } : {}),
      ...(num(body, "timeoutMs") !== undefined ? { timeoutMs: num(body, "timeoutMs") } : {}),
      ...(num(body, "timeout") !== undefined ? { timeout: num(body, "timeout") } : {}),
    });
    return { ok: true as const, effect: "needs-restart" as Effect };
  });
}

async function handleAgentUpsert(
  res: ServerResponse,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  await guard(res, async () => {
    // A built-in agent has no file, so "PUT" on one means a model override.
    if (BUILT_IN_AGENTS.includes(name as (typeof BUILT_IN_AGENTS)[number])) {
      // Presence, not truthiness: `null` is the documented way to CLEAR an
      // override, and reading through str() would map it to `undefined` and
      // make the clear path unreachable.
      const hasProvider = "providerId" in body;
      const hasModel = "modelId" in body;
      const providerId = str(body, "providerId");
      const modelId = str(body, "modelId");
      const clearing = hasProvider && hasModel && providerId === undefined && modelId === undefined;
      if (!clearing && (providerId === undefined || modelId === undefined)) {
        throw new Error(
          "a built-in agent override needs providerId and modelId; send nulls to clear",
        );
      }
      if (clearing) {
        await setBuiltInAgentModel(name, undefined);
        return { ok: true as const, effect: "needs-restart" as Effect };
      }
      const reasoningLevel = str(body, "reasoningLevel");
      await setBuiltInAgentModel(name, {
        providerId: providerId!,
        modelId: modelId!,
        ...(reasoningLevel !== undefined ? { thoughtLevel: reasoningLevel } : {}),
      });
      return { ok: true as const, effect: "needs-restart" as Effect };
    }
    const description = str(body, "description");
    const patch = {
      ...(description !== undefined ? { description } : {}),
      ...(str(body, "color") !== undefined ? { color: str(body, "color") } : {}),
      ...("model" in body ? { model: (body["model"] as string | null) ?? null } : {}),
      ...("thoughtLevel" in body
        ? { thoughtLevel: (body["thoughtLevel"] as string | null) ?? null }
        : {}),
    };
    let agent;
    try {
      agent = await updateAgent(name, patch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/does not exist/u.test(message)) throw error;
      // Creating is the natural reading of a PUT on a missing agent.
      if (description === undefined) throw new Error("description is required to create an agent");
      agent = await createAgent({
        name,
        description,
        ...(str(body, "color") !== undefined ? { color: str(body, "color") } : {}),
        ...(typeof body["model"] === "string" ? { model: body["model"] } : {}),
        ...(typeof body["thoughtLevel"] === "string" ? { thoughtLevel: body["thoughtLevel"] } : {}),
      });
    }
    return { ok: true as const, effect: "needs-restart" as Effect, agent };
  });
}

async function handleAgentEnable(
  res: ServerResponse,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  const enable = bool(body, "enable");
  if (enable === undefined) {
    sendError(res, 400, "enable (boolean) is required");
    return;
  }
  await guard(res, async () => {
    await setAgentEnabled(name, enable);
    return { ok: true as const, effect: "needs-restart" as Effect };
  });
}

async function handleBackupRestore(
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const which = str(body, "file");
  const backupPath = str(body, "path");
  if (which !== "providerConfig" && which !== "cliConfig") {
    sendError(res, 400, "file must be 'providerConfig' or 'cliConfig'");
    return;
  }
  if (!backupPath) {
    sendError(res, 400, "path is required");
    return;
  }
  const target = which === "providerConfig" ? zcodePersonalProviderPath() : zcodeCliConfigPath();
  // The backup must be one of THIS file's backups — refusing an arbitrary path
  // keeps the restore endpoint from becoming a general file-write primitive.
  if (!backupPath.startsWith(`${target}.bak-`)) {
    sendError(res, 400, "path is not a backup of the requested file");
    return;
  }
  await guard(res, async () => {
    const doc = await readJsonDocument(backupPath);
    if (doc === null) throw new Error("backup is not a readable JSON object");
    await writeJsonAtomic(target, () => doc, { skipBackup: false });
    // The effect class follows the FILE, not the operation: provider_config is
    // absorbed by the backend's ~1s poll, while cli/config.json carries MCP
    // servers, hooks and plugin enablement, which the agent reads once at start.
    // Reporting `immediate` for a cli-config restore would leave the client
    // never prompting for the restart that change actually needs.
    const effect: Effect = which === "providerConfig" ? "immediate" : "needs-restart";
    return { ok: true as const, effect, restored: backupPath };
  });
}

// ---------- usage / quota / reset cards ----------

const USAGE_RANGES = new Set<UsageRange>(["7d", "30d", "all"]);

async function handleUsage(res: ServerResponse, url: URL): Promise<void> {
  const requested = url.searchParams.get("range") ?? "7d";
  if (!USAGE_RANGES.has(requested as UsageRange)) {
    sendError(res, 400, "range must be one of 7d, 30d, all");
    return;
  }
  await guard(res, async () => ({
    ok: true as const,
    usage: await readUsageStats(requested as UsageRange),
  }));
}

async function handleQuota(res: ServerResponse): Promise<void> {
  // Quota is account-level and already has a full result model; it is passed
  // through so a settings screen and the CLI card render the same data.
  await guard(res, async () => ({ ok: true as const, quota: await queryQuota() }));
}

/**
 * Read the reset-card inventory.
 *
 * The `nonce` in the response is what `use` requires. It is generated here, per
 * read, so a client cannot spend a card from a screen it loaded an hour ago
 * without first refreshing.
 */
async function handleResetCards(res: ServerResponse, url: URL): Promise<void> {
  const providerId = url.searchParams.get("providerId") ?? "";
  if (!isCodingPlanProvider(providerId)) {
    sendError(res, 403, "reset cards require an account coding-plan provider id");
    return;
  }
  await guard(res, async () => {
    const resetCards = await readResetStatus(providerId);
    // Register the nonce so the matching `use` call can validate against it.
    rememberResetNonce(providerId, resetCards.nonce);
    return { ok: true as const, resetCards };
  });
}

/**
 * Spend one reset card.
 *
 * The nonce is checked against the one issued by the most recent status read
 * for this provider, and the idempotency key makes a retry safe. Both are
 * required: without the nonce a stale screen could burn a card, and without the
 * key a dropped response would let a retry burn a second one.
 *
 * The nonce is burned only AFTER the backend call settles, never before. The
 * backend burns the card itself keyed on the idempotency key, so a request that
 * reached the server and failed on the way back (timeout, dropped response,
 * credential hiccup) can be retried with the SAME nonce and the SAME key and
 * answer the same outcome. Burning it up front left the store holding a nonce
 * the server had already consumed: every retry answered 409 no matter how many
 * times the user tapped, and the only escape was finding the refresh control by
 * trial and error. A nonce that fails validation up front is still rejected
 * untouched — the burn happens only on a nonce this process actually accepted.
 */
async function handleResetUse(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const providerId = str(body, "providerId");
  const resetType = str(body, "resetType");
  const nonce = str(body, "nonce");
  const idempotencyKey = str(body, "idempotencyKey");
  if (!providerId || !isCodingPlanProvider(providerId)) {
    sendError(res, 403, "reset cards require an account coding-plan provider id");
    return;
  }
  if (resetType !== "FIVE_HOUR" && resetType !== "WEEK") {
    sendError(res, 400, "resetType must be FIVE_HOUR or WEEK");
    return;
  }
  if (!nonce || !idempotencyKey) {
    sendError(res, 400, "nonce and idempotencyKey are required");
    return;
  }
  // Validate without burning: the burn happens once the outcome is known. A
  // spend already in flight for this provider rejects outright — without that
  // check the deferred burn reopens the double-spend window, because a second
  // gesture (a double tap, or a different client) reaches useResetCard with its
  // own idempotency key before the first one settles.
  if (!issuedNonces.get(providerId) || issuedNonces.get(providerId) !== nonce) {
    sendError(res, 409, "nonce is stale — refresh the reset card status and try again");
    return;
  }
  if (resetSpendsInFlight.has(providerId)) {
    sendError(res, 409, "a reset for this provider is already in progress");
    return;
  }
  resetSpendsInFlight.add(providerId);
  try {
    await guard(res, async () => {
      const result = await useResetCard(providerId, resetType as ResetType, idempotencyKey);
      // Burn only now: a retry that never reached the backend (a 400/500 thrown
      // above, or a response the client never saw) may reuse this nonce. Delete
      // only if it is still the nonce this request validated — a status read
      // that landed mid-spend minted a newer one, and that one is what the
      // client will send next.
      if (issuedNonces.get(providerId) === nonce) issuedNonces.delete(providerId);
      return { ok: true as const, ...result };
    });
  } finally {
    resetSpendsInFlight.delete(providerId);
  }
}

async function handleResetOpportunity(
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const providerId = str(body, "providerId");
  const idempotencyKey = str(body, "idempotencyKey");
  if (!providerId || !isCodingPlanProvider(providerId)) {
    sendError(res, 403, "reset cards require an account coding-plan provider id");
    return;
  }
  if (!idempotencyKey) {
    sendError(res, 400, "idempotencyKey is required");
    return;
  }
  await guard(res, async () => ({
    ok: true as const,
    opportunity: await requestResetOpportunity(providerId, idempotencyKey),
  }));
}

async function handleResetHistoryRead(
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const providerId = str(body, "providerId");
  if (!providerId || !isCodingPlanProvider(providerId)) {
    sendError(res, 403, "reset cards require an account coding-plan provider id");
    return;
  }
  await guard(res, async () => {
    await markResetHistoryRead(providerId);
    return { ok: true as const };
  });
}

/**
 * Nonces issued by the most recent status read, one per provider.
 *
 * In-memory and single-use: a restart clears them, which only costs the user a
 * refresh. There is deliberately no persistence — a nonce that survived a
 * restart would outlive the status it vouched for.
 *
 * The burn is DEFERRED to after the backend call settles (see `handleResetUse`)
 * so a retry after a mid-request failure is not locked out forever. That is
 * safe because the spend itself is idempotent server-side: the same
 * idempotency key answers the same outcome, so re-presenting a still-valid
 * nonce cannot burn a second card. A CONCURRENT gesture is the case the
 * deferred burn does not cover — that one is rejected by
 * `resetSpendsInFlight` before it can race the in-flight spend.
 */
const issuedNonces = new Map<string, string>();

/**
 * Providers with a spend in flight right now, one entry at a time per provider.
 *
 * The deferred burn is safe for a RETRY of the same gesture, whose second
 * request carries the same idempotency key and therefore cannot burn a second
 * card. It is NOT safe for a second, independent gesture (a double tap, or
 * another client that read the same status), which brings its own key — so
 * while a spend is running, every other use for that provider is refused
 * instead of racing it to the backend.
 */
const resetSpendsInFlight = new Set<string>();

/** Record the nonce a status read just issued. */
export function rememberResetNonce(providerId: string, nonce: string): void {
  issuedNonces.set(providerId, nonce);
}

/**
 * Restart the bridge's backend so a `needs-restart` write takes effect.
 *
 * The shape is copied from `applySandboxFlip()`: cancel in-flight turns, close
 * the subprocess, and let the next `ensureBackend()` respawn it. The response
 * reports how many conversations were interrupted so the client can warn
 * BEFORE the user commits to it.
 *
 * Only the loopback mount can do this — the hub proxies it per instance, so a
 * client must name the bridge it means to disturb. The hub's own
 * `/api/settings/*` mount has no backend to restart.
 */
async function handleBackendRestart(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
): Promise<void> {
  if (!server) {
    sendError(res, 501, "this mount has no backend to restart");
    return;
  }
  const cancelled = server.pendingTurns.size;
  server.cancelAllPendingTurns();
  let closed = false;
  try {
    await server.backend?.close();
    closed = true;
  } catch (error) {
    warn(
      `settings: backend restart close failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The respawned backend reads MCP servers, hooks and subagent markdown at
  // startup, so everything this process was waiting on is now applied — but
  // only if the old subprocess actually went away. A close that failed while
  // the process survives would leave the needs-restart writes unapplied, so
  // the flag stays armed and the client is told to retry.
  if (closed) pendingRestartWrites = 0;
  sendJson(res, 200, { ok: true, cancelledTurns: cancelled, closed });
}

// ---------- dynamic-workflow management (plan §7, per-instance routes) ----------
//
// These routes proxy the backend's saved-workflow + run surfaces and are
// PER-INSTANCE by construction: the bridge loopback serves them directly and
// the hub re-serves them through the per-instance proxy
// (`/api/instances/{id}/settings/…`, already covered by the hub's settings
// wildcard). The hub's machine-level mount has no backend and no gate, so it
// answers 409 pointing at the per-instance spelling (the pending-restart
// precedent). Every handler also enforces the workflow gate: the upstream v4
// start/resume commands are NOT policy-gated backend-side, so the bridge
// guards with 403 workflow_disabled itself.

/**
 * Run one workflow handler with the mount + gate + error translation applied.
 * Module errors carry their own HTTP code (`WorkflowApiError.code`) and a
 * short `reason` token; anything else is an internal error, never a silent 200.
 */
async function workflowGuard(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  fn: (server: ZcodeAcpServer) => Promise<OkBody>,
): Promise<void> {
  if (!server) {
    sendError(
      res,
      409,
      "workflow routes are per-bridge — use /api/instances/{id}/settings/workflows",
    );
    return;
  }
  try {
    sendJson(res, 200, await fn(server));
  } catch (error) {
    if (error instanceof WorkflowApiError) {
      sendJson(res, error.code, {
        ok: false as const,
        error: error.reason,
        ...(error.message !== error.reason ? { message: error.message } : {}),
      });
      return;
    }
    warn(
      `settings: workflow route failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!res.writableEnded) sendError(res, 500, "internal error");
  }
}

/** Validate a scope value from a path segment or query parameter. */
function requireWorkflowScope(raw: string): WorkflowScope {
  if (raw === "project" || raw === "global") return raw;
  throw new WorkflowApiError(400, "invalid_scope", "scope must be one of project, global");
}

/** Read an optional integer query parameter; a non-integer is a 400. */
function intQuery(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new WorkflowApiError(400, "invalid_query", `${key} must be an integer`);
  }
  return n;
}

/** Optional integer query parameter that must be ≥ 0 when present (a cursor). */
function nonNegativeIntQuery(url: URL, key: string): number | undefined {
  const n = intQuery(url, key);
  if (n !== undefined && n < 0) {
    throw new WorkflowApiError(400, "invalid_query", `${key} must not be negative`);
  }
  return n;
}

/** Read a REQUIRED integer query parameter (≥ 0 unless `positive`). */
function requiredIntQuery(url: URL, key: string): number {
  const n = intQuery(url, key);
  if (n === undefined) {
    throw new WorkflowApiError(400, "invalid_query", `${key} is required and must be an integer`);
  }
  if (n < 0) {
    throw new WorkflowApiError(400, "invalid_query", `${key} must not be negative`);
  }
  return n;
}

async function handleWorkflowList(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
): Promise<void> {
  const scopeRaw = url.searchParams.get("scope");
  await workflowGuard(res, server, async (srv) => {
    const scope = scopeRaw ? requireWorkflowScope(scopeRaw) : undefined;
    return { ok: true as const, ...(await listWorkflows(srv, scope)) };
  });
}

async function handleWorkflowGet(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  scopeRaw: string,
  name: string,
): Promise<void> {
  await workflowGuard(res, server, async (srv) => {
    const scope = requireWorkflowScope(scopeRaw);
    return { ok: true as const, ...(await getWorkflow(srv, scope, name)) };
  });
}

async function handleWorkflowMeta(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  scopeRaw: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  await workflowGuard(res, server, async (srv) => {
    const scope = requireWorkflowScope(scopeRaw);
    return { ok: true as const, ...(await updateWorkflowMeta(srv, scope, name, body)) };
  });
}

async function handleWorkflowDelete(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  scopeRaw: string,
  name: string,
): Promise<void> {
  await workflowGuard(res, server, async (srv) => {
    const scope = requireWorkflowScope(scopeRaw);
    return { ok: true as const, ...(await deleteWorkflow(srv, scope, name)) };
  });
}

/**
 * Move a saved workflow global→project (the only direction the backend
 * supports; promoting the other way goes through SaveWorkflow in a session).
 */
async function handleWorkflowMove(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  scopeRaw: string,
  name: string,
): Promise<void> {
  await workflowGuard(res, server, async (srv) => {
    const scope = requireWorkflowScope(scopeRaw);
    return { ok: true as const, ...(await moveWorkflow(srv, scope, name)) };
  });
}

async function handleWorkflowRuns(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
): Promise<void> {
  const scopeRaw = url.searchParams.get("scope");
  const name = url.searchParams.get("name") ?? undefined;
  await workflowGuard(res, server, async (srv) => {
    // intQuery runs INSIDE the guard so a malformed value answers 400, not
    // the route-level 500 (the handleRunArtifactRead pattern).
    const limit = intQuery(url, "limit");
    const scope = scopeRaw ? requireWorkflowScope(scopeRaw) : undefined;
    return { ok: true as const, ...(await listRuns(srv, { scope, name, limit })) };
  });
}

/** List a session's runs incl. the `resumable` flag (the resume button's source). */
async function handleConversationRuns(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  await workflowGuard(res, server, async (srv) => {
    const limit = intQuery(url, "limit");
    if (!sessionId) throw new WorkflowApiError(400, "invalid_query", "sessionId is required");
    const zcodeSid = resolveWorkflowZcodeSid(srv, sessionId);
    return { ok: true as const, ...(await conversationRuns(srv, zcodeSid, limit)) };
  });
}

async function handleRunEvents(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
  runId: string,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  await workflowGuard(res, server, async (srv) => {
    const afterSequence = nonNegativeIntQuery(url, "afterSequence");
    if (!sessionId) throw new WorkflowApiError(400, "invalid_query", "sessionId is required");
    const zcodeSid = resolveWorkflowZcodeSid(srv, sessionId);
    return {
      ok: true as const,
      ...(await runEvents(srv, zcodeSid, runId, afterSequence)),
    };
  });
}

async function handleRunArtifacts(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
  runId: string,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  await workflowGuard(res, server, async (srv) => {
    if (!sessionId) throw new WorkflowApiError(400, "invalid_query", "sessionId is required");
    const zcodeSid = resolveWorkflowZcodeSid(srv, sessionId);
    return { ok: true as const, ...(await runArtifacts(srv, zcodeSid, runId)) };
  });
}

async function handleRunArtifactData(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
  runId: string,
  artifactId: string,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  await workflowGuard(res, server, async (srv) => {
    const afterSequence = nonNegativeIntQuery(url, "afterSequence");
    const limit = intQuery(url, "limit");
    if (!sessionId) throw new WorkflowApiError(400, "invalid_query", "sessionId is required");
    const zcodeSid = resolveWorkflowZcodeSid(srv, sessionId);
    return {
      ok: true as const,
      ...(await runArtifactData(srv, zcodeSid, runId, artifactId, afterSequence, limit)),
    };
  });
}

async function handleRunArtifactRead(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
  runId: string,
  artifactId: string,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  await workflowGuard(res, server, async (srv) => {
    if (!sessionId) throw new WorkflowApiError(400, "invalid_query", "sessionId is required");
    const zcodeSid = resolveWorkflowZcodeSid(srv, sessionId);
    const version = requiredIntQuery(url, "version");
    const offset = requiredIntQuery(url, "offset");
    const limit = intQuery(url, "limit");
    return {
      ok: true as const,
      ...(await runArtifactRead(srv, zcodeSid, runId, artifactId, version, offset, limit)),
    };
  });
}

async function handleRunWorkspace(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
  runId: string,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  await workflowGuard(res, server, async (srv) => {
    if (!sessionId) throw new WorkflowApiError(400, "invalid_query", "sessionId is required");
    const zcodeSid = resolveWorkflowZcodeSid(srv, sessionId);
    return { ok: true as const, ...(await runWorkspace(srv, zcodeSid, runId)) };
  });
}

async function handleRunNodeResult(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
  runId: string,
  siteId: string,
  ordinalRaw: string,
): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  await workflowGuard(res, server, async (srv) => {
    if (!sessionId) throw new WorkflowApiError(400, "invalid_query", "sessionId is required");
    const zcodeSid = resolveWorkflowZcodeSid(srv, sessionId);
    const ordinal = Number(ordinalRaw);
    if (!Number.isInteger(ordinal) || ordinal < 0) {
      throw new WorkflowApiError(400, "invalid_query", "ordinal must be a non-negative integer");
    }
    return { ok: true as const, ...(await runNodeResult(srv, zcodeSid, runId, siteId, ordinal)) };
  });
}

/**
 * Launch a saved workflow. No `sessionId` → the bridge creates a session the
 * App can see and attach to; with `sessionId` → launches in that (idle)
 * session. The response carries `acpSessionId` + the ack's `runId`/
 * `toolCallId` so the client can join its progress card immediately.
 */
async function handleWorkflowStart(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  scopeRaw: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  const args = body["args"];
  const sessionId = str(body, "sessionId");
  await workflowGuard(res, server, async (srv) => {
    const scope = requireWorkflowScope(scopeRaw);
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      throw new WorkflowApiError(400, "invalid_request", "args must be a JSON object");
    }
    const started = await startSavedWorkflow(srv, {
      scope,
      name,
      ...(sessionId ? { acpSessionId: sessionId } : {}),
      ...(args !== undefined ? { args: args as Record<string, unknown> } : {}),
    });
    return { ok: true as const, ...started };
  });
}

/** Resume a stopped run in the caller-named session. */
async function handleWorkflowResume(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  runId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const sessionId = str(body, "sessionId");
  const name = str(body, "name");
  await workflowGuard(res, server, async (srv) => {
    if (!sessionId) {
      throw new WorkflowApiError(400, "invalid_request", "sessionId is required");
    }
    await resumeWorkflowRun(srv, {
      runId,
      acpSessionId: sessionId,
      ...(name ? { name } : {}),
    });
    return { ok: true as const };
  });
}

/**
 * The desktop's prefilled "create via conversation" prompt — the App puts
 * this in the composer draft; it is prefill only, never auto-sent.
 */
async function handleWorkflowCreatePrompt(
  res: ServerResponse,
  server: ZcodeAcpServer | null,
  url: URL,
): Promise<void> {
  const scopeRaw = url.searchParams.get("scope");
  await workflowGuard(res, server, async (srv) => {
    await requireWorkflowEnabled(srv);
    const scope = scopeRaw ? requireWorkflowScope(scopeRaw) : undefined;
    return { ok: true as const, prompt: workflowCreatePrompt(scope) };
  });
}

// ---------- app update (ZCode desktop) ----------

const APP_UPDATE_CHANNELS = new Set<ReleaseChannel>(["stable", "preview"]);

/**
 * Check the ZCode desktop app for a newer version.
 *
 * `channel=preview` opts into the preview stream (the app's own setting); the
 * default is stable. A machine with no app installed is not an error — the
 * response says so and `updateAvailable` stays false, so the client hides the
 * row instead of showing a failure.
 */
async function handleAppUpdate(res: ServerResponse, url: URL): Promise<void> {
  const requested = url.searchParams.get("channel") ?? "stable";
  if (!APP_UPDATE_CHANNELS.has(requested as ReleaseChannel)) {
    sendError(res, 400, "channel must be one of stable, preview");
    return;
  }
  await guard(res, async () => {
    const check = await checkForAppUpdate({ channel: requested as ReleaseChannel });
    return {
      ok: true as const,
      appUpdate: {
        updateAvailable: check.updateAvailable,
        currentVersion: check.currentVersion,
        latestVersion: check.latestVersion,
        channel: check.channel,
        platform: check.platform,
        appPath: appBundlePath(),
        releaseName: check.release?.releaseName ?? null,
        releaseNotes: check.release?.releaseNotes ?? null,
        files: check.release?.files ?? [],
        install: appUpdateState(),
      },
    };
  });
}

/**
 * Download and install a newer ZCode app build.
 *
 * The version and artifact URL are re-fetched from the release manifest here
 * rather than trusted from the request, so the client cannot install a build the
 * feed does not currently offer. That closes two holes a client-supplied URL
 * would leave open: installing an OLD version (a silent downgrade that the
 * manifest's `sha512` would happily verify), and skipping the checksum entirely.
 *
 * The work runs in the background and the response is the immediate state; the
 * client polls `GET /settings/app-update` (or re-reads this route's `install`
 * field) for progress.
 */
async function handleAppUpdateInstall(
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const version = str(body, "version");
  const url = str(body, "url");
  const channel = str(body, "channel") ?? "stable";
  if (!version) {
    sendError(res, 400, "version is required");
    return;
  }
  if (!url) {
    sendError(res, 400, "url is required");
    return;
  }
  if (!APP_UPDATE_CHANNELS.has(channel as ReleaseChannel)) {
    sendError(res, 400, "channel must be one of stable, preview");
    return;
  }
  // Only the official CDN may serve the artifact. Accepting an arbitrary URL
  // would turn this endpoint into a fetch-and-execute primitive.
  if (!/^https:\/\/cdn-zcode\.z\.ai\//u.test(url)) {
    sendError(res, 400, "url must be an official ZCode CDN artifact");
    return;
  }
  if (appUpdateState().stage === "downloading" || appUpdateState().stage === "installing") {
    sendJson(res, 409, { ok: false, error: "an update is already in progress" });
    return;
  }
  let file: ReleaseFile | undefined;
  let latest: string | null = null;
  let current: string | null = null;
  try {
    // Read the manifest DIRECTLY rather than through `checkForAppUpdate`: that
    // helper omits the file list when the installed version is already current,
    // which would make an already-up-to-date machine report "no such artifact"
    // instead of the real reason.
    const manifest = await fetchReleaseManifest(channel as ReleaseChannel);
    latest = manifest.version;
    const appPath = appBundlePath();
    current = appPath ? await installedAppVersion(appPath) : null;
    const match = (manifest.files ?? []).find((f) => f.url === url);
    if (!match) {
      sendError(res, 409, "that artifact is not in the current release manifest");
      return;
    }
    if (!match.sha512) {
      // A manifest entry with no checksum cannot be verified; refuse rather than
      // downloading an unverifiable binary into the install path.
      sendError(res, 409, "the release manifest lists no checksum for that artifact");
      return;
    }
    file = match;
  } catch (error) {
    sendError(res, 502, `could not read the release manifest: ${messageOf(error)}`);
    return;
  }
  // The manifest is the authority on what is current, so a request for anything
  // else is refused instead of silently downgrading the installed app.
  if (file === undefined || latest === null || version !== latest) {
    sendError(res, 409, `latest ${channel} version is ${latest ?? "unknown"}, not ${version}`);
    return;
  }
  if (current !== null && !isNewerVersion(latest, current)) {
    sendJson(res, 409, { ok: false, error: `version ${latest} is not newer than ${current}` });
    return;
  }
  // Do not await: a 250 MB download must not hold the request open.
  void startAppUpdate(file, version, { channel: channel as ReleaseChannel });
  sendJson(res, 202, { ok: true, install: appUpdateState() });
}

/** Test seam: drop the install state so a suite starts from a known one. */
export function resetAppUpdateStateForTest(): void {
  resetAppUpdateForTest();
}
