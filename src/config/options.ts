/**
 * configOptions + modes construction and session/set_config_option dispatch.
 *
 * Reads `session/read` `settings.*` for current values (NOT projection.mode,
 * which is a zombie value), with config.json fallbacks for the model list.
 * set_config_option: mode/thought forward to setMode/setThoughtLevel; model
 * routes through `runtimeModel` (runtime-model.ts) because the backend rejects
 * the persistence path. After a change, re-builds the option and emits a
 * `config_option_update` (+ `current_mode_update` for mode) so the editor UI
 * reflects the new state.
 */

import { readFileSync } from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";

import type { ZcodeReadResult } from "../backend/types.js";
import { recordModelChoice } from "../lazy-sessions.js";
import {
  clientConnectionRoot,
  CONFIG_DISPATCH,
  CONFIG_META,
  log,
  warn,
  ZCODE_CREDS_PATH,
  zcodePersonalProviderPath,
} from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";
import { configProviderIdFor } from "./account-provider.js";
import { isBroadcastSource, sendSessionUpdate, sendSessionUpdateToOthers } from "../handlers/io.js";

interface ProviderModelsJson {
  [modelId: string]: { limit?: { context?: number } } | undefined;
}

/** Read the config.json contents (UTF-8). Throws on read/parse failure. */
function readConfig(): unknown {
  return JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8"));
}

/** A single provider's entry in config.json (`provider.<providerId>`). */
interface ProviderEntry {
  name?: string;
  kind?: string;
  enabled?: boolean;
  options?: { baseURL?: string; apiKey?: string; apiKeyRequired?: boolean };
  models?: ProviderModelsJson;
}

interface ConfigShape {
  provider?: Record<string, ProviderEntry>;
}

// ---------- personal provider config (3.12+) ----------

/**
 * The desktop's `provider_config.json` — where user-added providers and models
 * land since 3.12. config.json's provider map is legacy and has stopped
 * syncing (observed 2026-09: a model added in the desktop app was written ONLY
 * here, so a dropdown built from config.json alone never showed it; the
 * backend registry reads this file directly and accepts the model fine).
 *
 * Spelling notes: provider rule ids use the REGISTRY spelling
 * (`account:bigmodel-individual-coding-plan`), so they normalize through
 * `configProviderIdFor` before matching config.json's `builtin:*` keys. Model
 * rules nest their flag under `config.enabled` (NOT top-level), and carry
 * `config.properties.contextWindow` + `config.optionSpecs.reasoningLevel.values`.
 */
interface PersonalModelRule {
  providerId?: string;
  modelId?: string;
  config?: {
    enabled?: boolean;
    properties?: { contextWindow?: number };
    optionSpecs?: { reasoningLevel?: { values?: string[] } };
  };
}

interface PersonalProviderRule {
  providerId?: string;
  providerName?: string;
  enabled?: boolean;
  config?: {
    access?: { type?: string; apiKey?: string };
    api?: { type?: string; baseUrl?: string };
  };
}

interface PersonalProviderConfig {
  config?: {
    providerConfigRules?: { providerRules?: PersonalProviderRule[] };
    modelConfigRules?: {
      providerModelRules?: PersonalModelRule[];
      manualProviderModelRules?: PersonalModelRule[];
    };
  };
}

/** provider_config.json content projected onto config.json spellings. */
interface PersonalModels {
  /** enabled model ids per NORMALIZED provider id, file order. */
  modelsByProvider: Map<string, string[]>;
  /** context window per `providerId\modelId` (formatModelValue separator). */
  contextByModel: Map<string, number>;
  /** reasoning level values per `providerId\modelId`, file order. */
  reasoningByModel: Map<string, string[]>;
  /** every provider rule, normalized id attached, file order. */
  providers: Array<{ pid: string; rule: PersonalProviderRule }>;
}

function readPersonalProviderConfig(): PersonalProviderConfig | null {
  try {
    return JSON.parse(readFileSync(zcodePersonalProviderPath(), "utf8")) as PersonalProviderConfig;
  } catch {
    return null; // absent/unreadable (or pre-3.12 desktop) — config.json alone decides
  }
}

function loadPersonalModels(): PersonalModels | null {
  const pc = readPersonalProviderConfig();
  const providerRules = pc?.config?.providerConfigRules?.providerRules ?? [];
  const modelRules = [
    ...(pc?.config?.modelConfigRules?.providerModelRules ?? []),
    ...(pc?.config?.modelConfigRules?.manualProviderModelRules ?? []),
  ];
  if (providerRules.length === 0 && modelRules.length === 0) return null;
  const out: PersonalModels = {
    modelsByProvider: new Map(),
    contextByModel: new Map(),
    reasoningByModel: new Map(),
    providers: [],
  };
  for (const rule of modelRules) {
    if (!rule.providerId || !rule.modelId) continue;
    if (rule.config?.enabled === false) continue;
    const pid = configProviderIdFor(rule.providerId);
    const ids = out.modelsByProvider.get(pid) ?? [];
    if (!ids.includes(rule.modelId)) ids.push(rule.modelId);
    out.modelsByProvider.set(pid, ids);
    const key = `${pid}\\${rule.modelId}`;
    const ctx = rule.config?.properties?.contextWindow;
    if (ctx && ctx > 0) out.contextByModel.set(key, ctx);
    const values = rule.config?.optionSpecs?.reasoningLevel?.values;
    if (values?.length) out.reasoningByModel.set(key, values);
  }
  for (const rule of providerRules) {
    if (!rule.providerId) continue;
    out.providers.push({ pid: configProviderIdFor(rule.providerId), rule });
  }
  return out;
}

/**
 * A model's declaration from provider_config.json only — the lookup for
 * models that exist in the desktop's personal config but not (yet) in legacy
 * config.json. Null when the personal config is absent or lacks the model.
 */
export function personalModelSpec(
  providerId: string,
  modelId: string,
): { contextWindow?: number; reasoningValues?: string[] } | null {
  const personal = loadPersonalModels();
  if (!personal) return null;
  const pid = configProviderIdFor(providerId);
  const key = `${pid}\\${modelId}`;
  const contextWindow = personal.contextByModel.get(key);
  const reasoningValues = personal.reasoningByModel.get(key);
  if (contextWindow === undefined && !reasoningValues) return null;
  return { contextWindow, reasoningValues };
}

/**
 * Fallback defaults for when config.json is unreadable or has no enabled
 * provider — keeps a freshly-installed editor functional. Must stay in sync
 * with the model the app ships first in its provider list.
 */
export const DEFAULT_PROVIDER_ID = "builtin:bigmodel-coding-plan";
export const DEFAULT_PROVIDER_NAME = "BigModel";
export const DEFAULT_MODEL_ID = "GLM-5.3";

/** A model selectable in the dropdown, with its owning provider. */
export interface ModelRef {
  providerId: string;
  providerName: string;
  modelId: string;
}

/**
 * Whether a provider entry is selectable in the dropdown — i.e. the desktop
 * app itself would run it. The desktop marks a provider "未启用" when it has
 * no usable credentials, and the IDE dropdown must not offer those models
 * (issue #156): a keyless builtin (API-key mode picked but no key entered) or
 * a keyless remote custom provider can never authenticate.
 *
 *   - builtin: requires `enabled: true` AND a credential (plan token / key).
 *   - custom: excluded on explicit `enabled: false`; otherwise must be
 *     usable — has an apiKey, declares keys not required, or points at a
 *     local baseURL (llama.cpp/ollama-style providers work keyless).
 */
export function providerSelectable(pid: string, p: ProviderEntry | undefined): boolean {
  if (!p) return false;
  if (isBuiltinProvider(pid)) return p.enabled === true && Boolean(p.options?.apiKey);
  if (p.enabled === false) return false;
  if (p.options?.apiKey) return true;
  if (p.options?.apiKeyRequired === false) return true;
  return isLocalBaseURL(p.options?.baseURL);
}

/** localhost-style baseURL (llama.cpp / Ollama / LM Studio run keyless). */
function isLocalBaseURL(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Append providers that exist ONLY in provider_config.json — added in the
 * desktop app after config.json stopped syncing. Credentials come from the
 * rule itself (`config.access.apiKey` / `config.api.baseUrl`), selectability
 * follows the same rule as config.json entries (#156).
 */
function appendPersonalOnlyProviders(
  out: ModelRef[],
  personal: PersonalModels,
  pinned: string | undefined,
): void {
  const known = new Set(out.map((m) => m.providerId));
  for (const { pid, rule } of personal.providers) {
    if (known.has(pid)) continue;
    if (pinned && pid !== pinned) continue;
    const synthesized: ProviderEntry = {
      name: rule.providerName,
      enabled: rule.enabled,
      options: {
        apiKey: rule.config?.access?.apiKey,
        baseURL: rule.config?.api?.baseUrl,
      },
    };
    if (!providerSelectable(pid, synthesized)) continue;
    const providerName = rule.providerName ?? pid;
    for (const modelId of personal.modelsByProvider.get(pid) ?? []) {
      out.push({ providerId: pid, providerName, modelId });
    }
  }
}

/**
 * Collect models from config.json for the dropdown, UNIONED with the desktop's
 * provider_config.json (3.12+): models the user added in the desktop app land
 * there and never reach legacy config.json, so without the merge the dropdown
 * silently misses them (observed 2026-09). config.json stays authoritative for
 * provider enablement/credentials; the personal config contributes model ids
 * per provider, plus whole providers it describes and config.json does not.
 */
export function loadAllModels(): ModelRef[] {
  const personal = loadPersonalModels();
  try {
    const cfg = readConfig() as ConfigShape;
    const out: ModelRef[] = [];
    // ZCODE_PROVIDER pins the dropdown to one provider id.
    const pinned = process.env.ZCODE_PROVIDER;
    for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
      if (pinned && pid !== pinned) continue;
      if (!providerSelectable(pid, p)) continue;
      const providerName = p.name ?? pid;
      const ids = new Set(Object.keys(p.models ?? {}));
      for (const modelId of personal?.modelsByProvider.get(pid) ?? []) ids.add(modelId);
      for (const modelId of ids) {
        out.push({ providerId: pid, providerName, modelId });
      }
    }
    if (personal) appendPersonalOnlyProviders(out, personal, pinned);
    // The default-provider fallback applies only to a MISSING/empty provider
    // map (fresh install). When providers ARE configured but none is usable
    // (all keyless/未启用, #156), returning [] is correct: the fallback would
    // re-advertise exactly the unusable provider — or one absent from the
    // user's config — and switching to it fails in applyModelSwitch.
    if (out.length === 0 && Object.keys(cfg.provider ?? {}).length === 0) {
      return [
        {
          providerId: DEFAULT_PROVIDER_ID,
          providerName: DEFAULT_PROVIDER_NAME,
          modelId: DEFAULT_MODEL_ID,
        },
      ];
    }
    return out;
  } catch {
    // config.json unreadable — a personal-config-only setup still advertises
    // its providers before the fresh-install default kicks in.
    const out: ModelRef[] = [];
    if (personal) appendPersonalOnlyProviders(out, personal, process.env.ZCODE_PROVIDER);
    if (out.length > 0) return out;
    return [
      {
        providerId: DEFAULT_PROVIDER_ID,
        providerName: DEFAULT_PROVIDER_NAME,
        modelId: DEFAULT_MODEL_ID,
      },
    ];
  }
}

/** Look up a provider entry by id (any provider, not just enabled).
 *
 *  3.12+ registries spell coding-plan providers `account:<family>-<plan>` while
 *  config.json keeps the legacy `builtin:<family>-<plan>` — normalize before
 *  lookup so both spellings resolve. */
export function findProviderConfig(providerId: string): ProviderEntry | null {
  try {
    const cfg = readConfig() as ConfigShape;
    return cfg.provider?.[providerId] ?? cfg.provider?.[configProviderIdFor(providerId)] ?? null;
  } catch {
    return null;
  }
}

/** Read the context-window size for a provider+model: config.json first, then
 *  the desktop's provider_config.json (models added there carry
 *  `config.properties.contextWindow` and never reach config.json). */
export function modelContextWindow(providerId: string, modelId: string): number {
  const pid = configProviderIdFor(providerId);
  try {
    const cfg = readConfig() as ConfigShape;
    const models = cfg.provider?.[pid]?.models ?? {};
    const hit = models[modelId]?.limit?.context;
    if (hit && hit > 0) return hit;
  } catch {
    // fall through to the personal config
  }
  return personalModelSpec(pid, modelId)?.contextWindow ?? 0;
}

/** Builtin providerIds are prefixed with `builtin:` (e.g. `builtin:bigmodel`). */
export function isBuiltinProvider(providerId: string): boolean {
  return providerId.startsWith("builtin:");
}

/**
 * Encode a provider+model pair into a configOption `value` string.
 *
 * Always `providerId\modelId` — builtins included. A collision-only prefix
 * would advertise different id shapes depending on how many coding plans the
 * user has enabled. `\` is unambiguous because providerIds (UUIDs / builtin:
 * slugs) and modelIds (`/`-separated) never contain it.
 *
 * Inbound, `parseModelValue` still accepts a legacy bare modelId.
 */
export function formatModelValue(providerId: string, modelId: string): string {
  return `${providerId}\\${modelId}`;
}

function collidingModelIds(models: ModelRef[]): Set<string> {
  const counts = new Map<string, number>();
  for (const model of models) {
    counts.set(model.modelId, (counts.get(model.modelId) ?? 0) + 1);
  }
  const colliding = new Set<string>();
  for (const [modelId, count] of counts) {
    if (count > 1) colliding.add(modelId);
  }
  return colliding;
}

function buildModelSelectOptions(models: ModelRef[]): Array<{ value: string; name: string }> {
  const collidingIds = collidingModelIds(models);
  const options: Array<{ value: string; name: string }> = [];
  const seen = new Set<string>();
  for (const model of models) {
    const value = formatModelValue(model.providerId, model.modelId);
    if (seen.has(value)) continue;
    seen.add(value);
    const qualify = collidingIds.has(model.modelId) || !isBuiltinProvider(model.providerId);
    options.push({
      value,
      name: qualify ? `${model.providerName} › ${model.modelId}` : model.modelId,
    });
  }
  return options;
}

/**
 * Parse a configOption `value` back into { providerId, modelId }.
 *
 * A value without `\` is a legacy bare modelId → resolve to the first enabled
 * builtin provider. A value with `\` is the current provider+model encoding.
 */
export function parseModelValue(value: string): { providerId: string; modelId: string } {
  // New-format (3.12+) agent-definition spelling: `custom:<urlencoded
  // providerId>:<modelId>` — e.g. custom:account%3Abigmodel-individual-coding-plan:GLM-5.3
  // (the provider id's colons are percent-encoded, so `[^:]+` splits cleanly).
  const custom = /^custom:([^:]+):(.+)$/.exec(value);
  if (custom) {
    try {
      return { providerId: decodeURIComponent(custom[1]!), modelId: custom[2]! };
    } catch {
      // malformed encoding — fall through to the legacy spellings
    }
  }
  const idx = value.indexOf("\\");
  if (idx < 0) {
    // Builtin plain modelId — resolve to the first enabled builtin provider
    // (falling back to the legacy default if none configured).
    const firstBuiltin = loadAllModels().find((m) => isBuiltinProvider(m.providerId));
    return {
      providerId: firstBuiltin?.providerId ?? DEFAULT_PROVIDER_ID,
      modelId: value,
    };
  }
  return { providerId: value.slice(0, idx), modelId: value.slice(idx + 1) };
}

/** Build the ACP SessionModeState ({currentModeId, availableModes}).
 *  zcodeSid null = pending session (session/new not yet materialized) — skip
 *  the backend read and return defaults. */
export async function buildModes(
  server: ZcodeAcpServer,
  zcodeSid: string | null,
): Promise<acp.SessionModeState> {
  let currentMode = "yolo";
  if (zcodeSid !== null) {
    try {
      const read = await sessionRead(server, zcodeSid);
      const settings = (read.settings ?? {}) as Record<string, unknown>;
      const modeSet = (settings.mode as Record<string, unknown>) ?? {};
      currentMode = (modeSet.current as string) ?? currentMode;
    } catch {
      // keep default
    }
  }
  return {
    currentModeId: currentMode,
    // ZCode 3.3.0 mode enum: plan/build/edit/yolo/auto. settings.mode only
    // carries `current` (no `available` list, unlike thoughtLevel), so the full
    // enum is advertised here.
    availableModes: ["plan", "build", "edit", "yolo", "auto"].map((m) => ({
      id: m,
      name: capitalize(m),
    })),
  };
}

/**
 * Canonical display order for thought-level tokens across models
 * (GLM-5.3: low/high/max; GLM-5-Turbo: enabled/off; others may differ).
 * Unknown tokens keep their config order after the known ones.
 */
const THOUGHT_ORDER = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "enabled",
  "disabled",
  "off",
];

export function orderThoughtVariants(variants: string[]): Array<{ value: string; name: string }> {
  const known = THOUGHT_ORDER.filter((t) => variants.includes(t));
  const extra = variants.filter((t) => !THOUGHT_ORDER.includes(t));
  return [...known, ...extra].map((t) => ({ value: t, name: t }));
}

/** Build the ACP configOptions array (3 items: model/mode/thought).
 *  zcodeSid null = pending session — skip the backend read and use defaults;
 *  mode defaults to "yolo" (the mode session/create hardcodes) so the dropdown
 *  matches the mode indicator for a fresh session.
 *  `receiverRoot` is the clientConnectionRoot of the client the array is
 *  delivered to — the quota pseudo-option is appended only for martty
 *  connections (ADR-0021); other receivers get the spec-clean 3 options. */
export async function buildConfigOptions(
  server: ZcodeAcpServer,
  zcodeSid: string | null,
  receiverRoot?: unknown,
): Promise<acp.SessionConfigOption[]> {
  let currentProviderId = "";
  let currentModelId = DEFAULT_MODEL_ID;
  let currentMode = zcodeSid === null ? "yolo" : "build";
  // Matches the enabled provider's default reasoning variants (GLM-5.3:
  // max/high/low, default max). Pending sessions show this until the real
  // session/read thoughtLevel arrives.
  let currentThought = "max";
  let thoughtOptions: Array<{ value: string; name: string }> | null = null;
  if (zcodeSid === null) {
    // Pending session — no backend to read yet, but the thought vocabulary
    // is per model and the runtime's own source of truth is the enabled
    // provider's models[].reasoning.variants in the local config. Advertise
    // THAT for the default model instead of a hardcoded list: a client that
    // relays the options into a picker (Multica's effort selector) would
    // otherwise offer tokens the runtime rejects ("nothink" was fiction,
    // "low" was missing).
    const cur = loadAllModels()[0];
    if (cur) {
      // The advertised current model follows the dropdown's leading entry
      // (the enabled provider's first model — what the runtime actually
      // starts sessions with) rather than the legacy hardcoded "GLM-5.2".
      // ACP clients skip a requested model switch when it equals the
      // advertised current value, so a stale fiction silently pinned the
      // wrong model whenever the requested id happened to match it.
      currentProviderId = cur.providerId;
      currentModelId = cur.modelId;
      try {
        const cfg = readConfig() as ConfigShape;
        const m = (
          cfg.provider?.[cur.providerId]?.models as
            | Record<
                string,
                { reasoning?: { enabled?: boolean; variants?: string[]; defaultVariant?: string } }
              >
            | undefined
        )?.[cur.modelId];
        const reasoning = m?.reasoning;
        const variants = reasoning?.variants;
        if (reasoning?.enabled !== false && variants && variants.length > 0) {
          thoughtOptions = orderThoughtVariants(variants);
          currentThought = reasoning.defaultVariant ?? variants[0];
        }
      } catch {
        // unreadable config — the static fallback below applies
      }
    }
  }

  if (zcodeSid !== null) {
    try {
      const read = await sessionRead(server, zcodeSid);
      const settings = (read.settings ?? {}) as Record<string, unknown>;
      const modeSet = (settings.mode as Record<string, unknown>) ?? {};
      currentMode = (modeSet.current as string) ?? currentMode;
      const modelSet = (settings.model as Record<string, unknown>) ?? {};
      // settings.model.current is { providerId, modelId, variant? } — read BOTH so
      // we can disambiguate same-named models across providers. Normalize the
      // provider spelling (3.12+ registries answer `account:<family>-<plan>`;
      // config.json and the dropdown use `builtin:<family>-<plan>`) so the
      // current value matches a dropdown entry instead of duplicating it.
      const cur = (modelSet.current as { providerId?: string; modelId?: string }) ?? {};
      if (cur.providerId) currentProviderId = configProviderIdFor(cur.providerId);
      if (cur.modelId) currentModelId = cur.modelId;
      const tlSet = (settings.thoughtLevel as Record<string, unknown>) ?? {};
      // `current` is absent right after session/create — fall back to the
      // backend's defaultLevel (the level the session actually runs at).
      currentThought =
        (tlSet.current as string) ?? (tlSet.defaultLevel as string) ?? currentThought;
      const tlAvail = (tlSet.available as Array<Record<string, string>>) ?? [];
      if (tlAvail.length > 0) {
        thoughtOptions = tlAvail.map((a) => ({ value: a.value, name: a.label ?? a.value }));
      }
    } catch {
      // keep defaults
    }
  }

  // currentValue encodes provider+model so the switch handler can locate the
  // right provider (and its apiKey). Fall back to the first enabled provider
  // when settings omits providerId (legacy sessions).
  const allModels = loadAllModels();
  const currentProvider = currentProviderId || allModels[0]?.providerId || DEFAULT_PROVIDER_ID;
  const currentModel = formatModelValue(currentProvider, currentModelId);

  // Model options: config.json enabled providers are authoritative. Values
  // are always providerId\modelId. Builtin labels stay the bare modelId
  // unless two providers ship the same id; third-party labels always qualify.
  let modelOptions = buildModelSelectOptions(allModels);
  if (!modelOptions.some((o) => o.value === currentModel)) {
    // The current model isn't from an enabled provider (e.g. the session was
    // created with a now-disabled provider). Append it so the dropdown still
    // shows the active selection.
    modelOptions = [{ value: currentModel, name: currentModelId }, ...modelOptions];
  }
  if (!thoughtOptions) thoughtOptions = [...CONFIG_META.thought.options];

  const options: acp.SessionConfigOption[] = [
    {
      id: "model",
      name: CONFIG_META.model.name,
      category: "model" as acp.SessionConfigOptionCategory,
      type: "select",
      currentValue: currentModel,
      options: modelOptions,
    },
    {
      id: "mode",
      name: CONFIG_META.mode.name,
      category: "mode" as acp.SessionConfigOptionCategory,
      type: "select",
      currentValue: currentMode,
      options: [...CONFIG_META.mode.options],
    },
    {
      id: "thought",
      name: CONFIG_META.thought.name,
      // Category thought_level (not "thought") so ACP clients recognise the
      // option as the reasoning-effort selector: the shared matchers in
      // editors and orchestrators (e.g. Multica's acpEffortOptionIDs) key on
      // id/category "effort"/"thought_level". The id stays "thought" — it is
      // what session/set_config_option addresses.
      category: "thought_level" as acp.SessionConfigOptionCategory,
      type: "select",
      currentValue: currentThought,
      options: thoughtOptions,
    },
  ];

  // Read-only quota pseudo-option (ADR-0021): martty-only, no category (never
  // lands in a settings menu), string type per the probe-verified shape — the
  // SDK's union stops at select/boolean, so the cast carries the agent-owned
  // extension through typecheck. `set_config_option` on it is a no-op.
  // Gated on the RECEIVER's connection identity, not process state — a
  // non-martty client must never see the spec-external string option.
  if (
    server.quotaDock &&
    receiverRoot !== undefined &&
    server.marttyConnectionRoots.has(receiverRoot)
  ) {
    options.push({
      id: "quota",
      name: "GLM Coding Plan quota",
      title: "GLM Coding Plan quota",
      type: "string",
      currentValue: server.quotaDock,
    } as unknown as acp.SessionConfigOption);
  }
  return options;
}

/**
 * Dispatch session/set_config_option. mode/thought forward to setMode/
 * setThoughtLevel; model routes through applyModelSwitch (runtime-model.ts).
 *
 * Returns `{ kind, currentValue, options }` so the caller can emit the update
 * notifications, or null when the configId is unknown / model switch fails.
 */
export async function setConfigOption(
  server: ZcodeAcpServer,
  zcodeSid: string,
  configId: string,
  value: string,
  acpSid?: string,
): Promise<{ kind: "model" | "mode" | "thought"; currentValue: string } | null> {
  if (configId === "model") {
    const { applyModelSwitch } = await import("./runtime-model.js");
    const ok = await applyModelSwitch(server, zcodeSid, value);
    if (!ok) return null;
    rememberModelChoice(server, acpSid, zcodeSid, { model: value });
    return { kind: "model", currentValue: value };
  }
  const dispatch = CONFIG_DISPATCH[configId];
  if (!dispatch) return null;
  const backend = server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    dispatch.method,
    { sessionId: zcodeSid, [dispatch.paramKey]: value },
    15000,
  );
  if (resp.error) return null;
  if (configId === "thought") {
    rememberModelChoice(server, acpSid, zcodeSid, { thought: value });
  }
  return { kind: configId as "mode" | "thought", currentValue: value };
}

/**
 * Record the session's model/thought choice: in-memory per zcodeSid (read by
 * the post-resume re-assert) and durably per acpSid in the lazy-alias store
 * (read back after a bridge restart). See LazySessionRecord.modelChoice for
 * why the backend's own persistence cannot be trusted here.
 */
export function rememberModelChoice(
  server: ZcodeAcpServer,
  acpSid: string | undefined,
  zcodeSid: string,
  patch: { model?: string; thought?: string },
): void {
  // `at` arbitrates multi-alias recovery (newer-wins in ensureRealSession):
  // two windows can hold records for the SAME backend session, and a stale
  // store record must not overwrite a fresher in-memory choice on re-seed.
  const at = Date.now();
  server.sessionModelChoices.set(zcodeSid, {
    ...server.sessionModelChoices.get(zcodeSid),
    ...patch,
    at,
  });
  if (acpSid) recordModelChoice(acpSid, { ...patch, at });
}

/** Emit a config_option_update (+ current_mode_update for mode) after a change.
 *  Returns the rebuilt options (+ the advertised currentModeId for mode) so the
 *  caller can include them in the response / mirror lastMode.
 *
 *  Every payload reaches EVERY attached client (the CLI window when the switch
 *  came from the phone, and vice versa) — a settings change is per-session
 *  state, not per-connection. Two shapes: a broadcast-proxy cx fans out to all
 *  clients by itself, so the update is sent once PER SESSION ALIAS through it
 *  (clients route by payload sessionId and drop ids they don't hold — a
 *  client holding the conversation under another acpSid must still receive
 *  it); a real per-connection cx sends to the initiator and then the rest via
 *  sendSessionUpdateToOthers (which loops the aliases for the others). No
 *  "others" leg on the proxy: it has no connectionContext to exclude anyone
 *  by, so the leg would double-deliver.
 *
 *  Sends are best-effort: a dead initiator connection must not skip the
 *  broadcast or fail the handler — the switch already succeeded backend-side.
 *
 *  For model switches, also emit a usage_update with the NEW model's context
 *  window (from config.json) so the editor's context bar refreshes immediately
 *  instead of waiting for the next turn's UsageDelta. */
export async function emitConfigOptionUpdate(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  kind: "model" | "mode" | "thought",
): Promise<{ options: acp.SessionConfigOption[]; currentModeId?: string }> {
  const options = await buildConfigOptions(server, zcodeSid, clientConnectionRoot(cx));
  const broadcastSource = isBroadcastSource(cx);
  const send = (update: acp.SessionUpdate): Promise<void> => {
    if (broadcastSource) {
      return Promise.all(
        server.sessionAliases(acpSid).map((sid) => sendSessionUpdate(cx, sid, update)),
      ).then(() => undefined);
    }
    return sendSessionUpdate(cx, acpSid, update)
      .then(() => sendSessionUpdateToOthers(server, cx, acpSid, update))
      .catch((e: unknown) => {
        warn(
          `options: config update send failed (sid=${acpSid}): ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  };
  const configUpdate: acp.SessionUpdate = {
    sessionUpdate: "config_option_update",
    configOptions: options,
  };
  await send(configUpdate);
  let currentModeId: string | undefined;
  if (kind === "mode") {
    const modes = await buildModes(server, zcodeSid);
    currentModeId = modes.currentModeId;
    await send({
      sessionUpdate: "current_mode_update",
      currentModeId: modes.currentModeId,
    });
  }
  if (kind === "model") {
    // Refresh the context bar: the backend's projection.contextWindow lags
    // behind a model switch, so read the new model's limit from config.json.
    try {
      const read = await sessionRead(server, zcodeSid);
      const proj = (read.projection ?? {}) as {
        contextUsed?: number;
        totalTokenCount?: number;
      };
      const used = proj.contextUsed || proj.totalTokenCount || 0;
      // The rebuilt options[0] (model) currentValue is the just-switched value.
      const modelOpt = options.find((o) => o.id === "model");
      const { providerId, modelId } = parseModelValue(String(modelOpt?.currentValue ?? ""));
      const size = modelContextWindow(providerId, modelId);
      await send({
        sessionUpdate: "usage_update",
        used,
        size,
      });
    } catch (e) {
      log(
        `options: usage_update after model switch failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
  return { options, ...(currentModeId !== undefined ? { currentModeId } : {}) };
}

// ---------- helpers ----------

async function sessionRead(server: ZcodeAcpServer, zcodeSid: string): Promise<ZcodeReadResult> {
  const backend = server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/read",
    { sessionId: zcodeSid },
    5000,
  );
  if (resp.error) throw new Error(resp.error.message);
  return (resp.result ?? {}) as ZcodeReadResult;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
