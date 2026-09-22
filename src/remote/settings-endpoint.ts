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
 * actionable, so they are passed through as `error` rather than re-coded. Only
 * the validation failures that indicate a malformed request get a 400;
 * everything else is a 500, because it means the environment is wrong.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map a module error to a status code. */
function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/is not valid JSON|not a JSON object|refusing to write|could not be read/u.test(message)) {
    // The environment is broken (a damaged config file) — not the client's fault.
    return 500;
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

  // ---- reads ----
  if (method === "GET") {
    if (path === "/settings/all") return void (await handleAll(res));
    if (path === "/settings/models") return void (await handleModels(res));
    if (path === "/settings/skills") return void (await handleSkills(res));
    if (path === "/settings/mcp") return void (await handleMcp(res));
    if (path === "/settings/hooks") return void (await handleHooks(res));
    if (path === "/settings/agents") return void (await handleAgents(res));
    if (path === "/settings/backups") return void (await handleBackups(res));
    if (path === "/settings/usage") return void (await handleUsage(res, url));
    if (path === "/settings/quota") return void (await handleQuota(res));
    if (path === "/settings/reset-cards") return void (await handleResetCards(res, url));
    if (path === "/settings/pending-restart") return void (await handlePendingRestart(res));
    if (path === "/settings/app-update") return void (await handleAppUpdate(res, url));
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
      const id = decodeURIComponent(path.slice("/settings/providers/".length));
      return void (await handleUpdateProvider(res, id, body));
    }
    if (method === "POST" && path === "/settings/models") {
      return void (await handleUpsertModel(res, body));
    }
    if (method === "DELETE" && path.startsWith("/settings/models/")) {
      const rest = path.slice("/settings/models/".length);
      const sep = rest.indexOf("/");
      if (sep <= 0) return sendError(res, 400, "expected /settings/models/{providerId}/{modelId}");
      const providerId = decodeURIComponent(rest.slice(0, sep));
      const modelId = decodeURIComponent(rest.slice(sep + 1));
      return void (await handleRemoveModel(res, providerId, modelId));
    }
    if (method === "POST" && path === "/settings/skills/enable") {
      return void (await handleSkillEnable(res, body));
    }
    if (method === "POST" && path === "/settings/skills/copy-to-user") {
      return void (await handleSkillCopy(res, body));
    }
    if (method === "DELETE" && path.startsWith("/settings/skills/")) {
      const skillPath = decodeURIComponent(path.slice("/settings/skills/".length));
      return void (await handleSkillDelete(res, skillPath));
    }
    if (method === "PUT" && path.startsWith("/settings/mcp/")) {
      const name = decodeURIComponent(path.slice("/settings/mcp/".length));
      return void (await handleMcpUpsert(res, name, body));
    }
    if (method === "DELETE" && path.startsWith("/settings/mcp/")) {
      const name = decodeURIComponent(path.slice("/settings/mcp/".length));
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
      const name = decodeURIComponent(path.slice("/settings/agents/".length, -"/enable".length));
      return void (await handleAgentEnable(res, name, body));
    }
    if (method === "PUT" && path.startsWith("/settings/agents/")) {
      const name = decodeURIComponent(path.slice("/settings/agents/".length));
      return void (await handleAgentUpsert(res, name, body));
    }
    if (method === "DELETE" && path.startsWith("/settings/agents/")) {
      const name = decodeURIComponent(path.slice("/settings/agents/".length));
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

async function handlePendingRestart(res: ServerResponse): Promise<void> {
  await guard(res, async () => ({
    ok: true as const,
    pendingRestart: pendingRestartWrites > 0,
    writes: pendingRestartWrites,
  }));
}

// ---------- reads ----------

async function handleAll(res: ServerResponse): Promise<void> {
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
  sendJson(res, 200, { ok: true, models, skills, mcp, hooks, agents, usage, resetCards });
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
    sendError(res, 400, "expected /settings/hooks/{event}/{matcherIndex}/{hookIndex}");
    return;
  }
  const event = decodeURIComponent(parts[0]!) as HookEventName;
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
  if (!consumeNonce(providerId, nonce)) {
    sendError(res, 409, "nonce is stale — refresh the reset card status and try again");
    return;
  }
  await guard(res, async () => {
    const result = await useResetCard(providerId, resetType as ResetType, idempotencyKey);
    return { ok: true as const, ...result };
  });
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
 */
const issuedNonces = new Map<string, string>();

/** Record the nonce a status read just issued. */
export function rememberResetNonce(providerId: string, nonce: string): void {
  issuedNonces.set(providerId, nonce);
}

/** Validate and burn a nonce. False when it is missing, stale, or reused. */
function consumeNonce(providerId: string, nonce: string): boolean {
  if (issuedNonces.get(providerId) !== nonce) return false;
  issuedNonces.delete(providerId);
  return true;
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
  try {
    await server.backend?.close();
  } catch (error) {
    warn(
      `settings: backend restart close failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The respawned backend reads MCP servers, hooks and subagent markdown at
  // startup, so everything this process was waiting on is now applied.
  pendingRestartWrites = 0;
  sendJson(res, 200, { ok: true, cancelledTurns: cancelled });
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
