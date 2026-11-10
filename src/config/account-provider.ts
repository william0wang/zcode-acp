/**
 * Account-provider config: mirror the desktop host's
 * `provider/updateAccountConfig` push.
 *
 * 3.12+ app-servers build their provider registry from three sources: the
 * bundled `zcode-builtin.json` table, the personal `provider_config.json`, and
 * an ACCOUNT snapshot that the desktop host computes from the signed-in user's
 * plan state and pushes over `provider/updateAccountConfig`. Headless launches
 * have no host to push it, and standalone credential-derived entitlement
 * proved unreliable (2026-09: every `account:*` provider read `entitled:false`
 * while the desktop run of the same machine had
 * `account:bigmodel-individual-coding-plan` entitled — the GLM models the user's
 * config selects were missing from `settings.model.available` entirely, and
 * `session/setModel` failed with "Provider Registry 中不存在 Model").
 *
 * Pushing the snapshot ourselves restores parity: verified 2026-09, a push
 * turned `settings.model.available` from 3 third-party models into 21 including
 * `account:bigmodel-individual-coding-plan/GLM-5.3`, and the switch succeeded.
 *
 * The push needs the exact `basedOnZCodeBuiltinRevision` the runtime computed:
 * `zcode-builtin:<file.revision>:<sha256(resolve(activeConfigFilePath))>` (the
 * hash covers the PATH, not the bytes — verified against the runtime's own
 * logged revision). A mismatch is accepted by the schema but the registry
 * ignores it, so the path we hash must be the same one the CLI resolved.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCredentialStoreSync } from "../backend/credential-store.js";
import type { ZcodeBackend } from "../backend/client.js";
import { BUILTIN_PROVIDER_ENV, builtinProviderEnv } from "../backend/resolve.js";
import { log, warn, zcodePersonalProviderPath, ZCODE_CREDS_PATH } from "../utils.js";
import { bridgeOverlays, readCredentialConfig } from "./bridge-accounts.js";
import { type CodingPlanFamily, hasOAuthLogin, isCodingPlanFamily } from "./project-token.js";

/** The bundled provider-table file the CLI boots from. */
const PROVIDER_CONFIG_NAME = "zcode-builtin.json";

/** One provider rule in the bundled table. */
export interface BuiltinProviderRule {
  providerId: string;
  providerName?: string;
  config?: {
    group?: string;
    builtinModelIds?: string[];
    access?: { type?: string; mode?: string; accountType?: string };
    api?: { type?: string; baseUrl?: string };
  };
}

export interface BuiltinTable {
  revision?: number;
  config?: { providerConfigRules?: { providerRules?: BuiltinProviderRule[] } };
}

/**
 * Locate the built-in provider table — the process the backend will resolve to,
 * because `basedOnZCodeBuiltinRevision` hashes the PATH and the runtime rejects
 * a snapshot whose revision does not match its own.
 *
 * Order matters: the DERIVED injection first (that is the value `ensureBackend`
 * merges into the spawn env and therefore the path the CLI boots from), then
 * the ambient env as a fallback. Reading the ambient var first is wrong on a
 * desktop-attached host: it points at a version-keyed `runtime/provider/…`
 * copy, and hashing that path yields a revision the backend rejects
 * (verified 2026-09 — the push reported "received" but entitlement never
 * applied, switch stayed "Provider Registry 中不存在 Model").
 */
function builtinTablePath(): string | null {
  const injected = builtinProviderEnv()[BUILTIN_PROVIDER_ENV];
  if (injected) return injected;
  const fromEnv = process.env[BUILTIN_PROVIDER_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const bundled =
    process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
          "Programs",
          "ZCode",
          "resources",
          "config",
          "provider",
          PROVIDER_CONFIG_NAME,
        )
      : "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json";
  return existsSync(bundled) ? bundled : null;
}

let tableCache: { key: string; table: BuiltinTable } | null = null;

/**
 * The parsed table, memoized by path, inode, size, mtime, and ctime. The
 * runtime-headers path reads it several times before every model request, and
 * the file is ~180 KB. Inode and ctime catch a same-size rewrite or rename
 * that keeps the mtime, because utimes cannot set ctime.
 */
export function readBuiltinTable(): { table: BuiltinTable; file: string } | null {
  const file = builtinTablePath();
  if (!file) return null;
  try {
    const { ino, size, mtimeMs, ctimeMs } = statSync(file);
    const key = `${file}\0${ino}:${size}:${mtimeMs}:${ctimeMs}`;
    if (tableCache?.key !== key) {
      const table = JSON.parse(readFileSync(file, "utf8")) as BuiltinTable;
      tableCache = { key, table };
    }
    return { table: tableCache.table, file };
  } catch (e) {
    warn(
      `account-provider: unreadable provider table (${e instanceof Error ? e.message : String(e)})`,
    );
    return null;
  }
}

/**
 * The revision the runtime derives for the bundled table:
 * `zcode-builtin:<revision>:<sha256(path)>`. The hash is over the resolved
 * PATH (verified against the runtime's logged `configRevision`), so it must be
 * computed from the exact path we hand the backend.
 */
function builtinRevision(file: string, revision: number | undefined): string {
  const hash = createHash("sha256").update(path.resolve(file)).digest("hex");
  return `zcode-builtin:${revision ?? 0}:${hash}`;
}

/**
 * Map a config.json builtin provider id to the account-provider id the
 * registry actually exposes. `builtin:<family>-coding-plan` is the
 * individual-plan spelling in config.json, while the table names it
 * `account:<family>-individual-coding-plan`; other plan spellings match
 * one-to-one. Unknown ids pass through unchanged.
 */
export function accountProviderIdFor(providerId: string): string {
  if (!providerId.startsWith("builtin:")) return providerId;
  const rules =
    readBuiltinTable()?.table.config?.providerConfigRules?.providerRules?.filter(
      (r) => r.config?.access?.type === "zhipu-account",
    ) ?? [];
  const slug = providerId.slice("builtin:".length); // e.g. "bigmodel-coding-plan"
  // "<family>-<plan>" — split on the FIRST dash so multi-hyphen families survive.
  const dash = slug.indexOf("-");
  if (dash <= 0) return providerId;
  const family = slug.slice(0, dash);
  let plan = slug.slice(dash + 1); // "coding-plan" | "start-plan"
  if (plan === "coding-plan") plan = "individual-coding-plan";
  const hit = rules.find(
    (r) => r.config?.access?.accountType === family && r.config?.access?.mode === plan,
  );
  return hit?.providerId ?? providerId;
}

/** Reverse map: account-provider id → the config.json id it corresponds to. */
export function configProviderIdFor(providerId: string): string {
  if (!providerId.startsWith("account:")) return providerId;
  const rule = readBuiltinTable()?.table.config?.providerConfigRules?.providerRules?.find(
    (r) => r.providerId === providerId,
  );
  const family = rule?.config?.access?.accountType;
  const mode = rule?.config?.access?.mode;
  if (family && mode) {
    const plan = mode === "individual-coding-plan" ? "coding-plan" : mode;
    return `builtin:${family}-${plan}`;
  }
  // Table-absent fallback (headless Linux: no desktop app bundle to read).
  // The pairs are frozen upstream (session-store migration 0020 +
  // legacy-model-provider-identity.ts; the table's zhipu rules also spell
  // `account:<f>-start-plan`): `account:<f>-start-plan` →
  // `builtin:<f>-start-plan`, and `account:<f>-[(individual|team)-]coding-plan`
  // → `builtin:<f>-coding-plan` (team shares the family's legacy key — it has
  // no builtin spelling of its own). Unknown shapes (off-peak, custom ids)
  // pass through unchanged so model-limit lookups keep working without the
  // table.
  const m = /^account:([a-z0-9]+)-(start-plan|(?:individual-|team-)?coding-plan)$/.exec(providerId);
  if (m) return `builtin:${m[1]}-${m[2] === "start-plan" ? "start-plan" : "coding-plan"}`;
  return providerId;
}

/**
 * The decrypted api-key for an INDIVIDUAL coding plan from the encrypted
 * credential store (`account-provider:coding-plan:account:<plan>:account:<uid>:
 * api-key` — the uid segment is the signed-in account), or null when the store
 * holds no such entry.
 *
 * Team keys are deliberately not served: the store keeps a team api-key even
 * when the desktop's own snapshot says the team plan is not entitled
 * (observed 2026-10: both keys present, desktop verdict individual=true /
 * team=false) — key presence over-claims — and a team request additionally
 * needs organization/project headers this bridge cannot source.
 */
function storeIndividualCodingPlanKey(accountProviderId: string): string | null {
  const slug = accountProviderId.slice("account:".length);
  if (!slug.endsWith("-individual-coding-plan")) return null;
  const prefix = `account-provider:coding-plan:account:${slug}:account:`;
  for (const [key, value] of Object.entries(readCredentialStoreSync())) {
    if (key.startsWith(prefix) && key.endsWith(":api-key")) {
      const apiKey = value.trim();
      return apiKey || null;
    }
  }
  return null;
}

/**
 * The decrypted `zcodejwttoken` from the encrypted credential store — the
 * Start Plan bearer JWT the 3.15+ desktop host serves for `account:*-start-plan`
 * over `interaction/requestProviderRuntimeHeaders` (`AccountProviderRequestAuthService.resolveCurrent`).
 */
const ZCODE_JWT_CREDENTIAL_KEY = "zcodejwttoken";
const OAUTH_ACTIVE_PROVIDER_KEY = "oauth:active_provider";

function storeStartPlanJwt(): string | null {
  return readCredentialStoreSync()[ZCODE_JWT_CREDENTIAL_KEY]?.trim() || null;
}

/**
 * The plans the user actually holds, keyed by the LEGACY `builtin:<family>-<plan>`
 * id — the id every entitlement source below speaks.
 *
 * On-disk signals, ranked by authority:
 *
 *   1. `config.json` (legacy CLI config) — `builtin:*` entries with
 *      `enabled:true` AND an apiKey. Still written by the app.
 *      (`coding-plan-cache.json`, the 3.12–3.14 desktop's availability
 *      verdict, is deliberately NOT read: those were transitional releases,
 *      and a leftover cache surviving a 3.15+ upgrade would suppress the
 *      OAuth union below — #359.)
 *   2. The encrypted credential store (#320) — a fresh desktop-only install
 *      writes no config.json; its plan api-keys live only in
 *      `~/.zcode/v2/credentials.json`. Weaker evidence than enablement (the
 *      store also keeps keys for plans the account does not currently hold),
 *      so it only speaks when no verdict-bearing source said anything at all,
 *      and only for individual plans (see storeIndividualCodingPlanKey).
 *   3. `setting.json` — last resort: the Settings UI's remembered pick per
 *      family. A SELECTION record, not an entitlement. The 3.15+ spelling
 *      (`providerFamilyConnectionSelections`, an individual coding plan
 *      backed by an OAuth sign-in in the store) is stronger than a mere pick:
 *      it names the connection the desktop CURRENTLY runs, and both of its
 *      signals only exist on a 3.15+ layout — so it is also UNIONED with the
 *      sources above UNCONDITIONALLY: no older on-disk signal can speak
 *      against it, and a leftover config.json entry for another family must
 *      not hide the active OAuth plan (its request auth project-token.ts
 *      mints on demand).
 *
 * Bridge accounts (`acp-accounts.json`, written by `zcode-acp setup`) sit
 * above the whole ladder: an explicit user key entitles its family's
 * individual coding plan, because deliberate user input beats any stale
 * on-disk signal. Only families the credential overlay applied count (see
 * bridgeOverlays), so a family whose installed catalog is unusable gains
 * nothing. They never count as a verdict, so an account for one family
 * leaves source 2 open for the other.
 *
 * Manual plan keys from provider_config.json (`zhipu-coding-plan-api-key`
 * rules, #344) sit at the source-1 tier — see manualCodingPlanKeys below.
 *
 * Verified 2026-09/10 against the desktop's own pushed account snapshot and
 * a real credential store.
 */
/**
 * Manual coding-plan api keys from provider_config.json (#344).
 *
 * The desktop's Settings → Model Provider → "Use API key" flow writes the plan
 * key as a personal rule with access type `zhipu-coding-plan-api-key`, while
 * an OAuth login writes NO legacy config.json key at all — so a 3.12+
 * desktop-only machine had no entitlement source the ladder above could read:
 * every account model switch failed with "Provider Registry 中不存在 Model"
 * and the reporter had to copy the key into config.json by hand. These rules
 * are the same tier as config.json's builtin entries — an explicit user key,
 * not an enablement signal — so they ADD to the ladder without arming
 * sawVerdict, and a config.json disable on the same family does not suppress
 * them.
 *
 * The family comes from the rule's api.baseUrl (the official coding-plan
 * endpoints; the rule id itself — e.g. `zai-api` — is user-chosen and carries
 * no family promise). Upstream plans to fold this access type back into
 * plain `api-key` (todo-157, domain-gated) — matching then moves to the
 * baseUrl alone, which this already reads.
 */
function manualCodingPlanKeys(): Map<string, string> {
  const families = codingPlanFamiliesByBaseUrl();
  const out = new Map<string, string>();
  for (const rule of readPersonalProviderRules()) {
    if (rule.enabled === false) continue;
    if (rule.config?.access?.type !== "zhipu-coding-plan-api-key") continue;
    const apiKey = rule.config.access.apiKey?.trim();
    const baseUrl = rule.config.api?.baseUrl?.replace(/\/+$/, "");
    const family = baseUrl ? families.get(baseUrl) : undefined;
    if (!apiKey || !family) continue;
    out.set(`builtin:${family}-coding-plan`, apiKey);
  }
  return out;
}

/** A provider rule in the desktop's personal provider_config.json (3.12+). */
interface PersonalProviderRule {
  providerId?: string;
  enabled?: boolean;
  config?: {
    access?: { type?: string; apiKey?: string };
    api?: { baseUrl?: string };
  };
}

let personalRulesCache: { key: string; rules: PersonalProviderRule[] } | null = null;

/**
 * Personal provider rules, memoized by the same stat key as the builtin table
 * — the runtime-headers path re-reads these before every model request.
 */
function readPersonalProviderRules(): PersonalProviderRule[] {
  const file = zcodePersonalProviderPath();
  try {
    const { ino, size, mtimeMs, ctimeMs } = statSync(file);
    const key = `${file}\0${ino}:${size}:${mtimeMs}:${ctimeMs}`;
    if (personalRulesCache?.key !== key) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        config?: { providerConfigRules?: { providerRules?: PersonalProviderRule[] } };
      };
      personalRulesCache = { key, rules: parsed.config?.providerConfigRules?.providerRules ?? [] };
    }
    return personalRulesCache.rules;
  } catch {
    return []; // absent (pre-3.12 desktop / hermetic HOME) — nothing to add
  }
}

/**
 * baseUrl → family for the OFFICIAL individual coding-plan endpoints. Derived
 * from the installed table (a zhipu-account rule's api.baseUrl IS its family's
 * coding-plan endpoint), with the frozen official pair as the table-absent
 * fallback (headless Linux): api.z.ai → zai, open.bigmodel.cn → bigmodel —
 * the same endpoints the shipped table carries.
 */
function codingPlanFamiliesByBaseUrl(): Map<string, string> {
  const out = new Map<string, string>([
    ["https://api.z.ai/api/anthropic", "zai"],
    ["https://open.bigmodel.cn/api/anthropic", "bigmodel"],
  ]);
  for (const rule of readBuiltinTable()?.table.config?.providerConfigRules?.providerRules ?? []) {
    if (rule.config?.access?.type !== "zhipu-account") continue;
    if (rule.config?.access?.mode !== "individual-coding-plan") continue;
    const family = rule.config?.access?.accountType;
    const baseUrl = rule.config?.api?.baseUrl?.replace(/\/+$/, "");
    if (family && baseUrl) out.set(baseUrl, family);
  }
  return out;
}

function entitledBuiltinProviders(): Set<string> {
  const out = desktopEntitledBuiltinProviders();
  for (const family of Object.keys(bridgeOverlays())) out.add(`builtin:${family}-coding-plan`);
  for (const legacyId of manualCodingPlanKeys().keys()) out.add(legacyId);
  return out;
}

/**
 * Coding-plan families whose 3.15+ desktop connection is an active OAuth
 * individual coding plan (`setting.json` `providerFamilyConnectionSelections`
 * + an `oauth:<family>:access_token` in the credential store, not switched to
 * `apiKey` mode in `modelProviderFamilyModes`).
 */
function oauthSelectedCodingPlanFamilies(
  credsDir = path.dirname(ZCODE_CREDS_PATH),
): Set<CodingPlanFamily> {
  const out = new Set<CodingPlanFamily>();
  try {
    const setting = JSON.parse(readFileSync(path.join(credsDir, "setting.json"), "utf8")) as {
      modelProviderFamilyModes?: Record<string, unknown>;
      providerFamilyConnectionSelections?: Record<string, { kind?: unknown } | null>;
    };
    for (const [family, selection] of Object.entries(
      setting.providerFamilyConnectionSelections ?? {},
    )) {
      if (selection?.kind !== "individual-coding-plan") continue;
      if (setting.modelProviderFamilyModes?.[family] === "apiKey") continue;
      if (!isCodingPlanFamily(family) || !hasOAuthLogin(family)) continue;
      out.add(family);
    }
  } catch {
    // setting.json absent (headless-only) — nothing to infer
  }
  return out;
}

/**
 * Families whose 3.15+ desktop OAuth sign-in entitles Start Plan (`zcodejwttoken`
 * + `oauth:<family>:access_token` in the credential store, not switched to
 * `apiKey` mode in `modelProviderFamilyModes`).
 *
 * When `setting.json` or the store names an active/selected family
 * (`providerFamilyDomain`, `providerFamilyConnectionSelections`, or
 * `oauth:active_provider`), only those families are candidates because
 * `zcodejwttoken` is a single store key belonging to the active OAuth session;
 * when none is named (minimal store fixture), any family with an OAuth login
 * qualifies.
 */
function oauthEntitledStartPlanFamilies(
  credsDir = path.dirname(ZCODE_CREDS_PATH),
): Set<CodingPlanFamily> {
  const out = new Set<CodingPlanFamily>();
  if (!storeStartPlanJwt()) return out;
  let modes: Record<string, unknown> | undefined;
  const candidates = new Set<CodingPlanFamily>();
  let sawExplicitFamily = false;
  try {
    const setting = JSON.parse(readFileSync(path.join(credsDir, "setting.json"), "utf8")) as {
      modelProviderFamilyModes?: Record<string, unknown>;
      providerFamilyDomain?: unknown;
      providerFamilyConnectionSelections?: Record<string, { kind?: unknown } | null>;
    };
    modes = setting.modelProviderFamilyModes;
    if (
      typeof setting.providerFamilyDomain === "string" &&
      isCodingPlanFamily(setting.providerFamilyDomain)
    ) {
      sawExplicitFamily = true;
      candidates.add(setting.providerFamilyDomain);
    }
    for (const [family, selection] of Object.entries(
      setting.providerFamilyConnectionSelections ?? {},
    )) {
      if (selection?.kind !== "individual-coding-plan" && selection?.kind !== "start-plan") {
        continue;
      }
      if (!isCodingPlanFamily(family)) continue;
      sawExplicitFamily = true;
      candidates.add(family);
    }
  } catch {
    // setting.json absent (headless-only) — fall through to store
  }
  const activeProvider = readCredentialStoreSync()[OAUTH_ACTIVE_PROVIDER_KEY]?.trim();
  if (activeProvider && isCodingPlanFamily(activeProvider)) {
    sawExplicitFamily = true;
    candidates.add(activeProvider);
  }
  if (!sawExplicitFamily) {
    candidates.add("zai");
    candidates.add("bigmodel");
  }
  for (const family of candidates) {
    if (modes?.[family] === "apiKey") continue;
    if (!hasOAuthLogin(family)) continue;
    out.add(family);
  }
  return out;
}

/** Sources 1-3 above, read from the raw desktop files only. */
function desktopEntitledBuiltinProviders(): Set<string> {
  const out = new Set<string>();
  const credsDir = path.dirname(ZCODE_CREDS_PATH);
  let sawVerdict = false;
  // 1) Legacy config.json (still the app's own provider enablement).
  try {
    const cfg = JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8")) as {
      provider?: Record<string, { enabled?: boolean; options?: { apiKey?: string } }>;
    };
    let builtinEntries = 0;
    for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
      if (!pid.startsWith("builtin:")) continue;
      builtinEntries += 1;
      if (p?.enabled === true && p.options?.apiKey) out.add(pid);
    }
    if (builtinEntries > 0) sawVerdict = true;
  } catch {
    // unreadable config — the other sources decide
  }
  // The 3.15+ OAuth selection (`providerFamilyConnectionSelections` + an
  // OAuth login in the store) is UNIONED unconditionally: both signals only
  // exist on a 3.15+ layout, so no older on-disk signal can speak against
  // it — and a leftover config.json entry for another family must not hide
  // the active OAuth family (#357). The 3.12–3.14 availability cache is
  // deliberately not consulted (transitional releases; a leftover cache
  // surviving a 3.15+ upgrade would suppress this union — #359).
  for (const family of oauthSelectedCodingPlanFamilies(credsDir)) {
    out.add(`builtin:${family}-coding-plan`);
  }
  for (const family of oauthEntitledStartPlanFamilies(credsDir)) {
    out.add(`builtin:${family}-start-plan`);
  }
  if (out.size > 0) return out;
  // 2) Fresh desktop-only layout (#320): no verdict-bearing source spoke, but
  //    the encrypted store holds the account's individual plan key.
  if (!sawVerdict) {
    const rules =
      readBuiltinTable()?.table.config?.providerConfigRules?.providerRules?.filter(
        (r) => r.config?.access?.type === "zhipu-account",
      ) ?? [];
    for (const rule of rules) {
      if (rule.config?.access?.mode !== "individual-coding-plan") continue;
      if (storeIndividualCodingPlanKey(rule.providerId)) {
        out.add(configProviderIdFor(rule.providerId));
      }
    }
  }
  if (out.size > 0) return out;
  // 3) Last resort only (everything above empty — a machine that has never
  //    written them): the Settings UI's remembered pick per family. This is a
  //    SELECTION record, not an entitlement — `zai` sitting there means the
  //    user opened that family's picker, not that the plan is held (observed
  //    2026-09: it named an unentitled zai plan). Never union it with the
  //    authoritative sources above.
  try {
    const setting = JSON.parse(readFileSync(path.join(credsDir, "setting.json"), "utf8")) as {
      modelProviderFamilySelectedKeys?: Record<string, string>;
    };
    for (const selected of Object.values(setting.modelProviderFamilySelectedKeys ?? {})) {
      const m = /(builtin:[a-z0-9-]+)/.exec(selected);
      if (m) out.add(m[1]!);
    }
  } catch {
    // setting.json absent (headless-only) — nothing to infer
  }
  return out;
}

/**
 * Dropdown entries for the entitled individual coding plans, straight from the
 * bundled table: the models a desktop-only layout with no config.json (3.15+
 * after an OAuth sign-in) can actually run. Without them the dropdown fell
 * back to the fresh-install BigModel default, which an account entitled to
 * another family cannot use ("Select a model before continuing").
 */
export function entitledCodingPlanModels(): Array<{
  providerId: string;
  providerName: string;
  modelId: string;
}> {
  const rules =
    readBuiltinTable()?.table.config?.providerConfigRules?.providerRules?.filter(
      (r) =>
        r.config?.access?.type === "zhipu-account" &&
        (r.config.access.mode === "individual-coding-plan" ||
          r.config.access.mode === "start-plan"),
    ) ?? [];
  if (rules.length === 0) return [];
  const entitled = entitledBuiltinProviders();
  const out: Array<{ providerId: string; providerName: string; modelId: string }> = [];
  for (const rule of rules) {
    const providerId = configProviderIdFor(rule.providerId);
    if (!entitled.has(providerId)) continue;
    for (const modelId of rule.config?.builtinModelIds ?? []) {
      out.push({ providerId, providerName: rule.providerName ?? providerId, modelId });
    }
  }
  return out;
}

/**
 * The family whose OAuth sign-in can mint request auth for `accountProviderId`
 * (an entitled individual coding plan with no static key anywhere), or null.
 * Checked only after `codingPlanRequestAuthFor` found no key, so a bridge
 * account, config.json, a manual key or a stored plan key always wins.
 */
export function oauthProjectTokenFamilyFor(
  accountProviderId: string | undefined,
): CodingPlanFamily | null {
  const legacyId = entitledIndividualPlanLegacyId(accountProviderId);
  const family = legacyId ? /^builtin:([a-z0-9]+)-coding-plan$/u.exec(legacyId)?.[1] : undefined;
  if (!family || !isCodingPlanFamily(family) || !hasOAuthLogin(family)) return null;
  return family;
}

/**
 * The legacy `builtin:<family>-coding-plan` id of `accountProviderId` when it
 * is an INDIVIDUAL coding plan the account ladder entitles, else null — the
 * shared gate of every request-auth source (static keys and the OAuth
 * project-token exchange alike).
 */
function entitledIndividualPlanLegacyId(accountProviderId: string | undefined): string | null {
  if (!accountProviderId?.startsWith("account:")) return null;
  const rule = readBuiltinTable()?.table.config?.providerConfigRules?.providerRules?.find(
    (r) => r.providerId === accountProviderId,
  );
  const individual =
    rule?.config?.access?.mode === "individual-coding-plan" ||
    (!rule && accountProviderId.endsWith("-individual-coding-plan"));
  if (!individual) return null;
  const legacyId = configProviderIdFor(accountProviderId);
  if (legacyId === accountProviderId) return null;
  return entitledBuiltinProviders().has(legacyId) ? legacyId : null;
}

/**
 * The request auth the bridge can serve for an `account:*` coding-plan model,
 * or null when it cannot answer.
 *
 * The 3.12+ backend asks its host for provider runtime headers before EVERY
 * model request on a `zhipu-account` provider (bundle-verified: the only other
 * suppliers are the desktop host and the CLI's own "standalone" credential
 * pair, whose identity half this machine never wrote). The desktop answers
 * with the plan's API key; the bridge serves the same plan's key from
 * whichever source is CURRENT: a manual key in provider_config.json (3.12+,
 * #344) outranks the frozen legacy config.json, and a fresh desktop-only
 * install writes no config.json at all — its plan key lives only in the
 * encrypted credential store (#320). Only the individual coding plan is
 * served: start-plan needs an Aliyun captcha (stays refused, issue #123), and
 * team keys are not entitlement evidence (see storeIndividualCodingPlanKey).
 */
export function codingPlanRequestAuthFor(
  accountProviderId: string | undefined,
): { apiKey: string } | null {
  const legacyId = entitledIndividualPlanLegacyId(accountProviderId);
  if (!legacyId || !accountProviderId) return null;
  const family = /^builtin:([a-z0-9]+)-coding-plan$/u.exec(legacyId)?.[1];
  // 1) Explicit bridge account (`zcode-acp setup`) always wins, even over a
  //    3.15+ OAuth sign-in.
  if (family && isCodingPlanFamily(family)) {
    const bridgeKey = bridgeOverlays()[family]?.apiKey?.trim();
    if (bridgeKey) return { apiKey: bridgeKey };
  }
  // 2) The desktop's own manual plan key (#344): 3.12+ writes it to
  //    provider_config.json, never config.json — a `zhipu-coding-plan-api-key`
  //    rule can only exist on a 3.12+ layout, where config.json is frozen at
  //    its pre-3.12 state. Rank it ABOVE that frozen file (and above the
  //    3.15+ OAuth exchange: an explicit key the user typed beats the login),
  //    but below the bridge's own setups.
  const manual = manualCodingPlanKeys().get(legacyId);
  if (manual) return { apiKey: manual };
  // When 3.15+ `setting.json` selects this family's individual coding plan in
  // OAuth mode (backed by an `oauth:<family>:access_token` in the store), any
  // static key left in pre-3.12 `config.json` or pre-3.15 `credentials.json`
  // is a stale pre-upgrade artifact (3.12+ stopped writing `config.json`, and
  // 3.15+ switched OAuth plans to short-lived project tokens). Skip those so
  // `answerProviderRuntimeHeaders` falls through to `resolveOAuthProjectToken`.
  const oauthActive =
    Boolean(family && isCodingPlanFamily(family)) &&
    oauthSelectedCodingPlanFamilies().has(family as CodingPlanFamily);
  if (!oauthActive) {
    try {
      const cfg = readCredentialConfig(ZCODE_CREDS_PATH) as {
        provider?: Record<string, { enabled?: boolean; options?: { apiKey?: string } }>;
      };
      const apiKey = cfg.provider?.[legacyId]?.options?.apiKey?.trim();
      if (apiKey) return { apiKey };
    } catch {
      // unreadable/absent config — the store decides
    }
  }
  if (oauthActive) return null;
  const stored = storeIndividualCodingPlanKey(accountProviderId);
  return stored ? { apiKey: stored } : null;
}

/**
 * The legacy `builtin:<family>-start-plan` id of `accountProviderId` when it is
 * a Start Plan provider the account ladder entitles, else null.
 */
function entitledStartPlanLegacyId(accountProviderId: string | undefined): string | null {
  if (!accountProviderId?.startsWith("account:")) return null;
  const rule = readBuiltinTable()?.table.config?.providerConfigRules?.providerRules?.find(
    (r) => r.providerId === accountProviderId,
  );
  const isStartPlan =
    rule?.config?.access?.mode === "start-plan" ||
    (!rule && accountProviderId.endsWith("-start-plan"));
  if (!isStartPlan) return null;
  const legacyId = configProviderIdFor(accountProviderId);
  if (legacyId === accountProviderId) return null;
  return entitledBuiltinProviders().has(legacyId) ? legacyId : null;
}

/**
 * The request auth the bridge can serve for an `account:<family>-start-plan`
 * model, or null when it cannot answer.
 *
 * Since 0.17.x (the request-security edition stubs `requiresRequestVerification()`
 * to `false`, so the host answers Start Plan without interaction — the remote
 * client-config captcha flag is never read), the desktop host
 * (`AccountProviderRequestAuthService.resolveCurrent` +
 * `respondAccountRequestAuthWithoutInteraction`) answers Start Plan model
 * requests directly with `{ apiKey: zcodeJwtToken }` from `credentials.json`.
 * When 3.15+ OAuth Start Plan is active,
 * any stale pre-3.12 `config.json` key is skipped so the fresh store JWT wins.
 */
export function startPlanRequestAuthFor(
  accountProviderId: string | undefined,
): { apiKey: string } | null {
  const legacyId = entitledStartPlanLegacyId(accountProviderId);
  if (!legacyId) return null;
  const family = /^builtin:([a-z0-9]+)-start-plan$/u.exec(legacyId)?.[1];
  const oauthActive =
    Boolean(family && isCodingPlanFamily(family)) &&
    oauthEntitledStartPlanFamilies().has(family as CodingPlanFamily);
  if (!oauthActive) {
    try {
      const cfg = readCredentialConfig(ZCODE_CREDS_PATH) as {
        provider?: Record<string, { enabled?: boolean; options?: { apiKey?: string } }>;
      };
      const apiKey = cfg.provider?.[legacyId]?.options?.apiKey?.trim();
      if (apiKey) return { apiKey };
    } catch {
      // unreadable/absent config — the store decides
    }
  }
  const jwt = storeStartPlanJwt();
  return jwt ? { apiKey: jwt } : null;
}

/**
 * Whether any usable ZCode credential exists — the `authenticate` method's
 * readiness check (#344). True when a manual coding-plan key sits in
 * provider_config.json, a bridge account is saved, the merged config.json
 * view holds any provider key, or the desktop ladder found an entitlement.
 * False means the editor user gets the actionable sign-in error instead of a
 * silent success that dies on the first turn.
 */
export function zcodeCredentialsPresent(): boolean {
  if (manualCodingPlanKeys().size > 0) return true;
  if (Object.keys(bridgeOverlays()).length > 0) return true;
  try {
    const cfg = readCredentialConfig(ZCODE_CREDS_PATH) as {
      provider?: Record<string, { options?: { apiKey?: string } }>;
    };
    for (const entry of Object.values(cfg.provider ?? {})) {
      if (entry?.options?.apiKey?.trim()) return true;
    }
  } catch {
    // unreadable desktop config — the ladder below still speaks
  }
  return desktopEntitledBuiltinProviders().size > 0;
}

/** The `provider/updateAccountConfig` payload (schema-verified shape). */ export interface AccountProviderPayload {
  revision: string;
  basedOnZCodeBuiltinRevision: string;
  providers: Record<
    string,
    { builtinModelIds?: string[]; access: { type: string; entitled: boolean } }
  >;
  states: Record<
    string,
    {
      availability: "available" | "pending" | "unavailable" | "unknown";
      entitled: boolean;
      current: boolean;
    }
  >;
}

/**
 * Build the account snapshot: every coding-plan provider the bundled table
 * declares, with entitlement taken from config.json's enabled builtin plans.
 * Returns null when there is nothing to push (no table, no zhipu providers).
 */
export function buildAccountProviderConfig(): AccountProviderPayload | null {
  const found = readBuiltinTable();
  if (!found) return null;
  const rules =
    found.table.config?.providerConfigRules?.providerRules?.filter(
      (r) => r.config?.access?.type === "zhipu-account",
    ) ?? [];
  if (rules.length === 0) return null;
  const enabled = entitledBuiltinProviders();
  const providers: AccountProviderPayload["providers"] = {};
  const states: AccountProviderPayload["states"] = {};
  for (const rule of rules) {
    const entitled = enabled.has(configProviderIdFor(rule.providerId));
    providers[rule.providerId] = {
      builtinModelIds: rule.config?.builtinModelIds,
      access: { type: "zhipu-account", entitled },
    };
    states[rule.providerId] = {
      availability: entitled ? "available" : "unavailable",
      entitled,
      current: entitled,
    };
  }
  return {
    revision: `account:bridge:${Date.now()}`,
    basedOnZCodeBuiltinRevision: builtinRevision(found.file, found.table.revision),
    providers,
    states,
  };
}

/**
 * Push the account snapshot to the backend. Best-effort: a failure logs and
 * returns false — session creation must proceed regardless (the account
 * providers simply stay absent from the model dropdown). A backend that does
 * not know the method (older CLI) is a quiet no-op, not a warning.
 */
export async function pushAccountProviderConfig(
  backend: ZcodeBackend,
  nextId: () => number,
): Promise<boolean> {
  const payload = buildAccountProviderConfig();
  if (!payload) return false;
  try {
    const resp = await backend.request(
      nextId(),
      "provider/updateAccountConfig",
      payload as unknown as Record<string, unknown>,
      10000,
    );
    if (resp.error) {
      if (resp.error.code === -32601) {
        log("account-provider: backend has no provider/updateAccountConfig (old CLI) — skipped");
      } else {
        warn(`account-provider: push failed: ${resp.error.message}`);
      }
      return false;
    }
    const result = (resp.result ?? {}) as { providerCount?: number; status?: string };
    log(
      `account-provider: pushed ${result.providerCount ?? Object.keys(payload.providers).length} provider(s) (${result.status ?? "ok"})`,
    );
    return true;
  } catch (e) {
    warn(`account-provider: push threw: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
