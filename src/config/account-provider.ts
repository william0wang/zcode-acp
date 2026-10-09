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
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BUILTIN_PROVIDER_ENV, builtinProviderEnv } from "../backend/resolve.js";
import type { ZcodeBackend } from "../backend/client.js";
import { readCredentialConfig } from "./bridge-accounts.js";
import { log, warn, ZCODE_CREDS_PATH } from "../utils.js";

/** The bundled provider-table file the CLI boots from. */
const PROVIDER_CONFIG_NAME = "zcode-builtin.json";

/** One provider rule in the bundled table. */
interface BuiltinProviderRule {
  providerId: string;
  providerName?: string;
  config?: {
    group?: string;
    builtinModelIds?: string[];
    access?: { type?: string; mode?: string; accountType?: string };
  };
}

interface BuiltinTable {
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
export function builtinTablePath(): string | null {
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

function readBuiltinTable(): { table: BuiltinTable; file: string } | null {
  const file = builtinTablePath();
  if (!file) return null;
  try {
    return { table: JSON.parse(readFileSync(file, "utf8")) as BuiltinTable, file };
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
 * The plans the user actually holds, keyed by the LEGACY `builtin:<family>-<plan>`
 * id — the id every entitlement source below speaks.
 *
 * Three on-disk signals, unioned so any single one being stale still yields the
 * truth. Ranked by authority:
 *
 *   1. `coding-plan-cache.json` — the desktop's own availability verdict
 *      (`{items: {"builtin:bigmodel-coding-plan": {status:"available" | "unavailable"}}}`).
 *      Carries the resolved available/not-entitled decision, not a raw flag.
 *      Desktop-only, so a headless-only machine falls through.
 *   2. `setting.json` — what the user picked in the Settings UI
 *      (`modelProviderFamilySelectedKeys`: {"bigmodel":
 *      "coding-plan:builtin:bigmodel-coding-plan"}). This is the account plan
 *      binding; a family present here holds a plan.
 *   3. `config.json` (legacy CLI config) — `builtin:*` entries with
 *      `enabled:true` AND an apiKey. Still written by the app; the fallback.
 *
 * Verified 2026-09 against the desktop's own pushed account snapshot: this
 * derivation produced exactly its entitlement set (bigmodel individual true,
 * every zai/start/team plan false).
 */
function entitledBuiltinProviders(): Set<string> {
  const out = new Set<string>();
  const credsDir = path.dirname(ZCODE_CREDS_PATH);
  // 1) Desktop availability cache (authoritative: the resolved verdict).
  try {
    const cache = JSON.parse(
      readFileSync(path.join(credsDir, "coding-plan-cache.json"), "utf8"),
    ) as { entryStatus?: { items?: Record<string, { status?: string }> } };
    for (const [pid, entry] of Object.entries(cache.entryStatus?.items ?? {})) {
      if (entry?.status === "available") out.add(pid);
    }
  } catch {
    // cache absent/unreadable — the other sources decide
  }
  // 2) Legacy config.json (still the app's own provider enablement).
  try {
    const cfg = readCredentialConfig(ZCODE_CREDS_PATH) as {
      provider?: Record<string, { enabled?: boolean; options?: { apiKey?: string } }>;
    };
    for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
      if (!pid.startsWith("builtin:")) continue;
      if (p?.enabled === true && p.options?.apiKey) out.add(pid);
    }
  } catch {
    // unreadable config — the other sources decide
  }
  if (out.size > 0) return out;
  // 3) Last resort only (both sources above empty — a machine that has never
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
 * The request auth the bridge can serve for an `account:*` coding-plan model,
 * or null when it cannot answer.
 *
 * The 3.12+ backend asks its host for provider runtime headers before EVERY
 * model request on a `zhipu-account` provider (bundle-verified: the only other
 * suppliers are the desktop host and the CLI's own "standalone" credential
 * pair, whose identity half this machine never wrote — the api-key half sits
 * in the CLI's ENCRYPTED credential store, unreadable here). The desktop
 * answers with the plan's API key; the bridge can serve the same plan's key
 * from legacy config.json — the same key the pre-3.12 `builtin:` provider of
 * that plan used. Only the individual coding plan is served: start-plan needs
 * an Aliyun captcha (stays refused, issue #123), and team/off-peak keys are
 * store-encrypted.
 */
export function codingPlanRequestAuthFor(
  accountProviderId: string | undefined,
): { apiKey: string } | null {
  if (!accountProviderId?.startsWith("account:")) return null;
  const rule = readBuiltinTable()?.table.config?.providerConfigRules?.providerRules?.find(
    (r) => r.providerId === accountProviderId,
  );
  if (rule?.config?.access?.mode !== "individual-coding-plan") return null;
  const legacyId = configProviderIdFor(accountProviderId);
  if (legacyId === accountProviderId) return null;
  if (!entitledBuiltinProviders().has(legacyId)) return null;
  try {
    const cfg = readCredentialConfig(ZCODE_CREDS_PATH) as {
      provider?: Record<string, { enabled?: boolean; options?: { apiKey?: string } }>;
    };
    const apiKey = cfg.provider?.[legacyId]?.options?.apiKey?.trim();
    return apiKey ? { apiKey } : null;
  } catch {
    return null;
  }
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
