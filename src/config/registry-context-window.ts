/**
 * The context window the ZCode registry assigns to a model — a mirror of
 * upstream's rule walk over the bundled provider table
 * (`ModelConfigRules.resolve`, packages/provider/src/config/model-config.ts),
 * read from the same table file the backend boots from.
 *
 * Why the bridge needs its own copy: the backend reports a model's window only
 * through turn-time usage events, so everything the bridge emits OUTSIDE a
 * turn (the gauge right after a model switch, the TUI's boot reading, the
 * models list the settings pages render) has to know the number locally.
 * Legacy `config.json` `limit.context` stopped syncing and `provider_config.json`
 * only describes models the user added by hand — a model that arrives through
 * the table alone is in neither (observed 2026-11-23: GLM-5.4 showed no
 * context suffix on mobile and a 0 denominator after a switch, while the
 * desktop app showed 1M).
 *
 * The walk, in upstream order — a later rule overlays an earlier one:
 *
 *   modelRules → modelApiRules → providerSiteRules → templateModelRules
 *   → builtinProviderModelRules
 *
 *   - pattern rules match the model id ANCHORED and case-insensitively;
 *   - `model-api` and `provider-site` rules also test `apiTypeMatch` (when
 *     present) against the provider's api type, case-SENSITIVE;
 *   - `provider-site` rules also test `baseUrlMatch` against the provider's
 *     normalized base URL, so they never match a provider without one;
 *   - `template-model` rules match `templateId` + `modelId` exactly;
 *   - `builtinProviderModelRules` match `providerId` + `modelId` exactly.
 *
 * Per rule only the `properties.contextWindow` leaf is folded: `undefined`
 * keeps the earlier value, `null` (or `properties: null`) resets it.
 *
 * The personal exact rules upstream appends last (`composeEffective`) are NOT
 * walked here — they are the caller's own rung (`modelContextWindow`), which
 * keeps "an explicit user value wins" in one place.
 *
 * Scope guard: the walk answers only for a provider the registry KNOWS — one
 * with a rule in the table or in the personal `provider_config.json`. The
 * table opens with a `.*` → 1,000,000 baseline, and a legacy
 * `config.json`-only provider never joins the registry: the backend keeps
 * enforcing its own number there, so answering for it would make the gauge
 * under-report usage fivefold.
 */

import { statSync } from "node:fs";

import { warn, zcodePersonalProviderPath } from "../utils.js";
import {
  accountProviderIdFor,
  configProviderIdFor,
  readBuiltinTable,
  readPersonalProviderRules,
  type BuiltinTable,
} from "./account-provider.js";

/** `properties.contextWindow` as a rule states it: undefined keeps, null resets. */
type WindowLeaf = number | null | undefined;

type CompiledRule =
  | { kind: "exact"; providerId: string; modelId: string; window: WindowLeaf }
  | { kind: "template"; templateId: string; modelId: string; window: WindowLeaf }
  | {
      kind: "pattern";
      model: RegExp;
      apiType?: RegExp;
      baseUrl?: RegExp;
      window: WindowLeaf;
    };

/** What the pattern guards of the walk test a provider against. */
interface ProviderInputs {
  templateId?: string;
  apiType?: string;
  baseUrl?: string;
}

interface Compiled {
  /** Both files' stat identities — the cache lives exactly as long as neither changed. */
  key: string;
  /** null when the table's model rules cannot be walked: every answer is then "none". */
  rules: CompiledRule[] | null;
  /** Registry provider id → inputs. A provider missing here is unknown to the registry. */
  providers: Map<string, ProviderInputs>;
  /** `<providerId>\0<modelId>` → answer, so the usage-delta path never re-walks. */
  answers: Map<string, number | null>;
}

type Api = { type?: string; baseUrl?: string };

const INVALID = Symbol("invalid");

const warned = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A table pattern as upstream matches it: anchored. Null when it does not compile. */
function pattern(value: unknown, flags: string): RegExp | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new RegExp(`^(?:${value})$`, flags);
  } catch {
    return null;
  }
}

/**
 * The rule's `properties.contextWindow` leaf; INVALID when the table does not
 * hold a positive integer where it holds one at all.
 */
function windowLeaf(config: unknown): WindowLeaf | typeof INVALID {
  if (config === undefined || config === null) return undefined;
  if (!isRecord(config)) return INVALID;
  const properties = config.properties;
  if (properties === undefined || properties === null) return properties;
  if (!isRecord(properties)) return INVALID;
  const value = properties.contextWindow;
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : INVALID;
}

/**
 * Compile the table's five model-rule groups into one ordered list. All or
 * nothing: any anomaly (a group that is not an array, a rule that is not an
 * object, a missing or malformed pattern, a non-positive window) makes the
 * whole set unusable, the same way upstream's strict schema rejects the entire
 * table — answering from a partial read of a drifted table could be wrong.
 */
function compileRules(table: BuiltinTable): { rules: CompiledRule[] | null; error?: string } {
  const groups: unknown = table.config?.modelConfigRules;
  if (groups === undefined) return { rules: [] };
  if (!isRecord(groups)) return { rules: null, error: "modelConfigRules is not an object" };
  const rules: CompiledRule[] = [];
  const bad = (group: string, what: string) => ({ rules: null, error: `${group}: ${what}` });
  for (const group of ["modelRules", "modelApiRules", "providerSiteRules"] as const) {
    const list = groups[group];
    if (!Array.isArray(list)) return bad(group, "not an array");
    for (const raw of list) {
      if (!isRecord(raw)) return bad(group, "a rule is not an object");
      const window = windowLeaf(raw.config);
      if (window === INVALID) return bad(group, "contextWindow is not a positive integer");
      const model = pattern(raw.modelMatch, "i");
      if (!model) return bad(group, "modelMatch is missing or malformed");
      if (group === "modelApiRules" && raw.apiTypeMatch === undefined)
        return bad(group, "apiTypeMatch is missing");
      if (group === "providerSiteRules" && raw.baseUrlMatch === undefined)
        return bad(group, "baseUrlMatch is missing");
      const apiType = raw.apiTypeMatch === undefined ? undefined : pattern(raw.apiTypeMatch, "");
      const baseUrl = raw.baseUrlMatch === undefined ? undefined : pattern(raw.baseUrlMatch, "");
      if (apiType === null || baseUrl === null) return bad(group, "a guard pattern is malformed");
      rules.push({ kind: "pattern", model, apiType, baseUrl, window });
    }
  }
  for (const group of ["templateModelRules", "builtinProviderModelRules"] as const) {
    const list = groups[group];
    if (!Array.isArray(list)) return bad(group, "not an array");
    for (const raw of list) {
      if (!isRecord(raw)) return bad(group, "a rule is not an object");
      const window = windowLeaf(raw.config);
      if (window === INVALID) return bad(group, "contextWindow is not a positive integer");
      const modelId = raw.modelId;
      if (typeof modelId !== "string" || !modelId) return bad(group, "modelId is missing");
      if (group === "templateModelRules") {
        const templateId = raw.templateId;
        if (typeof templateId !== "string" || !templateId)
          return bad(group, "templateId is missing");
        rules.push({ kind: "template", templateId, modelId, window });
      } else {
        const providerId = raw.providerId;
        if (typeof providerId !== "string" || !providerId)
          return bad(group, "providerId is missing");
        rules.push({ kind: "exact", providerId, modelId, window });
      }
    }
  }
  return { rules };
}

/** `ConfigOverlay.overlayConfig` for the api block: undefined keeps, null resets. */
function overlayApi(base: Api | null | undefined, next: Api | null | undefined): Api | undefined {
  if (next === undefined) return base ?? undefined;
  if (next === null || !base) return next ?? undefined;
  return { type: next.type ?? base.type, baseUrl: next.baseUrl ?? base.baseUrl };
}

/** A rule's api block; an ill-typed value counts as absent. */
function apiOf(config: unknown): Api | null | undefined {
  const api = (config as { api?: unknown } | null | undefined)?.api;
  if (api === undefined || api === null) return api;
  return isRecord(api) ? (api as Api) : undefined;
}

/**
 * The walk's per-provider inputs, as `ProviderConfigResolver.resolve` derives
 * them: a rule's own api block over its template's (a template fills what the
 * provider rule leaves out), `templateId` from the rule.
 */
function providerInputs(table: BuiltinTable | undefined): Map<string, ProviderInputs> {
  const out = new Map<string, ProviderInputs>();
  const templates = new Map<string, Api | null | undefined>();
  for (const rule of table?.config?.providerConfigRules?.templateRules ?? []) {
    if (typeof rule?.templateId === "string") templates.set(rule.templateId, apiOf(rule.config));
  }
  const inputs = (templateId: string | undefined, own: Api | null | undefined): ProviderInputs => {
    const api = templateId ? overlayApi(templates.get(templateId), own) : (own ?? undefined);
    return { templateId, apiType: api?.type, baseUrl: api?.baseUrl };
  };
  for (const rule of table?.config?.providerConfigRules?.providerRules ?? []) {
    const providerId = rule?.providerId;
    if (!providerId) continue;
    const templateId = rule.templateId || undefined;
    out.set(providerId, inputs(templateId, apiOf(rule.config)));
  }
  // A personal rule for an id the table already declares overlays that
  // provider and wins on every leaf it defines; any other personal rule stands
  // alone, on top of its own template when it names one.
  for (const rule of readPersonalProviderRules()) {
    const providerId = rule?.providerId;
    if (!providerId) continue;
    const templateId = rule.templateId || undefined;
    const own = apiOf(rule.config);
    const known = out.get(providerId);
    if (!known) {
      out.set(providerId, inputs(templateId, own));
      continue;
    }
    const api = overlayApi({ type: known.apiType, baseUrl: known.baseUrl }, own);
    out.set(providerId, {
      templateId: templateId ?? known.templateId,
      apiType: api?.type,
      baseUrl: api?.baseUrl,
    });
  }
  return out;
}

let cache: Compiled | null = null;

function compiled(): Compiled {
  const found = readBuiltinTable();
  let personalKey = "absent";
  try {
    const { ino, size, mtimeMs, ctimeMs } = statSync(zcodePersonalProviderPath());
    personalKey = `${ino}:${size}:${mtimeMs}:${ctimeMs}`;
  } catch {
    // no personal file — the table alone decides
  }
  const key = `${found?.key ?? "no-table"}\0${personalKey}`;
  if (cache?.key === key) return cache;
  let rules: CompiledRule[] | null = null;
  if (found) {
    const { rules: compiledRules, error } = compileRules(found.table);
    if (error === undefined) {
      rules = compiledRules;
    } else if (!warned.has(error)) {
      warned.add(error);
      warn(
        `registry-context-window: provider table model rules unusable ` +
          `(${error}) — registry context windows are unavailable, falling back`,
      );
    }
  }
  cache = { key, rules, providers: providerInputs(found?.table), answers: new Map() };
  return cache;
}

/** Upstream `normalizeBaseURLForRuleMatch`: host case, default port and trailing slashes do not matter. */
function normalizeBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    const suffix = `${parsed.search}${parsed.hash}`;
    const serialized = parsed.toString();
    const endpoint = suffix.length === 0 ? serialized : serialized.slice(0, -suffix.length);
    return `${endpoint.replace(/\/+$/, "")}${suffix}`;
  } catch {
    return undefined;
  }
}

function resolve(state: Compiled, providerId: string, modelId: string): number | null {
  if (!state.rules) return null;
  const input = state.providers.get(providerId);
  // A provider the registry does not know has no registry window (scope guard).
  if (!input) return null;
  const baseUrl = input.baseUrl == null ? undefined : normalizeBaseUrl(input.baseUrl);
  let contextWindow: WindowLeaf = undefined;
  for (const rule of state.rules) {
    if (rule.kind === "exact") {
      if (rule.providerId !== providerId || rule.modelId !== modelId) continue;
    } else if (rule.kind === "template") {
      if (rule.templateId !== input.templateId || rule.modelId !== modelId) continue;
    } else {
      if (!rule.model.test(modelId)) continue;
      if (rule.apiType && (input.apiType == null || !rule.apiType.test(input.apiType))) continue;
      if (rule.baseUrl && (baseUrl === undefined || !rule.baseUrl.test(baseUrl))) continue;
    }
    if (rule.window !== undefined) contextWindow = rule.window;
  }
  return typeof contextWindow === "number" ? contextWindow : null;
}

/**
 * The context window the registry assigns to `providerId` / `modelId`, or
 * null when it assigns none: an unknown provider, no table, a model no rule
 * gives a window, or an unusable table. Either provider dialect is accepted
 * (`account:…` and its `builtin:…` spelling answer the same).
 */
export function registryContextWindow(providerId: string, modelId: string): number | null {
  const memoKey = `${providerId}\0${modelId}`;
  const state = compiled();
  if (state.answers.has(memoKey)) return state.answers.get(memoKey) ?? null;
  const registryId = accountProviderIdFor(configProviderIdFor(providerId));
  const answer = resolve(state, registryId, modelId);
  state.answers.set(memoKey, answer);
  return answer;
}

/** Test seam: forget the compiled rules and the memoized answers. */
export function resetRegistryContextWindowForTests(): void {
  cache = null;
  warned.clear();
}
