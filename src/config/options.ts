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

import { backendCapabilities } from "../backend/adapter.js";
import type { ZcodeCreateResult, ZcodeReadResult } from "../backend/types.js";
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
import { isBroadcastSource, sendSessionUpdate, sendSessionUpdateToOthers } from "../handlers/io.js";
import {
  accountProviderIdFor,
  configProviderIdFor,
  entitledCodingPlanModels,
  readBuiltinTable,
} from "./account-provider.js";
import { readCredentialConfig } from "./bridge-accounts.js";
import { parseModelRefValue } from "./model-resolution.js";
import { registryContextWindow } from "./registry-context-window.js";
import { initialSessionMode } from "./settings.js";
import { isSessionMode, loadUserConfig } from "./user-config.js";

interface ProviderModelsJson {
  [modelId: string]: { limit?: { context?: number } } | undefined;
}

/** Read the config.json contents (UTF-8). Throws on read/parse failure. */
function readConfig(): unknown {
  return readCredentialConfig(ZCODE_CREDS_PATH);
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
  /**
   * Model ids the user switched OFF in the desktop (`config.enabled:false`),
   * per NORMALIZED provider id. The registry drops them; legacy config.json
   * still lists them.
   */
  disabledByProvider: Map<string, Set<string>>;
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
    disabledByProvider: new Map(),
    providers: [],
  };
  for (const rule of modelRules) {
    if (!rule.providerId || !rule.modelId) continue;
    const pid = configProviderIdFor(rule.providerId);
    if (rule.config?.enabled === false) {
      const disabled = out.disabledByProvider.get(pid) ?? new Set<string>();
      disabled.add(rule.modelId);
      out.disabledByProvider.set(pid, disabled);
      continue;
    }
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

/** True when the desktop's provider_config.json explicitly switches this model off. */
function personallyDisabled(
  personal: PersonalModels | null,
  providerId: string,
  modelId: string,
): boolean {
  return personal?.disabledByProvider.get(configProviderIdFor(providerId))?.has(modelId) ?? false;
}

/**
 * Positive evidence that a model is really gone — as opposed to merely absent
 * from a registry list that may still be loading: the user switched it off in
 * the desktop, or no local source (legacy config.json, the personal provider
 * config, the provider table) knows it any more. A model that is merely
 * missing from the backend's list is left alone until the backend itself
 * refuses it (see repairUnavailableModel).
 */
export function modelRetired(providerId: string, modelId: string): boolean {
  const personal = loadPersonalModels();
  if (personallyDisabled(personal, providerId, modelId)) return true;
  const model = modelId.toLowerCase();
  return !loadAllModels().some(
    (m) => sameProvider(m.providerId, providerId) && m.modelId.toLowerCase() === model,
  );
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
  return providerUnselectableReason(pid, p) === null;
}

/**
 * Why a provider entry is NOT selectable (null = selectable) — the reason
 * taxonomy exported to ACP clients as `unselectableReason` in
 * `_meta.zcode.providers` (#400), so a client can render "link account in the
 * desktop app" instead of silently omitting the provider.
 */
export type ProviderUnselectableReason = "disabled" | "keyless-builtin" | "non-local-keyless";

export function providerUnselectableReason(
  pid: string,
  p: ProviderEntry | undefined,
): ProviderUnselectableReason | null {
  if (!p) return "disabled";
  if (isBuiltinProvider(pid)) {
    if (p.enabled !== true) return "disabled";
    if (!p.options?.apiKey) return "keyless-builtin";
    return null;
  }
  if (p.enabled === false) return "disabled";
  if (p.options?.apiKey) return null;
  if (p.options?.apiKeyRequired === false) return null;
  if (isLocalBaseURL(p.options?.baseURL)) return null;
  return "non-local-keyless";
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

/** Synthesize a config.json-shaped provider entry from a personal rule. */
function personalRuleEntry(rule: PersonalProviderRule): ProviderEntry {
  return {
    name: rule.providerName,
    enabled: rule.enabled,
    options: {
      apiKey: rule.config?.access?.apiKey,
      baseURL: rule.config?.api?.baseUrl,
    },
  };
}

/**
 * A config.json entry with the 3.12+ personal rule overlaid — custom
 * providers toggled/updated in the desktop app write their new `enabled` /
 * `apiKey` / `baseUrl` only to provider_config.json, leaving legacy
 * config.json frozen at its pre-3.12 state. Without the overlay a provider
 * disabled in 3.12+ stays selectable via config.json.
 */
function effectiveProviderEntry(
  pid: string,
  p: ProviderEntry | undefined,
  personal: PersonalModels | null,
): ProviderEntry | undefined {
  const personalRule = !isBuiltinProvider(pid)
    ? personal?.providers.find((entry) => entry.pid === pid)?.rule
    : undefined;
  if (!p || !personalRule) return p;
  return {
    ...p,
    name: personalRule.providerName ?? p.name,
    enabled: personalRule.enabled ?? p.enabled,
    options: {
      ...p.options,
      ...(personalRule.config?.access?.apiKey !== undefined
        ? { apiKey: personalRule.config.access.apiKey }
        : {}),
      ...(personalRule.config?.api?.baseUrl !== undefined
        ? { baseURL: personalRule.config.api.baseUrl }
        : {}),
    },
  };
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
    if (!providerSelectable(pid, personalRuleEntry(rule))) continue;
    const providerName = rule.providerName ?? pid;
    for (const modelId of personal.modelsByProvider.get(pid) ?? []) {
      out.push({ providerId: pid, providerName, modelId });
    }
  }
}

/**
 * Merge the entitled coding-plan models (the provider table's catalog, via the
 * account entitlement ladder) into the dropdown.
 *
 * For a provider config.json already lists, the table's models are UNIONED in:
 * config.json is a legacy file that stopped syncing, while the table is the
 * catalog the backend registry builds from — and the desktop host refreshes it
 * from the CDN independently of app updates (observed 2026-11-23: revision 47
 * added GLM-5.4; a config.json still naming only GLM-5.3/5.3-Flash kept the
 * new model out of the dropdown while the backend already served it).
 *
 * On 3.12+/3.15+ layouts where entitlement comes from OAuth (`setting.json` +
 * `credentials.json`), the encrypted store (#320), or a manual coding-plan key
 * in `provider_config.json` (#344), the plan's models do not live in
 * `config.json` at all — the table is then the ONLY source that keeps them
 * selectable even when `config.json` still holds legacy entries or
 * `provider_config.json` also defines custom providers.
 */
function appendEntitledCodingPlanModels(
  out: ModelRef[],
  personal: PersonalModels | null,
  pinned: string | undefined,
): void {
  const listed = new Set(out.map((m) => `${m.providerId}\0${m.modelId}`));
  const names = new Map<string, string>();
  for (const m of out) if (!names.has(m.providerId)) names.set(m.providerId, m.providerName);
  const byProvider = new Map<string, { providerName: string; models: Set<string> }>();
  for (const m of entitledCodingPlanModels()) {
    if (pinned && m.providerId !== pinned) continue;
    if (personallyDisabled(personal, m.providerId, m.modelId)) continue;
    let group = byProvider.get(m.providerId);
    if (!group) {
      // A provider config.json already lists keeps ITS display name.
      group = { providerName: names.get(m.providerId) ?? m.providerName, models: new Set() };
      byProvider.set(m.providerId, group);
    }
    group.models.add(m.modelId);
  }
  for (const [pid, group] of byProvider) {
    for (const extra of personal?.modelsByProvider.get(pid) ?? []) group.models.add(extra);
    for (const modelId of group.models) {
      const key = `${pid}\0${modelId}`;
      if (listed.has(key)) continue;
      listed.add(key);
      out.push({ providerId: pid, providerName: group.providerName, modelId });
    }
  }
}

/**
 * Collect models from config.json for the dropdown, UNIONED with the desktop's
 * provider_config.json (3.12+): models the user added in the desktop app land
 * there and never reach legacy config.json, so without the merge the dropdown
 * silently misses them (observed 2026-09). config.json stays authoritative for
 * provider enablement/credentials unless overridden by a custom provider's
 * rule in provider_config.json (3.12+ writes custom provider toggles there,
 * never back to config.json); the personal config contributes model ids per
 * provider, plus whole providers it describes and config.json does not.
 */
export function loadAllModels(): ModelRef[] {
  const personal = loadPersonalModels();
  const pinned = process.env.ZCODE_PROVIDER;
  try {
    const cfg = readConfig() as ConfigShape;
    const out: ModelRef[] = [];
    // ZCODE_PROVIDER pins the dropdown to one provider id.
    for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
      if (pinned && pid !== pinned) continue;
      const effective = effectiveProviderEntry(pid, p, personal);
      if (!providerSelectable(pid, effective)) continue;
      const providerName = effective?.name ?? pid;
      // Custom providers: once the personal config tracks the provider's
      // models, THAT list is authoritative. Additions AND deletions land only
      // there (config.json stopped syncing), and the backend registry knows no
      // other source for the provider's models — a config.json-only entry is a
      // deleted-model ghost that fails on switch (observed 2026-09-28). Builtin
      // providers keep the union: their catalog comes from the account
      // snapshot, and a personal rule is an override, not a complete list.
      const personalIds = personal?.modelsByProvider.get(pid);
      const ids =
        personalIds !== undefined && !isBuiltinProvider(pid)
          ? new Set(personalIds)
          : new Set([...Object.keys(p.models ?? {}), ...(personalIds ?? [])]);
      for (const modelId of ids) {
        // A model the user switched off in the desktop is gone from the
        // backend registry; legacy config.json keeps naming it, and listing
        // it offered a choice every switch to which failed.
        if (personallyDisabled(personal, pid, modelId)) continue;
        out.push({ providerId: pid, providerName, modelId });
      }
    }
    appendEntitledCodingPlanModels(out, personal, pinned);
    if (personal) appendPersonalOnlyProviders(out, personal, pinned);
    // The default-provider fallback applies only to a MISSING/empty provider
    // map (fresh install). When providers ARE configured but none is usable
    // (all keyless/未启用, #156), returning [] is correct: the fallback would
    // re-advertise exactly the unusable provider — or one absent from the
    // user's config — and switching to it fails in applyModelSwitch.
    if (out.length === 0 && Object.keys(cfg.provider ?? {}).length === 0) {
      return entitledOrDefaultModels(pinned);
    }
    return out;
  } catch {
    // config.json unreadable — a personal-config-only or OAuth setup still
    // advertises its providers before the fresh-install default kicks in.
    const out: ModelRef[] = [];
    appendEntitledCodingPlanModels(out, personal, pinned);
    if (personal) appendPersonalOnlyProviders(out, personal, pinned);
    if (out.length > 0) return out;
    return entitledOrDefaultModels(pinned);
  }
}

/**
 * No usable config.json provider: advertise the coding plans the account
 * ladder entitles (a 3.15+ desktop-only layout), and only then the
 * fresh-install default.
 */
function entitledOrDefaultModels(pinned: string | undefined): ModelRef[] {
  const entitled = entitledCodingPlanModels().filter((m) => !pinned || m.providerId === pinned);
  if (entitled.length > 0) return entitled;
  return [
    {
      providerId: DEFAULT_PROVIDER_ID,
      providerName: DEFAULT_PROVIDER_NAME,
      modelId: DEFAULT_MODEL_ID,
    },
  ];
}

// ---------- default model ----------

/** A model the backend registry can run right now (`server.modelAvailability` entry). */
export interface UsableModel {
  providerId?: string;
  modelId?: string;
}

function sameProvider(a: string, b: string): boolean {
  return a === b || configProviderIdFor(a) === configProviderIdFor(b);
}

/** True when a provider-qualified model is in the usable set (dialect and case folded). */
export function isModelUsable(
  usable: readonly UsableModel[],
  providerId: string,
  modelId: string,
): boolean {
  const model = modelId.toLowerCase();
  return usable.some(
    (e) =>
      e.providerId !== undefined &&
      e.modelId?.toLowerCase() === model &&
      sameProvider(e.providerId, providerId),
  );
}

/** Whether two `providerId\modelId` values name the same model (dialect and case folded). */
export function sameModelValue(a: string, b: string): boolean {
  const pa = parseModelRefValue(a);
  const pb = parseModelRefValue(b);
  return (
    pa.modelId.toLowerCase() === pb.modelId.toLowerCase() &&
    (!pa.providerId || !pb.providerId || sameProvider(pa.providerId, pb.providerId))
  );
}

/**
 * An official ZCode plan (`builtin:` / `account:` provider ids) — a lineup in
 * which "the newest model" is a real successor relation (GLM-5.4 follows
 * GLM-5.3). A third-party provider may mix families in one list, so its
 * version numbers are not comparable and the user's own order stays the rule.
 */
function isOfficialPlan(providerId: string): boolean {
  const id = configProviderIdFor(providerId);
  return isBuiltinProvider(id) || id.startsWith("account:");
}

/**
 * The version a model id advertises, as a numeric chain: "GLM-5.4" → [5, 4],
 * "glm-5-3-flash" → [5, 3], "GLM-5-Turbo" → [5]. The chain stops at the first
 * non-numeric segment and before a date stamp ("GLM-4-Flash-250414" → [4]), so
 * an id without a version ranks below every versioned one.
 */
function modelVersion(modelId: string): number[] {
  const start = modelId.search(/\d/u);
  if (start < 0) return [];
  const chain = /^v?\d+(?:[._-]\d+)*/iu.exec(modelId.slice(start))?.[0];
  if (!chain) return [];
  const out: number[] = [];
  for (const part of chain.split(/[._-]/u)) {
    if (part.length >= 5) break; // a date stamp, not a version
    out.push(Number(part));
  }
  return out;
}

/** Sort order: the newer official model first — version, then fewer variant suffixes. */
function compareLatest(a: ModelRef, b: ModelRef): number {
  const va = modelVersion(a.modelId);
  const vb = modelVersion(b.modelId);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    if (va[i] !== vb[i]) return (vb[i] ?? -1) - (va[i] ?? -1);
  }
  const variantSuffixes = (id: string): number => {
    const start = id.search(/\d/u);
    const rest = start < 0 ? id : id.slice(start).replace(/^v?\d+(?:[._-]\d+)*/iu, "");
    return rest.split(/[^a-z]+/iu).filter(Boolean).length;
  };
  return variantSuffixes(a.modelId) - variantSuffixes(b.modelId);
}

/**
 * One provider's default model: the newest for an official plan, the
 * first-listed everywhere else. `models` must all belong to that provider.
 */
function providerDefault(models: readonly ModelRef[]): ModelRef | undefined {
  const first = models[0];
  if (!first) return undefined;
  return isOfficialPlan(first.providerId) ? [...models].sort(compareLatest)[0] : first;
}

/** The user's manual default (`session.defaultModel` in the user config), when set. */
function configuredDefaultModel(): string | undefined {
  return loadUserConfig().session?.defaultModel?.trim() || undefined;
}

/**
 * The models to try, best first, when a session needs a default — the model a
 * NEW session starts on, and the fallback when a session's own model is no
 * longer runnable. Never a hardcoded id: a new upstream release is the default
 * from the day it is usable, with nothing to change here (observed 2026-11-23:
 * the hardcoded GLM-5.3 was switched off in the desktop on the day GLM-5.4
 * shipped, and every new session tried to start on a model that no longer
 * existed).
 *
 *   1. `ZCODE_PROVIDER` + `ZCODE_MODEL` — the per-process pin.
 *   2. `session.defaultModel` in the user config — the manual choice, in any
 *      spelling `parseModelRefValue` reads (`providerId\modelId`,
 *      `providerId/modelId`, a bare modelId naming exactly one model).
 *   3. `preferProviderId`'s newest model — a session keeps its own plan while
 *      that plan still runs anything (a coding-plan session is never moved to
 *      another plan while its own works).
 *   4. The first provider in the user's own model-list order (the configured
 *      leader — what new sessions always started on), then the registry's
 *      first when no locally-known provider is runnable.
 *
 * The two explicit choices are tried even when the registry list lacks them:
 * that list only names ENABLED models and may be stale (captured at resume) —
 * the backend is the final authority, and a refusal falls through to the next
 * candidate. The automatic choices only ever name models the list vouches for
 * (without a list, the local model list stands in), so a fallback never lands
 * on a model that was switched off.
 */
export function defaultModelCandidates(
  usable?: readonly UsableModel[] | null,
  preferProviderId?: string,
): ModelRef[] {
  const local = loadAllModels();
  const names = providerDisplayNames(local);
  const nameOf = (providerId: string): string =>
    names.get(configProviderIdFor(providerId)) ?? names.get(providerId) ?? providerId;
  const registryListed = Boolean(usable && usable.length > 0);
  const listed: ModelRef[] = registryListed
    ? usable!
        .filter((m) => m.providerId && m.modelId)
        .map((m) => ({
          providerId: m.providerId!,
          providerName: nameOf(m.providerId!),
          modelId: m.modelId!,
        }))
    : local;
  /** Every model of one provider (any dialect) inside a pool. */
  const inPool = (pool: ModelRef[], providerId: string): ModelRef[] =>
    pool.filter((m) => sameProvider(m.providerId, providerId));
  /** An explicit pick as the list spells it, else as the local files do, else as written. */
  const explicit = (providerId: string, modelId: string): ModelRef => {
    const model = modelId.toLowerCase();
    const hit = (pool: ModelRef[]): ModelRef | undefined =>
      pool.find((m) => sameProvider(m.providerId, providerId) && m.modelId.toLowerCase() === model);
    return hit(listed) ?? hit(local) ?? { providerId, providerName: nameOf(providerId), modelId };
  };
  const out: ModelRef[] = [];
  const seen = new Set<string>();
  const push = (ref: ModelRef | undefined): void => {
    if (!ref) return;
    const key = `${configProviderIdFor(ref.providerId)}\0${ref.modelId.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  const pinnedProvider = process.env.ZCODE_PROVIDER?.trim();
  const pinnedModel = process.env.ZCODE_MODEL?.trim();
  if (pinnedProvider && pinnedModel) push(explicit(pinnedProvider, pinnedModel));

  const configured = configuredDefaultModel();
  if (configured) {
    const parsed = parseModelRefValue(configured);
    if (parsed.providerId) {
      push(explicit(parsed.providerId, parsed.modelId));
    } else {
      // A bare id must name exactly one model — never guess between providers.
      const model = parsed.modelId.toLowerCase();
      const hits = listed.filter((c) => c.modelId.toLowerCase() === model);
      const providers = new Set(hits.map((h) => configProviderIdFor(h.providerId)));
      if (providers.size === 1) push(hits[0]);
    }
  }

  if (preferProviderId) push(providerDefault(inPool(listed, preferProviderId)));
  if (registryListed) {
    // The user's own provider order decides which plan a default comes from;
    // the registry list decides which of its models can run.
    for (const m of local) {
      const runnable = inPool(listed, m.providerId);
      if (runnable.length > 0) {
        push(providerDefault(runnable));
        break;
      }
    }
    // No locally-known provider runs anything: the registry's first one.
    if (listed.length > 0) push(providerDefault(inPool(listed, listed[0]!.providerId)));
  } else if (local.length > 0) {
    push(providerDefault(inPool(local, local[0]!.providerId)));
  }
  return out;
}

/** The first (best) entry of {@link defaultModelCandidates}. */
export function defaultModelRef(
  usable?: readonly UsableModel[] | null,
  preferProviderId?: string,
): ModelRef {
  return (
    defaultModelCandidates(usable, preferProviderId)[0] ?? {
      providerId: DEFAULT_PROVIDER_ID,
      providerName: DEFAULT_PROVIDER_NAME,
      modelId: DEFAULT_MODEL_ID,
    }
  );
}

/** `defaultModelRef` as the `providerId\modelId` value the switch handler takes. */
export function defaultModelValue(
  usable?: readonly UsableModel[] | null,
  preferProviderId?: string,
): string {
  const ref = defaultModelRef(usable, preferProviderId);
  return formatModelValue(ref.providerId, ref.modelId);
}

// ---------- ACP provider metadata (`_meta.zcode`, #400) ----------

/** One provider entry in the ACP-facing `_meta.zcode.providers` list. */
export interface ProviderMetadataEntry {
  /**
   * Config-dialect provider id (`builtin:…` slug / custom UUID) — NOT the
   * registry's `account:` spelling, so it matches the other config.json-sourced
   * fields a client sees.
   */
  id: string;
  /** Display name (the desktop app's providerName; the raw id when unnamed). */
  name: string;
  /** Whether the model dropdown offers this provider's models. */
  selectable: boolean;
  /** Present only when selectable is false — why the dropdown skips it. */
  unselectableReason?: ProviderUnselectableReason;
  /**
   * The modelId the dropdown lists first for the provider — what a session
   * started on it actually runs (`loadZcodeCredentials` dispatches the first
   * config.json key, same order the dropdown derives from).
   */
  defaultModel?: string;
}

/** The `_meta.zcode` payload on the model configOption and session/new responses. */
export interface ProviderMetaPayload {
  providers: ProviderMetadataEntry[];
  /** Config dialect of the current provider (`account:` refs fold to `builtin:`). */
  currentProviderId: string;
}

/**
 * The provider list ACP clients render a provider picker from (#400) —
 * without mirroring `providerSelectable` and the config scan in their own
 * code. Selectable providers come FIRST, derived from the SAME
 * `loadAllModels()` output the model dropdown offers (pass `models` when the
 * caller already holds it), so metadata and dropdown can never disagree —
 * including the ZCODE_PROVIDER pin and entitled coding plans. Unselectable
 * config.json / personal-only entries follow with a reason code, so a client
 * can render "keyless — link account in the desktop app" instead of a
 * silent gap.
 */
export function providerMetadataList(
  models: ModelRef[] = loadAllModels(),
): ProviderMetadataEntry[] {
  const pinned = process.env.ZCODE_PROVIDER;
  const out: ProviderMetadataEntry[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.providerId)) continue;
    seen.add(m.providerId);
    out.push({ id: m.providerId, name: m.providerName, selectable: true, defaultModel: m.modelId });
  }
  const personal = loadPersonalModels();
  const appendConfigDialect = (
    pid: string,
    entry: ProviderEntry | undefined,
    name: string,
  ): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const reason = providerUnselectableReason(pid, entry);
    // A "selectable" verdict here means the provider is usable but carries no
    // models (empty models map) — loadAllModels never listed it. Stay honest
    // rather than inventing a reason.
    out.push(
      reason === null
        ? { id: pid, name, selectable: true }
        : { id: pid, name, selectable: false, unselectableReason: reason },
    );
  };
  try {
    const cfg = readConfig() as ConfigShape;
    for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
      if (pinned && pid !== pinned) continue;
      const effective = effectiveProviderEntry(pid, p, personal);
      appendConfigDialect(pid, effective, effective?.name ?? pid);
    }
  } catch {
    // unreadable config.json — the selectable set from loadAllModels stands alone
  }
  for (const { pid, rule } of personal?.providers ?? []) {
    if (pinned && pid !== pinned) continue;
    appendConfigDialect(pid, personalRuleEntry(rule), rule.providerName ?? pid);
  }
  return out;
}

/** Assemble the `_meta.zcode` payload; the current provider id normalizes to the config dialect. */
export function buildProviderMeta(
  currentProviderId: string,
  models: ModelRef[] = loadAllModels(),
): ProviderMetaPayload {
  return {
    providers: providerMetadataList(models),
    currentProviderId: configProviderIdFor(currentProviderId),
  };
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

/**
 * The context-window size for a provider+model, 0 when no local source knows
 * it. One ladder, most explicit first:
 *
 *  1. `config.json` `limit.context` — the user's per-model limit;
 *  2. the desktop's `provider_config.json` rule (models added there carry
 *     `config.properties.contextWindow` and never reach config.json);
 *  3. the registry's own answer (`registryContextWindow`) — the rule walk the
 *     backend resolves every table model through, and the only local source
 *     for a model that arrives through the provider table alone (GLM-5.4).
 *
 * An explicit value always wins, whichever is larger. Either provider dialect
 * is accepted.
 */
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
  return (
    personalModelSpec(pid, modelId)?.contextWindow ??
    registryContextWindow(providerId, modelId) ??
    0
  );
}

/**
 * The context-gauge denominator (`usage_update.size`): the local ladder above,
 * else the size the backend reported (the CLI's projection seeds a hardcoded
 * 200K until its first usage event). Every emission site goes through here —
 * initial usage, turn-time deltas, the post-switch refresh, the TUI's boot
 * reading — so the gauge cannot flip-flop between sources.
 */
export function usageWindowSize(
  providerId: string,
  modelId: string,
  backendSize: number | null | undefined,
): number {
  return modelContextWindow(providerId, modelId) || backendSize || 0;
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
    // An `account:`-spelled coding plan is a builtin in disguise (the
    // registry dialect of the same config provider) — it must not qualify
    // just for its spelling, or every snapshot-sourced builtin reads as a
    // `providerId › model` pair. Collisions still qualify (same model id on
    // two providers needs the provider in the label).
    const builtin =
      isBuiltinProvider(model.providerId) ||
      isBuiltinProvider(configProviderIdFor(model.providerId));
    const qualify = collidingIds.has(model.modelId) || !builtin;
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

// ---------- session mode resolution ----------

/** The process and per-session revision that produced a mode observation. */
interface ModeVersion {
  generation: number;
  seq?: number;
}

export interface TrustedSessionSettings extends ModeVersion {
  settings: Record<string, unknown>;
}

/** A settings READ this sync performed through {@link readTrustedSettings} —
 * the full session/read result (settings + projection) plus the generation it
 * was confirmed on. */
export interface TrustedSessionRead extends ModeVersion {
  read: ZcodeReadResult;
}

/**
 * The mode state ONE sync resolves. `effective` is the display mode the two
 * ACP representations (mode indicator + configOptions mode item) share;
 * undefined means UNCONFIRMABLE — no trusted source established the BASE mode
 * (every read failed, or the observation went stale mid-flight), so the sync
 * skips mode publication instead of advertising a guess (build/yolo fallbacks
 * must never disagree again). An unknown Plan switch alone never withholds.
 */
export interface SessionModeResolution {
  version?: ModeVersion;
  /**
   * Effective display mode ("plan" when Plan is confirmed on, else the base).
   * Undefined = base unconfirmable.
   */
  effective?: string;
  /** Base permission mode (settings.mode.current) when known. */
  base?: string;
  /**
   * Runtime-confirmed Plan switch; undefined = unknown — the base mode is
   * advertised as-is. Unknown is the NORMAL state after a cold recovery (see
   * resolveSessionMode), not a reason to withhold.
   */
  plan?: boolean;
  /** The settings read this resolution performed (undefined when a caller snapshot decided). */
  read?: TrustedSessionRead;
  /**
   * True when this sync already ATTEMPTED its settings read (successfully or
   * not) — the options build must not pay a second one when the first failed.
   */
  readAttempted?: boolean;
}

/** Inputs one mode sync may already hold, so builders share a single read. */
export interface ModeSyncInput {
  /** Trusted settings snapshot the current operation obtained (switch/resume response). */
  snapshot?: TrustedSessionSettings;
  /**
   * True when the snapshot is known to carry the FULL settings (model +
   * thoughtLevel, the same shape a session/read returns) — the model/thought
   * read is then skipped too.
   */
  complete?: boolean;
  /** A settings read this sync already paid for (mode + model/thought source). */
  read?: TrustedSessionRead;
  /** A resolution already computed for this sync (share it across builders). */
  resolution?: SessionModeResolution;
}

/**
 * Extract the trusted settings snapshot from a zcode create/resume/switch
 * result (`result.settings`). Undefined when the result carries none — an
 * empty success response only proves the command was accepted.
 */
export function settingsFromResult(result: unknown): Record<string, unknown> | undefined {
  const settings = (result as { settings?: unknown } | null | undefined)?.settings;
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : undefined;
}

/** The base mode a settings snapshot reports (`settings.mode.current`), when valid. */
export function baseModeFromSettings(
  settings: Record<string, unknown> | undefined,
): string | undefined {
  const modeSet = settings?.mode as Record<string, unknown> | undefined;
  const current = modeSet?.current;
  return isSessionMode(current) ? current : undefined;
}

export function planFromSettings(
  settings: Record<string, unknown> | undefined,
): boolean | undefined {
  const plan = (settings?.mode as { planEnabled?: unknown } | undefined)?.planEnabled;
  return typeof plan === "boolean" ? plan : undefined;
}

function isCurrentModeVersion(server: ZcodeAcpServer, sid: string, version: ModeVersion): boolean {
  return (
    version.generation === server.backendGeneration &&
    (version.seq === undefined || version.seq === server.modeSeqOf(sid))
  );
}

/**
 * Read settings once. A backend restart or a newer mode event during the
 * read invalidates its result.
 */
export async function readTrustedSettings(
  server: ZcodeAcpServer,
  zcodeSid: string,
): Promise<TrustedSessionRead | undefined> {
  const version = server.modeVersionOf(zcodeSid);
  let read: ZcodeReadResult;
  try {
    read = await sessionRead(server, zcodeSid);
  } catch {
    return undefined; // RPC error / timeout — nothing confirmable from this read
  }
  return isCurrentModeVersion(server, zcodeSid, version) ? { read, ...version } : undefined;
}

/**
 * Resolve the effective mode for ONE sync — the single source both ACP mode
 * representations share.
 *
 *   - Pending session (zcodeSid null): the creation params (initialSessionMode)
 *     fill both representations with ZERO backend reads.
 *   - Materialized: the caller's trusted snapshot decides when it carries a
 *     valid `settings.mode.current`; otherwise one messageLimit:1 read.
 *   - Effective = "plan" when Plan is runtime-confirmed on, else the base
 *     mode. An UNKNOWN Plan switch advertises the base as-is: Plan is
 *     invisible to every v3 read (the settings schema's `mode` is strict with
 *     `current` alone, `zcodeSessionSettingsStateSchema`) and a resumed
 *     runtime replays no transition event, so unknown is the NORMAL state
 *     after every cold recovery — withholding on it removed the mode from
 *     every loaded session (the 0.95.0 regression). A plan-active session
 *     therefore shows its underlying mode until its first transition event or
 *     an explicit switch (the long-standing cold-resume hole, AGENTS.md
 *     "Plan mode is INVISIBLE"); the retired Plan record never answers for a
 *     rebuilt runtime.
 */
export async function resolveSessionMode(
  server: ZcodeAcpServer,
  zcodeSid: string | null,
  input: ModeSyncInput = {},
): Promise<SessionModeResolution> {
  if (zcodeSid === null) {
    // Pending: the advertised mode IS the creation mode (what session/create
    // sends at materialization) — the exact value the session will run in.
    const initial = initialSessionMode();
    return { effective: initial, base: initial, plan: initial === "plan" };
  }
  const snapshot =
    input.snapshot && isCurrentModeVersion(server, zcodeSid, input.snapshot)
      ? input.snapshot
      : undefined;
  const version = server.modeVersionOf(zcodeSid);
  const read =
    baseModeFromSettings(snapshot?.settings) === undefined
      ? (input.read ?? (await readTrustedSettings(server, zcodeSid)))
      : undefined;
  if (
    !isCurrentModeVersion(server, zcodeSid, version) ||
    (read && !isCurrentModeVersion(server, zcodeSid, read))
  ) {
    return { readAttempted: true };
  }
  const settings = read?.read.settings ?? snapshot?.settings;
  const base = baseModeFromSettings(settings);
  if (base === undefined) return { readAttempted: true, read, version };
  server.rememberModeSettings(zcodeSid, base, planFromSettings(settings));
  const plan = server.planStateOf(zcodeSid);
  return { base, plan, effective: effectiveModeFor(base, plan), read, version };
}

/** The event that overtook a switch may already have confirmed its effective mode. */
function confirmedModeAfterEvent(server: ZcodeAcpServer, sid: string): SessionModeResolution {
  const base = server.seededBaseModeOf(sid);
  if (base === undefined) return { readAttempted: true };
  const plan = server.planStateOf(sid);
  return {
    base,
    plan,
    effective: effectiveModeFor(base, plan),
    readAttempted: true,
    version: server.modeVersionOf(sid),
  };
}

/** Fold the runtime-confirmed Plan switch over the base mode (upstream's own
 * display fold: `planEnabled ?? mode === "plan"`). An unknown Plan switch
 * yields the base mode — only a confirmed-on switch overrides it. */
export function effectiveModeFor(base: string, plan: boolean | undefined): string {
  if (plan === true) return "plan";
  return base;
}

/** The ACP SessionModeState a resolution advertises, or null when the base mode
 *  is unconfirmable (an unknown Plan switch still advertises the base). */
export function modesFromResolution(
  resolution: SessionModeResolution,
): acp.SessionModeState | null {
  if (resolution.effective === undefined) return null;
  return {
    currentModeId: resolution.effective,
    // ZCode mode enum: plan/build/edit/guarded/yolo/auto — guarded is new in
    // 3.15.1 (yolo semantics + a one-time approval on AST-recognized dangerous
    // shell commands); `auto` stays internal-only upstream, so the dropdown
    // does not advertise it (the backend still accepts it on the wire).
    // settings.mode only carries `current` (no `available` list, unlike
    // thoughtLevel), so the vocabulary is advertised here.
    availableModes: ["plan", "build", "edit", "guarded", "yolo"].map((m) => ({
      id: m,
      name: capitalize(m),
    })),
  };
}

/** Build the ACP SessionModeState ({currentModeId, availableModes}).
 *  zcodeSid null = pending session (session/new not yet materialized) — zero
 *  backend reads, the configured initial mode fills both representations.
 *  Returns null when the session's BASE mode is unconfirmable (no trusted
 *  `settings.mode.current`) — the caller omits the optional `modes` field (and
 *  the mode refresh) instead of guessing. An unknown Plan switch does not
 *  withhold: the base mode is advertised. */
export async function buildModes(
  server: ZcodeAcpServer,
  zcodeSid: string | null,
  input: ModeSyncInput = {},
): Promise<acp.SessionModeState | null> {
  const resolution = input.resolution ?? (await resolveSessionMode(server, zcodeSid, input));
  return modesFromResolution(resolution);
}

/**
 * The PENDING session's SessionModeState — always resolvable from the
 * creation params (zero backend reads, asserted by tests), so callers get a
 * non-null state without a narrowing dance.
 */
export async function pendingModes(server: ZcodeAcpServer): Promise<acp.SessionModeState> {
  const modes = modesFromResolution(await resolveSessionMode(server, null));
  if (!modes) throw new Error("pending session mode unresolvable"); // unreachable
  return modes;
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

/** The user's default thought level (`session.defaultThoughtLevel` in the user config), when set. */
export function configuredDefaultThoughtLevel(): string | undefined {
  return loadUserConfig().session?.defaultThoughtLevel?.trim() || undefined;
}

/**
 * The model's own spelling of a wanted thought level: the exact token, else
 * the level that differs only by case, else undefined (the model does not
 * offer it).
 */
export function matchThoughtLevel(levels: readonly string[], wanted: string): string | undefined {
  return levels.includes(wanted)
    ? wanted
    : levels.find((level) => level.toLowerCase() === wanted.toLowerCase());
}

/**
 * The thought dropdown a PENDING session advertises. No backend session
 * exists yet, so the vocabulary is the default model's declaration in the
 * local config (the enabled provider's `models[].reasoning.variants`) — a
 * client that relays the options into a picker (Multica's effort selector)
 * must not be offered tokens the runtime rejects ("nothink" was fiction,
 * "low" was missing) — else the static fallback.
 *
 * The current value is the user's default thought level when the advertised
 * vocabulary offers it (the pin at materialization, `applyDefaultThoughtLevel`,
 * makes the advertisement true), else the model's own default. The settings
 * page reports the same projection, so it shows exactly what a new session
 * starts on.
 */
export function pendingThoughtProjection(): {
  current: string;
  options: Array<{ value: string; name: string }>;
} {
  const cur = defaultModelRef();
  let variants: string[] | undefined;
  let defaultVariant: string | undefined;
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
    if (reasoning && reasoning.enabled !== false && reasoning.variants?.length) {
      variants = reasoning.variants;
      defaultVariant = reasoning.defaultVariant;
    }
  } catch {
    // unreadable config — the static fallback below applies
  }
  const options = variants ? orderThoughtVariants(variants) : [...CONFIG_META.thought.options];
  let current = defaultVariant ?? variants?.[0] ?? "max";
  const level = configuredDefaultThoughtLevel();
  const matched = level
    ? matchThoughtLevel(
        options.map((o) => o.value),
        level,
      )
    : undefined;
  if (matched) current = matched;
  return { current, options };
}

/** Build the ACP configOptions array (model/mode/thought).
 *  zcodeSid null = pending session — ZERO backend reads: the mode is the
 *  configured initial mode (initialSessionMode — what session/create sends at
 *  materialization) so the dropdown matches the mode indicator for a fresh
 *  session, and the model/thought are the local-config projection.
 *
 *  Materialized sessions resolve the mode through {@link resolveSessionMode}
 *  — ONE confirmed result shared with the mode indicator (buildModes /
 *  emitConfigOptionUpdate pass the same input or resolution). When the mode
 *  is unconfirmable (read failure, backend replaced mid-read, Plan switch
 *  unknown after a cold recovery — the normal state, since no v3 read carries
 *  the Plan flag) the base mode is advertised; only an unconfirmable BASE omits
 *  the `mode` item instead of advertising a guessed fallback — the other
 *  options still carry everything they can present.
 *
 *  `receiverRoot` is the clientConnectionRoot of the client the array is
 *  delivered to — the quota pseudo-option is appended only for martty
 *  connections (ADR-0021). */
export async function buildConfigOptions(
  server: ZcodeAcpServer,
  zcodeSid: string | null,
  receiverRoot?: unknown,
  input: ModeSyncInput = {},
): Promise<acp.SessionConfigOption[]> {
  let currentProviderId = "";
  let currentModelId = DEFAULT_MODEL_ID;
  // Matches the enabled provider's default reasoning variants (GLM-5.3:
  // max/high/low, default max). Pending sessions show this until the real
  // session/read thoughtLevel arrives.
  let currentThought = "max";
  let thoughtOptions: Array<{ value: string; name: string }> | null = null;
  if (zcodeSid === null) {
    // Pending session — no backend to read yet. The advertised current model
    // is the DEFAULT a new session starts on (defaultModelRef: the manual
    // choice, else the newest usable model) — the one the runtime is pinned
    // to at materialization.
    const cur = defaultModelRef();
    if (cur) {
      // The advertised current model follows the dropdown's leading entry
      // (the enabled provider's first model — what the runtime actually
      // starts sessions with) rather than the legacy hardcoded "GLM-5.2".
      // ACP clients skip a requested model switch when it equals the
      // advertised current value, so a stale fiction silently pinned the
      // wrong model whenever the requested id happened to match it.
      currentProviderId = cur.providerId;
      currentModelId = cur.modelId;
    }
    // The thought vocabulary is per model — projected for the default model.
    const thought = pendingThoughtProjection();
    currentThought = thought.current;
    thoughtOptions = thought.options;
  }

  // Captured before the resolution (which may read) so the identity write
  // below can detect a model switch that landed while the read was in flight.
  const identityBeforeRead =
    zcodeSid === null ? undefined : server.currentModelIdentity.get(zcodeSid);
  const resolution = input.resolution ?? (await resolveSessionMode(server, zcodeSid, input));
  let currentMode = resolution.effective;

  // The settings source for model/thought: a read this sync already paid for
  // (the caller's, or the resolution's own), else a complete trusted
  // snapshot, else — materialized sessions only — one best-effort read.
  let settings: Record<string, unknown> | undefined;
  let settingsFromRead = false;
  if (
    resolution.read &&
    zcodeSid !== null &&
    isCurrentModeVersion(server, zcodeSid, resolution.read)
  ) {
    settings = resolution.read.read.settings ?? {};
    settingsFromRead = true;
  } else if (
    input.complete &&
    input.snapshot &&
    zcodeSid !== null &&
    isCurrentModeVersion(server, zcodeSid, input.snapshot)
  ) {
    settings = input.snapshot.settings;
  } else if (zcodeSid !== null && !resolution.readAttempted) {
    const fresh = await readTrustedSettings(server, zcodeSid);
    settings = fresh?.read.settings ?? {};
    settingsFromRead = fresh !== undefined;
  }
  if (
    zcodeSid !== null &&
    resolution.version &&
    !isCurrentModeVersion(server, zcodeSid, resolution.version)
  ) {
    currentMode = undefined;
  }
  if (zcodeSid !== null && settings) {
    const modelSet = (settings.model as Record<string, unknown>) ?? {};
    // settings.model.current is { providerId, modelId, variant? } — read BOTH so
    // we can disambiguate same-named models across providers. Preserve the
    // registry identity: legacy config aliases can collapse distinct plans.
    const cur = (modelSet.current as { providerId?: string; modelId?: string }) ?? {};
    // Only a READ may write the identity map: a snapshot was taken earlier
    // (a resume flight's RPC), and a model switch — the post-resume re-assert
    // — may have landed since; the fresher identity must not be overwritten.
    if (settingsFromRead) {
      if (
        cur.providerId &&
        cur.modelId &&
        server.currentModelIdentity.get(zcodeSid) === identityBeforeRead
      ) {
        server.currentModelIdentity.set(zcodeSid, {
          providerId: cur.providerId,
          modelId: cur.modelId,
        });
      }
    }
    const identity = server.currentModelIdentity.get(zcodeSid);
    if (identity) {
      currentProviderId = identity.providerId;
      currentModelId = identity.modelId;
    } else if (cur.providerId && cur.modelId) {
      currentProviderId = cur.providerId;
      currentModelId = cur.modelId;
    }
    const tlSet = (settings.thoughtLevel as Record<string, unknown>) ?? {};
    // `current` is absent right after session/create — fall back to the
    // backend's defaultLevel (the level the session actually runs at).
    currentThought = (tlSet.current as string) ?? (tlSet.defaultLevel as string) ?? currentThought;
    const tlAvail = (tlSet.available as Array<Record<string, string>>) ?? [];
    if (tlAvail.length > 0) {
      thoughtOptions = tlAvail.map((a) => ({ value: a.value, name: a.label ?? a.value }));
      // setModel can leave the runtime briefly holding the PREVIOUS model's
      // thoughtLevel (upstream clamps its own snapshot for the same reason —
      // session-mapper.ts: "setModel 后 runtime 可能短暂保留上一个模型的
      // thoughtLevel"). Never advertise a current outside the new model's
      // list: the CLI would keep displaying — and re-sending — the old
      // model's level (observed 2026-09-28 after switches between models
      // with different level vocabularies).
      const values = new Set(tlAvail.map((a) => a.value));
      if (!values.has(currentThought)) {
        const def = typeof tlSet.defaultLevel === "string" ? tlSet.defaultLevel : undefined;
        currentThought = def && values.has(def) ? def : (tlAvail[0]?.value ?? currentThought);
      }
    }
  }

  // currentValue encodes provider+model so the switch handler can locate the
  // right provider (and its apiKey). Fall back to the first enabled provider
  // when settings omits providerId (legacy sessions).
  if (zcodeSid !== null && !currentProviderId) {
    const identity = server.currentModelIdentity.get(zcodeSid);
    if (identity) {
      currentProviderId = identity.providerId;
      currentModelId = identity.modelId;
    }
  }
  const snapshot = zcodeSid === null ? undefined : server.modelAvailability.get(zcodeSid);
  // The materialized snapshot speaks the REGISTRY dialect (`account:…`
  // provider ids) and carries no display names. The VALUES must stay in that
  // dialect — it is the only key that keeps same-named models of colliding
  // legacy plans distinct, and the switch round-trip depends on it — but the
  // provider NAME a choice shows must not be the raw registry id: a
  // coding-plan choice would read as the full
  // `account:<family>-individual-coding-plan › <model>` pair, an unreadable
  // id string where every client (phone AND desktop panel) wants the display
  // name. Resolve the name through the config dialect (configProviderIdFor
  // folds the alias); ids the config cannot name keep the raw id as the
  // label — distinct, if ugly.
  const localModels = loadAllModels();
  const providerNames = providerDisplayNames(localModels);
  const allModels =
    snapshot === undefined
      ? localModels
      : snapshot
          .filter((m): m is typeof m & { providerId: string; modelId: string } =>
            Boolean(m.providerId && m.modelId),
          )
          .map((m) => ({
            providerId: m.providerId,
            providerName:
              providerNames.get(configProviderIdFor(m.providerId)) ??
              providerNames.get(m.providerId) ??
              m.providerId,
            modelId: m.modelId,
          }));
  const currentProvider = currentProviderId || allModels[0]?.providerId || DEFAULT_PROVIDER_ID;
  const currentModel = formatModelValue(currentProvider, currentModelId);

  // Materialized snapshots are authoritative for display; before one exists,
  // fall back to config.json. Values
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
      // Provider metadata for ACP clients (#400). The model option is the
      // refresh vehicle: every rebuild (switch, credential change, config_
      // option_update) re-attaches it, so the provider list stays live for
      // the whole session lifetime. See docs/CONFIG-OPTIONS.md.
      _meta: { zcode: buildProviderMeta(currentProvider, localModels) },
    },
  ];
  // The mode item is present only when this sync CONFIRMED the base mode (the
  // same resolution the mode indicator publishes; an unknown Plan switch
  // advertises the base). An unconfirmable base is omitted — never replaced by
  // a guessed fallback (a missing item reads as "temporarily unavailable", a
  // wrong value reads as the session's mode).
  if (currentMode !== undefined) {
    options.push({
      id: "mode",
      name: CONFIG_META.mode.name,
      category: "mode" as acp.SessionConfigOptionCategory,
      type: "select",
      currentValue: currentMode,
      options: [...CONFIG_META.mode.options],
    });
  }
  options.push({
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
  });

  // Do not invent a provider/model pair when a materialized read lacks
  // identity. An UNBOUND restore (a persisted selection the registry could
  // not bind — e.g. the model was switched off in the desktop) also reports
  // no current model, and hiding the model option there left the user with
  // no picker to switch back with (observed 2026-11-23): advertise the
  // default-model choice as the pending current instead, so the dropdown
  // exists and the repair/fallback path has a concrete value to apply.
  if (zcodeSid !== null && !currentProviderId && options[0]?.id === "model") {
    const modelOption = options[0] as Extract<
      acp.SessionConfigOption,
      { type: "select"; id: string }
    >;
    const fallback = defaultModelRef(snapshot);
    options[0] = {
      ...modelOption,
      currentValue: formatModelValue(fallback.providerId, fallback.modelId),
    };
  }

  // Read-only quota pseudo-option (ADR-0021): martty-only, no category (never
  // lands in a settings menu), string type per the probe-verified shape — the
  // SDK's union stops at select/boolean, so the cast carries the agent-owned
  // extension through typecheck. `set_config_option` on it is a no-op.
  // Gated on the RECEIVER's connection identity, not process state — a
  // non-martty client must never see the spec-external string option.
  if (
    backendCapabilities(server.backendKind).quota &&
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

function providerDisplayNames(localModels: ModelRef[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const rule of readBuiltinTable()?.table.config?.providerConfigRules?.providerRules ?? []) {
    if (!rule.providerId || !rule.providerName) continue;
    names.set(rule.providerId, rule.providerName);
    names.set(configProviderIdFor(rule.providerId), rule.providerName);
  }
  for (const m of localModels) {
    names.set(m.providerId, m.providerName);
  }
  return names;
}

/**
 * Promote fallback `builtin:*` coding-plan models onto the backend's `account:*`
 * registry dialect when `zcode-builtin.json` is present, merging any additional
 * entitled models for already-enabled providers so `session/new` matches
 * `session/set_config_option` synchronously before the cold probe finishes.
 */
function canonicalizeInitialModelOption(
  options: acp.SessionConfigOption[],
): acp.SessionConfigOption[] {
  const localModels = loadAllModels();
  if (localModels.length === 0) return options.filter((option) => option.id !== "model");
  if (!readBuiltinTable()) return options;
  const index = options.findIndex((option) => option.id === "model");
  const existing = options[index];
  if (index < 0 || existing?.type !== "select") return options;

  const enabledConfigPids = new Set(localModels.map((m) => configProviderIdFor(m.providerId)));
  const names = providerDisplayNames(localModels);
  const models: ModelRef[] = [];
  const seen = new Set<string>();
  const push = (providerId: string, providerName: string, modelId: string): void => {
    const key = formatModelValue(providerId, modelId);
    if (seen.has(key)) return;
    seen.add(key);
    models.push({ providerId, providerName, modelId });
  };
  for (const m of localModels) {
    const pid = accountProviderIdFor(m.providerId);
    push(pid, names.get(configProviderIdFor(pid)) ?? names.get(pid) ?? m.providerName, m.modelId);
  }
  for (const m of entitledCodingPlanModels()) {
    if (!enabledConfigPids.has(configProviderIdFor(m.providerId))) continue;
    const pid = accountProviderIdFor(m.providerId);
    push(pid, names.get(configProviderIdFor(pid)) ?? names.get(pid) ?? m.providerName, m.modelId);
  }

  const choices = buildModelSelectOptions(models);
  const parsedCurrent = parseModelValue(String(existing.currentValue ?? ""));
  const mappedCurrent = formatModelValue(
    accountProviderIdFor(parsedCurrent.providerId),
    parsedCurrent.modelId,
  );
  const currentValue = choices.some((choice) => choice.value === mappedCurrent)
    ? mappedCurrent
    : (choices[0]?.value ?? existing.currentValue);
  options[index] = { ...existing, currentValue, options: choices };
  return options;
}

/** Apply a validated, ephemeral create snapshot to a lazy session's initial menu. */
export async function buildInitialConfigOptions(
  server: ZcodeAcpServer,
  receiverRoot: unknown,
  result: ZcodeCreateResult | null,
): Promise<acp.SessionConfigOption[]> {
  const options = await buildConfigOptions(server, null, receiverRoot);
  const model = result?.settings?.model;
  const current = model?.current;
  const available = model?.available;
  if (
    !Array.isArray(available) ||
    available.some((entry) => !entry?.ref?.providerId || !entry.ref.modelId)
  )
    return canonicalizeInitialModelOption(options);
  // ACP requires a currentValue. A registry that has no current selection
  // cannot safely claim the locally configured default is active.
  if (!current?.providerId || !current.modelId) return canonicalizeInitialModelOption(options);
  // Same naming rule as buildConfigOptions' snapshot path: values stay in the
  // create result's registry dialect (identity-preserving), names resolve
  // through the config dialect so the raw provider id never reads as a label.
  const names = providerDisplayNames(loadAllModels());
  const models = available.map((entry) => {
    const pid = entry.ref!.providerId!;
    return {
      providerId: pid,
      providerName: names.get(configProviderIdFor(pid)) ?? names.get(pid) ?? pid,
      modelId: entry.ref!.modelId!,
    };
  });
  const currentValue = formatModelValue(current.providerId, current.modelId);
  const choices = buildModelSelectOptions(models);
  if (!choices.some((choice) => choice.value === currentValue)) {
    // A current model absent from the registry snapshot is not a verified
    // selectable option. Do not advertise it as switchable.
    return canonicalizeInitialModelOption(options);
  }
  const index = options.findIndex((option) => option.id === "model");
  const existing = options[index];
  if (index >= 0 && existing?.type === "select")
    options[index] = { ...existing, currentValue, options: choices };
  return options;
}

/**
 * Dispatch session/set_config_option. mode/thought forward to setMode/
 * setThoughtLevel; model routes through applyModelSwitch (runtime-model.ts).
 *
 * Returns `{ kind, currentValue }` (+ the switch's own `responseSettings`
 * snapshot when the backend returned one) so the caller can emit the update
 * notifications, or null when the configId is unknown / model switch fails.
 */
export async function setConfigOption(
  server: ZcodeAcpServer,
  zcodeSid: string,
  configId: string,
  value: string,
  acpSid?: string,
): Promise<{
  kind: "model" | "mode" | "thought";
  currentValue: string;
  snapshot?: TrustedSessionSettings;
} | null> {
  if (configId === "model") {
    const { applyModelSwitch, lastSwitchedModelValue } = await import("./runtime-model.js");
    const ok = await applyModelSwitch(server, zcodeSid, value);
    if (!ok) return null;
    // Remember the registry-dialect identity the switch LANDED on (#403) —
    // the inbound value may be a stale-dialect ref that only resolved via
    // model-resolution, and the post-resume re-assert replays this record.
    rememberModelChoice(server, acpSid, zcodeSid, {
      model: lastSwitchedModelValue(server, zcodeSid) ?? value,
    });
    return { kind: "model", currentValue: lastSwitchedModelValue(server, zcodeSid) ?? value };
  }
  const dispatch = CONFIG_DISPATCH[configId];
  if (!dispatch) return null;
  const backend = await server.ensureBackend();
  const version = server.modeVersionOf(zcodeSid);
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
  return {
    kind: configId as "mode" | "thought",
    currentValue: value,
    snapshot: { settings: settingsFromResult(resp.result) ?? {}, ...version },
  };
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

/** "default level not offered" warnings — once per process per model + level. */
const unsupportedDefaultThoughtWarned = new Set<string>();

/**
 * Start a NEW session on the user's default thought level — the thought
 * counterpart of the advertised-model pin at materialization.
 *
 * The pending menu PROJECTED the level from the local config; this is the
 * first moment the session's real vocabulary exists, so the backend decides:
 * `session/read` lists the current model's levels, and a default the model
 * does not offer is never forced (the model's own default stands, warned once
 * per model and level). An applied level is remembered as the session's own
 * choice (`setConfigOption`), so the post-resume re-assert keeps it; a choice
 * already recorded for the session (a recovered store record) owns the
 * selection and wins.
 *
 * Best-effort: a failure keeps the model default and never fails the
 * materialization.
 */
export async function applyDefaultThoughtLevel(
  server: ZcodeAcpServer,
  acpSid: string,
  zcodeSid: string,
): Promise<void> {
  const level = configuredDefaultThoughtLevel();
  if (!level) return;
  // `""` counts: it is a remembered RESET and owns the selection like any
  // other recorded level.
  if (server.sessionModelChoices.get(zcodeSid)?.thought !== undefined) return;
  const generation = server.backendGeneration;
  let model = "";
  let current: string | undefined;
  let levels: string[] | undefined;
  try {
    const read = await sessionRead(server, zcodeSid);
    const settings = (read.settings ?? {}) as Record<string, unknown>;
    const modelCur = settings.model as
      { current?: { providerId?: string; modelId?: string } } | undefined;
    const thought = (settings.thoughtLevel ?? {}) as {
      current?: unknown;
      defaultLevel?: unknown;
      available?: Array<{ value?: unknown }>;
    };
    const providerId = modelCur?.current?.providerId;
    const modelId = modelCur?.current?.modelId;
    model = providerId && modelId ? `${providerId}\\${modelId}` : (modelId ?? "");
    current =
      typeof thought.current === "string"
        ? thought.current
        : typeof thought.defaultLevel === "string"
          ? thought.defaultLevel
          : undefined;
    levels = Array.isArray(thought.available)
      ? thought.available.map((a) => a?.value).filter((v): v is string => typeof v === "string")
      : undefined;
  } catch (e) {
    log(
      `default thought level: session/read failed (${e instanceof Error ? e.message : String(e)}) — keeping the model default`,
    );
    return;
  }
  if (generation !== server.backendGeneration) return;
  // No vocabulary in the read (an older backend, a level-less session read):
  // unknown is not "unsupported" — leave the session alone, without a warning.
  if (!levels) return;
  const matched = matchThoughtLevel(levels, level);
  let landed: string | undefined;
  if (matched) {
    let refusal = "";
    try {
      landed = (await setConfigOption(server, zcodeSid, "thought", matched, acpSid))
        ? matched
        : undefined;
      if (!landed) refusal = "the backend refused it";
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    if (landed) log(`session/new ${acpSid}: started on the default thought level ${landed}`);
    else {
      warn(
        `session/new ${acpSid}: default thought level ${matched} not applied (${refusal}) — keeping the model default`,
      );
    }
  } else if (!unsupportedDefaultThoughtWarned.has(`${model}:${level}`)) {
    unsupportedDefaultThoughtWarned.add(`${model}:${level}`);
    warn(
      `default thought level "${level}" is not supported by ${model || "the session's model"} — ` +
        "new sessions keep the model's own default",
    );
  }
  // The pending menu projected this level from the local config: correct the
  // clients when the projection was wrong — a level the projection lacked, or
  // one it advertised that the model does not offer.
  const effective = landed ?? current;
  if (effective && effective !== pendingThoughtProjection().current) {
    await emitConfigOptionUpdate(server, server.clients.broadcast(), acpSid, zcodeSid, "thought");
  }
}

/** Options for {@link emitConfigOptionUpdate} — the one mode-switch publish. */
export interface EmitConfigOptions {
  /**
   * The switch's own response snapshot (`result.settings`), when the backend
   * returned one — a complete response decides the mode with NO re-read; an
   * empty success response only proves the command was accepted and one
   * messageLimit:1 read follows.
   */
  snapshot?: TrustedSessionSettings;
  /**
   * The mode an explicit switch just set. Applying its semantics ("plan"
   * enables the runtime Plan switch, any other valid mode disables it) is part
   * of the publish — the four switch entries (session/set_mode,
   * session/setMode, session/set_config_option's mode branch, /mode) share
   * this one site. Absent for model/thought syncs and event-driven refreshes.
   */
  switchMode?: string;
}

/**
 * Publish a settings change to the attached clients. A mode switch updates
 * both ACP controls from the same confirmed value. If confirmation fails,
 * clients keep their last display and the caller still gets the switch result.
 * Independent model and thought updates carry the settings available to them.
 * A model switch also refreshes the context window in the usage display.
 */
export async function emitConfigOptionUpdate(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  kind: "model" | "mode" | "thought",
  opts: EmitConfigOptions = {},
): Promise<{
  options: acp.SessionConfigOption[];
  currentModeId?: string;
}> {
  // The switch's Plan semantics apply BEFORE the resolution reads anything:
  // the mode the publish advertises must already fold them.
  const obsolete = opts.snapshot && !isCurrentModeVersion(server, zcodeSid, opts.snapshot);
  let snapshot = obsolete ? undefined : opts.snapshot;
  if (opts.switchMode !== undefined && !obsolete) {
    server.notePlanState(zcodeSid, opts.switchMode === "plan");
    if (snapshot) snapshot = { ...snapshot, ...server.modeVersionOf(zcodeSid) };
  }
  if (obsolete && kind === "mode") {
    // A newer event may have already published this switch. Return its confirmed
    // value to the requester; never replay an acknowledgement from the old runtime.
    const resolution =
      opts.snapshot?.generation === server.backendGeneration
        ? confirmedModeAfterEvent(server, zcodeSid)
        : { readAttempted: true };
    const options = await buildConfigOptions(server, zcodeSid, clientConnectionRoot(cx), {
      resolution,
    });
    return { options };
  }
  const resolution = await resolveSessionMode(server, zcodeSid, { snapshot });
  const options = await buildConfigOptions(server, zcodeSid, clientConnectionRoot(cx), {
    resolution,
    snapshot,
    complete: snapshot?.settings.model != null && snapshot.settings.thoughtLevel != null,
  });
  const send = configUpdateSender(server, cx, acpSid);
  const modeUnconfirmable = kind === "mode" && !options.some((o) => o.id === "mode");
  let currentModeId: string | undefined;
  if (!modeUnconfirmable) {
    currentModeId = kind === "mode" ? resolution.effective : undefined;
    await publishConfigOptions(server, cx, acpSid, options, currentModeId);
  } else {
    log(
      `options: mode unconfirmable after switch (base=${resolution.base ?? "?"} plan=${String(resolution.plan)}) — switch kept, mode refresh skipped`,
    );
  }
  if (kind === "model" && (resolution.read || !resolution.readAttempted)) {
    // Refresh the context bar: the backend's projection.contextWindow lags
    // behind a model switch, so the new model's window comes from the local
    // ladder first. The resolution's own read already carried the projection
    // when it performed one — reuse it instead of a second read.
    try {
      const observation = resolution.read?.read ?? (await sessionRead(server, zcodeSid));
      const proj = (observation.projection ?? {}) as {
        contextUsed?: number;
        contextWindow?: number;
      };
      // Occupancy only (#228): totalTokenCount is lifetime consumption, never
      // a meter. This refresh exists to re-show SIZE after the switch; used
      // reads 0 until the backend reports real occupancy.
      const used = proj.contextUsed ?? 0;
      // The rebuilt options[0] (model) currentValue is the just-switched value.
      const modelOpt = options.find((o) => o.id === "model");
      const { providerId, modelId } = parseModelValue(String(modelOpt?.currentValue ?? ""));
      // The projection's contextWindow still names the PREVIOUS model here, so
      // it is only the last resort — for a model no local source knows.
      const size = usageWindowSize(providerId, modelId, proj.contextWindow);
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
  return {
    options,
    ...(currentModeId !== undefined ? { currentModeId } : {}),
  };
}

/**
 * The fan-out closure every config/mode publication shares: a broadcast-proxy
 * cx reaches every client through one send per SESSION ALIAS; a real
 * per-connection cx reaches the initiator plus every other client.
 */
function configUpdateSender(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
): (update: acp.SessionUpdate) => Promise<void> {
  if (isBroadcastSource(cx)) {
    return (update) =>
      Promise.all(
        server.sessionAliases(acpSid).map((sid) => sendSessionUpdate(cx, sid, update)),
      ).then(() => undefined);
  }
  return (update) => {
    const sent = sendSessionUpdate(cx, acpSid, update);
    sendSessionUpdateToOthers(server, cx, acpSid, update);
    return sent.catch((e: unknown) => {
      warn(
        `options: config update send failed (sid=${acpSid}): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  };
}

/** Queue both views together, once per alias, while this observation is current. */
export async function publishConfigOptions(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  options: acp.SessionConfigOption[],
  mode?: string,
): Promise<void> {
  const send = configUpdateSender(server, cx, acpSid);
  const config = send({ sessionUpdate: "config_option_update", configOptions: options });
  if (mode === undefined) return config;
  const indicator = send({ sessionUpdate: "current_mode_update", currentModeId: mode });
  for (const alias of server.sessionAliases(acpSid)) server.lastMode.set(alias, mode);
  await Promise.all([config, indicator]);
}

/**
 * An internal resume has no ACP response to carry the recovered mode.
 * Broadcast a confirmed change to each alias of the session.
 */
export async function publishResolvedMode(
  server: ZcodeAcpServer,
  cx: acp.AgentContext,
  acpSid: string,
  zcodeSid: string,
  resolution: SessionModeResolution,
): Promise<void> {
  if (resolution.effective === undefined) return;
  const aliases = server.sessionAliases(acpSid);
  if (aliases.every((alias) => server.lastMode.get(alias) === resolution.effective)) return;
  const options = await buildConfigOptions(server, zcodeSid, clientConnectionRoot(cx), {
    resolution,
  });
  if (
    !options.some((o) => o.id === "mode") ||
    aliases.every((alias) => server.lastMode.get(alias) === resolution.effective)
  )
    return;
  await publishConfigOptions(server, cx, acpSid, options, resolution.effective);
}

// ---------- helpers ----------

async function sessionRead(server: ZcodeAcpServer, zcodeSid: string): Promise<ZcodeReadResult> {
  const backend = await server.ensureBackend();
  const resp = await backend.request(
    server.nextId(),
    "session/read",
    // messageLimit: callers read settings/projection only; the cap stops the
    // backend from serializing the session's whole message array for them.
    { sessionId: zcodeSid, messageLimit: 1 },
    5000,
  );
  if (resp.error) throw new Error(resp.error.message);
  return (resp.result ?? {}) as ZcodeReadResult;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
