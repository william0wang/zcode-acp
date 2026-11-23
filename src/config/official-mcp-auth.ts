/**
 * Auth-header construction and trusted-origin validation for ZCode official
 * plugin MCP servers (`auth: { type: "zcode_official", provider: "jwt_token" }`).
 *
 * Protocol-aligned with the ZCode desktop's `officialMcpCredentials.ts`:
 * - `targetOrigin` must match the authoritative ZCode API origin (credentials
 *   must never leak to an untrusted domain);
 * - reads `zcodejwttoken` (-> `Authorization: Bearer ...`) and the active
 *   Coding Plan family's MaaS login JWT `oauth:<family>:access_token`
 *   (-> `X-Bigmodel-Authorization: Bearer ...` plus scope headers) from the
 *   local encrypted credential store;
 * - team plans follow the upstream wire rules: a bigmodel team sends
 *   `Bigmodel-Target-Type: TEAM` with organization/project as an atomic pair,
 *   a zai team sends the plan token with NO scope headers;
 * - token values must NEVER appear in logs.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { readCredentialStoreSync } from "../backend/credential-store.js";
import { ZCODE_CREDS_PATH } from "../utils.js";
import { isCodingPlanFamily, type CodingPlanFamily } from "./project-token.js";

/** Default production ZCode service origin, used for plugin `${ZCODE_BASE_URL}` expansion and origin trust. */
export const DEFAULT_ZCODE_BASE_URL = "https://zcode.z.ai";

/** Official MCP auth header names (aligned with ZCode `OFFICIAL_MCP_AUTH_HEADER_NAMES`). */
export const OFFICIAL_MCP_AUTH_HEADER_NAMES = {
  authorization: "Authorization",
  codingPlanAuthorization: "X-Bigmodel-Authorization",
  targetType: "Bigmodel-Target-Type",
  organization: "Bigmodel-Organization",
  project: "Bigmodel-Project",
} as const;

/** Official MCP auth failure reasons (aligned with the `interaction/requestOfficialMcpAuthHeaders` reply schema in `zcode.cjs`). */
export type OfficialMcpAuthFailureReason =
  | "official_auth_unavailable"
  | "official_auth_plan_required"
  | "official_mcp_origin_untrusted";

/** The reply shape for `interaction/requestOfficialMcpAuthHeaders`. */
export type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * The scope headers a coding plan adds on the wire (mirrors upstream
 * `OfficialMcpWireScope`): an individual plan sends only the target type, a
 * bigmodel team adds organization/project as an atomic pair, and a zai team
 * sends no scope headers at all (plan token only, `null` here).
 */
type OfficialMcpWireScope =
  | { targetType: "PERSONAL" }
  | { targetType: "TEAM"; organizationId: string; projectId: string }
  | null;

const ZCODE_JWT_CREDENTIAL_KEY = "zcodejwttoken";
const OAUTH_ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const DEV_TRUSTED_ORIGINS_ENV = "ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS";

interface DesktopSettingSnapshot {
  modelProviderFamilyModes?: Record<string, unknown>;
  providerFamilyConnectionSelections?: Record<
    string,
    { kind?: unknown; organizationId?: unknown; projectId?: unknown } | null
  >;
  providerFamilyDomain?: unknown;
}

/** Trim a string and strip an optional `Bearer ` prefix; returns the bare token or null. */
function stripBearerPrefix(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const bare = trimmed.replace(/^Bearer\s+/iu, "").trim();
  return bare || null;
}

/** A trimmed non-empty string, or null for anything else. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Normalize an HTTPS origin; returns null for invalid URLs or non-https protocols. */
function normalizeHttpsOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Normalize a local-development loopback HTTP origin (localhost / 127.0.0.1 / [::1] only). */
function normalizeLoopbackOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const isLoopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "http:" || !isLoopback) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the authoritative ZCode service origin injected into the
 * `zcode app-server` environment (for `ZCODE_BASE_URL`).
 *
 * Deliberately ignores an inherited `ZCODE_BASE_URL` (the ambient value may be
 * a provider model API URL set by an external environment); only an explicit
 * `ZCODE_ENDPOINT_ORIGIN` or the default production domain is accepted.
 */
export function resolveOfficialZCodeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ZCODE_ENDPOINT_ORIGIN?.trim();
  if (explicit) {
    const normalized = normalizeHttpsOrigin(explicit) ?? normalizeLoopbackOrigin(explicit);
    if (normalized) return normalized;
  }
  return DEFAULT_ZCODE_BASE_URL;
}

/**
 * Validate that an official MCP request's `targetOrigin` is trusted, so
 * credentials are never sent to a non-ZCode domain.
 */
export function isTrustedOfficialMcpOrigin(
  targetOrigin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const trimmed = targetOrigin?.trim();
  if (!trimmed) return false;

  // ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS may explicitly trust loopback
  // debug origins (local dev gateways only — never arbitrary https origins).
  const loopbackTarget = normalizeLoopbackOrigin(trimmed);
  if (loopbackTarget) {
    const devRaw = env[DEV_TRUSTED_ORIGINS_ENV]?.trim();
    if (devRaw) {
      for (const candidate of devRaw.split(",")) {
        if (normalizeLoopbackOrigin(candidate) === loopbackTarget) {
          return true;
        }
      }
    }
  }

  const expectedBase = resolveOfficialZCodeBaseUrl(env);
  const expectedHttps = normalizeHttpsOrigin(expectedBase);
  const targetHttps = normalizeHttpsOrigin(trimmed);
  if (expectedHttps && targetHttps) {
    return targetHttps === expectedHttps;
  }

  const expectedLoopback = normalizeLoopbackOrigin(expectedBase);
  if (expectedLoopback && loopbackTarget) {
    return loopbackTarget === expectedLoopback;
  }

  return false;
}

/** Read the desktop's `setting.json` connection selections and active family (null on any failure). */
function readDesktopSetting(credsDir: string): DesktopSettingSnapshot | null {
  try {
    return JSON.parse(
      readFileSync(path.join(credsDir, "setting.json"), "utf8"),
    ) as DesktopSettingSnapshot;
  } catch {
    return null;
  }
}

/** Read a family's MaaS OAuth login token (bare value) from the credential store. */
function readFamilyOAuthToken(
  store: Record<string, string>,
  family: CodingPlanFamily,
): string | null {
  return stripBearerPrefix(store[`oauth:${family}:access_token`]);
}

/**
 * Map a connection selection to its wire scope, mirroring upstream
 * `resolveSelectedPlan`: PERSONAL for individual plans, a TEAM
 * organization/project pair for bigmodel teams (upstream sends the pair
 * atomically — either id missing means the selection is unusable), and
 * token-only (`null`) for zai teams. Returns `undefined` when the selection
 * is not a usable coding-plan selection at all.
 */
function wireScopeForSelection(
  family: CodingPlanFamily,
  selection: { kind?: unknown; organizationId?: unknown; projectId?: unknown },
): OfficialMcpWireScope | undefined {
  if (selection.kind === "individual-coding-plan") return { targetType: "PERSONAL" };
  if (selection.kind !== "team-coding-plan") return undefined;
  if (family !== "bigmodel") return null;
  const organizationId = nonEmptyString(selection.organizationId);
  const projectId = nonEmptyString(selection.projectId);
  if (!organizationId || !projectId) return undefined;
  return { targetType: "TEAM", organizationId, projectId };
}

/**
 * Resolve the active Coding Plan family, its MaaS JWT, and the wire scope.
 *
 * Priority:
 * 1. an explicitly selected coding plan in `setting.json` (`individual-` or
 *    `team-coding-plan`, not in `apiKey` mode) that holds an OAuth token;
 * 2. with `setting.json` absent, fall back to the store's
 *    `oauth:active_provider` or any logged-in family (scope unknowable
 *    without a selection record — PERSONAL, the desktop's default).
 */
function resolveActiveCodingPlan(
  store: Record<string, string>,
  credsDir: string,
): { family: CodingPlanFamily; token: string; wireScope: OfficialMcpWireScope } | null {
  const setting = readDesktopSetting(credsDir);
  const preferredRaw =
    (typeof setting?.providerFamilyDomain === "string"
      ? setting.providerFamilyDomain.trim()
      : undefined) || store[OAUTH_ACTIVE_PROVIDER_KEY]?.trim();
  const preferredFamily =
    preferredRaw && isCodingPlanFamily(preferredRaw) ? preferredRaw : undefined;

  if (setting?.providerFamilyConnectionSelections) {
    const candidates: Array<{
      family: CodingPlanFamily;
      token: string;
      wireScope: OfficialMcpWireScope;
    }> = [];
    for (const [family, selection] of Object.entries(setting.providerFamilyConnectionSelections)) {
      if (!isCodingPlanFamily(family)) continue;
      if (setting.modelProviderFamilyModes?.[family] === "apiKey") continue;
      const wireScope = wireScopeForSelection(family, selection ?? {});
      if (wireScope === undefined) continue;
      const token = readFamilyOAuthToken(store, family);
      if (token) candidates.push({ family, token, wireScope });
    }
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1 && preferredFamily) {
      const hit = candidates.find((c) => c.family === preferredFamily);
      if (hit) return hit;
    }
    if (candidates.length > 0) return candidates[0]!;
    // setting.json exists but selects no coding plan: do not blindly inject
    // another family's MaaS JWT.
    return null;
  }

  // Fallback when setting.json is absent (pure CLI / headless environments).
  const order: CodingPlanFamily[] = preferredFamily
    ? [
        preferredFamily,
        ...(preferredFamily === "bigmodel" ? (["zai"] as const) : (["bigmodel"] as const)),
      ]
    : ["bigmodel", "zai"];
  for (const family of order) {
    const token = readFamilyOAuthToken(store, family);
    if (token) return { family, token, wireScope: { targetType: "PERSONAL" } };
  }
  return null;
}

/**
 * Answer an `interaction/requestOfficialMcpAuthHeaders` request by building
 * the identity headers for this official MCP call.
 */
export function resolveOfficialMcpAuthHeaders(
  params: Record<string, unknown>,
  options?: {
    env?: NodeJS.ProcessEnv;
    credsDir?: string;
    credentialStore?: Record<string, string>;
  },
): OfficialMcpAuthHeadersOutcome {
  const env = options?.env ?? process.env;
  const targetOrigin = typeof params.targetOrigin === "string" ? params.targetOrigin : undefined;
  if (!isTrustedOfficialMcpOrigin(targetOrigin, env)) {
    return { ok: false, reason: "official_mcp_origin_untrusted" };
  }

  const store = options?.credentialStore ?? readCredentialStoreSync();
  const jwt = stripBearerPrefix(store[ZCODE_JWT_CREDENTIAL_KEY]);
  if (!jwt) {
    return { ok: false, reason: "official_auth_unavailable" };
  }

  const headers: Record<string, string> = {
    [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${jwt}`,
  };

  const credsDir = options?.credsDir ?? path.dirname(ZCODE_CREDS_PATH);
  const codingPlan = resolveActiveCodingPlan(store, credsDir);
  if (codingPlan) {
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.codingPlanAuthorization] = `Bearer ${codingPlan.token}`;
    const scope = codingPlan.wireScope;
    if (scope) {
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.targetType] = scope.targetType;
      if (scope.targetType === "TEAM") {
        // Team identity is an atomic pair upstream: organization and project
        // go together or not at all.
        headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.organization] = scope.organizationId;
        headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.project] = scope.projectId;
      }
    }
  }

  return { ok: true, headers };
}
