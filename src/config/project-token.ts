/**
 * OAuth-derived Coding Plan request auth — the 3.15+ desktop layout.
 *
 * Desktop 3.15+ no longer stores a plan api-key anywhere on disk. After an
 * OAuth sign-in, `~/.zcode/v2/credentials.json` holds only the account login
 * token (`oauth:<family>:access_token`, a business JWT) and a
 * `project-key-location:v1:…` record that remembers WHERE the account's
 * `zcode-api-key` lives (organization / project / key id), never the key
 * itself. Before every model request the desktop host trades the login token
 * for a short-lived project access token and answers the backend's
 * `interaction/requestProviderRuntimeHeaders` with it.
 *
 * This module performs that same exchange so the headless bridge can answer
 * the request on such machines. It mirrors the open-source ZCode host
 * (`packages/shared/src/project-access-token-client.ts` and
 * `packages/services/src/model-provider/accountProviderApiKeyResolver.ts`,
 * ZCode 3.17.x, Apache-2.0):
 *
 *   1. GET  {origin}/api/biz/customer/getCustomerInfo        → organizations/projects
 *   2. pick the personal default project (team projects, projectType 2, excluded)
 *   3. GET  {origin}/api/biz/v1/organization/{org}/projects/{project}/api_keys
 *      → the key named `zcode-api-key`
 *   4. POST …/api_keys/{keyId}/access_tokens {clientType:"zcode", clientVersion}
 *      → `{accessToken, tokenType:"Bearer", expiresIn, expiresAt}`
 *
 * Deliberate differences from the desktop host:
 *
 *   - Read-only towards the account: when no `zcode-api-key` exists the
 *     desktop creates one; the bridge never does — it fails with a hint to
 *     open the ZCode app once instead.
 *   - Memory only: neither the location nor the token is written to disk (the
 *     desktop persists the location in its encrypted store; the bridge never
 *     modifies desktop files). The location is re-resolved once per process.
 *   - Nothing here is logged: tokens, ids and response bodies stay out of every
 *     message; failures surface as fixed codes (`project_token_*`).
 */

import { createHash } from "node:crypto";

import { readCredentialStoreSync } from "../backend/credential-store.js";
import { appBundlePath, installedAppVersion } from "../settings/app-update.js";

export type CodingPlanFamily = "zai" | "bigmodel";

/** Business API origins the desktop host trades tokens with (ZCode 3.17.x). */
const FAMILY_ORIGIN: Record<CodingPlanFamily, string> = {
  zai: "https://api.z.ai",
  bigmodel: "https://bigmodel.cn",
};

/** Key the desktop provisions per account for the ZCode client. */
const ZCODE_KEY_NAME = "zcode-api-key";
/** Default organization / project names the desktop prefers (server-side literals). */
const DEFAULT_ORGANIZATION_NAME = "默认机构";
const DEFAULT_PROJECT_NAME = "默认项目";
/** Team projects are never the personal plan's home. */
const TEAM_PROJECT_TYPE = "2";

const REQUEST_TIMEOUT_MS = 15_000;
/** Refresh this long before expiry so an in-flight request never carries a dead token. */
const REFRESH_LEAD_MS = 120_000;

export function isCodingPlanFamily(value: string): value is CodingPlanFamily {
  return value === "zai" || value === "bigmodel";
}

/** Refresh retry backoff after a transient failure while the cached token is still valid. */
const TRANSIENT_RETRY_BACKOFF_MS = 5_000;

/** Credential store key holding the desktop's login token for `family`. */
function oauthLoginCredentialKey(family: CodingPlanFamily): string {
  return `oauth:${family}:access_token`;
}

/** Credential store key of the ZCode JWT the host folds into the account scope. */
const ZCODE_JWT_CREDENTIAL_KEY = "zcodejwttoken";

/** The desktop's login token for `family`, or null when the user never signed in there. */
function readLoginToken(family: CodingPlanFamily): string | null {
  const raw = readCredentialStoreSync()[oauthLoginCredentialKey(family)]?.trim();
  if (!raw) return null;
  return raw.replace(/^Bearer\s+/iu, "") || null;
}

/** Whether the desktop holds an OAuth sign-in for `family` (no network, no decryption beyond the store read). */
export function hasOAuthLogin(family: CodingPlanFamily): boolean {
  return readLoginToken(family) !== null;
}

export class ProjectTokenError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProjectTokenError";
  }
}

export interface ProjectTokenMaterial {
  readonly token: string;
  readonly apiKeyId: string;
  /**
   * Opaque identity of the sign-in the token was issued for. The backend only
   * runs its "PAT rejected → refresh once → retry" recovery when the previous
   * answer carried one (it echoes it back as `expectedAccountScope`).
   */
  readonly accountScope: string;
}

/**
 * Account scope, computed like the desktop host's
 * (`accountProviderRequestAuthService.ts` `#scope`): sha256 hex over the
 * family, the plan kind and the current sign-in, so a new sign-in changes it.
 */
function accountScopeFor(family: CodingPlanFamily, loginToken: string): string {
  const zcodeJwt = readCredentialStoreSync()[ZCODE_JWT_CREDENTIAL_KEY]?.trim() || null;
  return createHash("sha256")
    .update(JSON.stringify([family, "individual-coding-plan", null, loginToken, zcodeJwt]))
    .digest("hex");
}

interface KeyLocation {
  readonly organizationId: string;
  readonly projectId: string;
  readonly apiKeyId: string;
}

interface CachedToken {
  readonly token: string;
  readonly apiKeyId: string;
  readonly fingerprint: string;
  readonly refreshAt: number;
  readonly expiresAt: number;
}

interface LoginSession {
  readonly loginFingerprint: string;
  location?: Promise<KeyLocation>;
  token?: CachedToken;
  pending?: Promise<Omit<ProjectTokenMaterial, "accountScope">>;
}

const sessions = new Map<CodingPlanFamily, LoginSession>();

type Network = typeof fetch;
let network: Network = (input, init) => globalThis.fetch(input, init);
let clientVersionOverride: string | undefined;
let clientVersionMemo: Promise<string> | undefined;

/** Test seam: replace the network implementation (mirrors setManifestNetworkForTest). */
export function setProjectTokenNetworkForTest(impl: Network): void {
  network = impl;
}

/** Test seam: pin the clientVersion sent with the exchange. */
export function setProjectTokenClientVersionForTest(version: string | undefined): void {
  clientVersionOverride = version;
  clientVersionMemo = undefined;
}

/** Test seam: drop every cached location and token (a new sign-in already does this per family). */
export function clearProjectTokens(): void {
  sessions.clear();
}

/** sha256 hex of a token — the backend's `rejectedProjectTokenFingerprint` speaks this form. */
export function projectTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function clientVersion(): Promise<string> {
  if (clientVersionOverride) return clientVersionOverride;
  clientVersionMemo ??= (async () => {
    const app = appBundlePath();
    const version = app ? await installedAppVersion(app).catch(() => null) : null;
    return version ?? "0.0.0";
  })();
  return clientVersionMemo;
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof ProjectTokenError)) return false;
  if (error.code === "project_token_timeout" || error.code === "project_token_network_error") {
    return true;
  }
  const status = /^project_token_http_(\d{3})$/u.exec(error.code)?.[1];
  return status === "429" || (status !== undefined && status.startsWith("5"));
}

const SUCCESS_CODES = new Set<unknown>([200, 0, "200", "0"]);

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await network(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new ProjectTokenError(
      name === "TimeoutError" || name === "AbortError"
        ? "project_token_timeout"
        : "project_token_network_error",
    );
  }
  if (response.status === 404) return { code: 404 };
  if (response.status < 200 || response.status >= 300) {
    throw new ProjectTokenError(`project_token_http_${response.status}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProjectTokenError("project_token_invalid_response");
  }
}

/** The `data` of a `{code, data}` business envelope; throws on any non-success code. */
function envelopeData(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !SUCCESS_CODES.has((raw as { code?: unknown }).code)) {
    throw new ProjectTokenError("project_token_invalid_response");
  }
  return (raw as { data?: unknown }).data;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function keyListUrl(origin: string, org: string, project: string): string {
  return `${origin}/api/biz/v1/organization/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/api_keys`;
}

async function resolveLocation(family: CodingPlanFamily, loginToken: string): Promise<KeyLocation> {
  const origin = FAMILY_ORIGIN[family];
  const customer = envelopeData(
    await requestJson(`${origin}/api/biz/customer/getCustomerInfo`, {
      method: "GET",
      headers: { Authorization: loginToken, "Content-Type": "application/json" },
    }),
  ) as { organizations?: unknown } | undefined;
  if (!customer || !Array.isArray(customer.organizations)) {
    throw new ProjectTokenError("project_token_invalid_response");
  }
  type Project = { projectId: string; projectName?: string };
  type Org = { organizationId: string; organizationName?: string; projects: Project[] };
  const personal: Org[] = [];
  for (const rawOrg of customer.organizations as unknown[]) {
    const org = rawOrg as {
      organizationId?: unknown;
      organizationName?: unknown;
      projects?: unknown;
    };
    const organizationId = nonEmpty(org?.organizationId);
    if (!organizationId) continue;
    const projects: Project[] = [];
    for (const rawProject of Array.isArray(org.projects) ? org.projects : []) {
      const project = rawProject as {
        projectId?: unknown;
        projectName?: unknown;
        projectType?: unknown;
      };
      const projectId = nonEmpty(project?.projectId);
      if (!projectId) continue;
      if (String(project.projectType ?? "").trim() === TEAM_PROJECT_TYPE) continue;
      projects.push({ projectId, projectName: nonEmpty(project.projectName) ?? undefined });
    }
    if (projects.length === 0) continue;
    personal.push({
      organizationId,
      organizationName: nonEmpty(org.organizationName) ?? undefined,
      projects,
    });
  }
  const org =
    personal.find((o) => o.organizationName?.includes(DEFAULT_ORGANIZATION_NAME)) ?? personal[0];
  const project =
    org?.projects.find((p) => p.projectName?.includes(DEFAULT_PROJECT_NAME)) ?? org?.projects[0];
  if (!org || !project) throw new ProjectTokenError("project_token_project_unavailable");

  const keys = envelopeData(
    await requestJson(keyListUrl(origin, org.organizationId, project.projectId), {
      method: "GET",
      headers: {
        // The desktop sends the zai key list with a Bearer prefix and bigmodel's bare.
        Authorization: family === "zai" ? `Bearer ${loginToken}` : loginToken,
        "Content-Type": "application/json",
      },
    }),
  );
  if (!Array.isArray(keys)) throw new ProjectTokenError("project_token_invalid_response");
  const candidate = keys.find(
    (entry) =>
      !!entry && typeof entry === "object" && (entry as { name?: unknown }).name === ZCODE_KEY_NAME,
  ) as { apiKey?: unknown } | undefined;
  // Never create the key (the desktop does on first use): the bridge stays read-only
  // towards the account, so a missing key is the user's cue to open the app once.
  if (!candidate) throw new ProjectTokenError("project_token_key_missing");
  const apiKeyId = nonEmpty(candidate.apiKey);
  if (!apiKeyId) throw new ProjectTokenError("project_token_invalid_response");
  return { organizationId: org.organizationId, projectId: project.projectId, apiKeyId };
}

async function issueToken(
  family: CodingPlanFamily,
  loginToken: string,
  session: LoginSession,
): Promise<Omit<ProjectTokenMaterial, "accountScope">> {
  session.location ??= resolveLocation(family, loginToken);
  let location: KeyLocation;
  try {
    location = await session.location;
  } catch (error) {
    session.location = undefined;
    throw error;
  }
  const startedAt = Date.now();
  const raw = await requestJson(
    `${keyListUrl(FAMILY_ORIGIN[family], location.organizationId, location.projectId)}/${encodeURIComponent(location.apiKeyId)}/access_tokens`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${loginToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientType: "zcode", clientVersion: await clientVersion() }),
    },
  );
  if ((raw as { code?: unknown } | null)?.code === 404) {
    // The key was deleted or moved since the location was resolved.
    session.location = undefined;
    throw new ProjectTokenError("project_token_key_missing");
  }
  const data = envelopeData(raw) as
    | {
        enable?: unknown;
        accessToken?: unknown;
        tokenType?: unknown;
        expiresIn?: unknown;
        expiresAt?: unknown;
      }
    | undefined;
  if (data?.enable === false) throw new ProjectTokenError("project_token_disabled");
  const token = nonEmpty(data?.accessToken);
  const expiresIn = typeof data?.expiresIn === "number" ? data.expiresIn : NaN;
  const expiresAtSec = typeof data?.expiresAt === "number" ? data.expiresAt : NaN;
  if (!token || data?.tokenType !== "Bearer" || !(expiresIn > 0) || !(expiresAtSec > 0)) {
    throw new ProjectTokenError("project_token_invalid_response");
  }
  const expiresAt = Math.min(expiresAtSec * 1000, startedAt + expiresIn * 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new ProjectTokenError("project_token_invalid_response");
  }
  session.token = {
    token,
    apiKeyId: location.apiKeyId,
    fingerprint: projectTokenFingerprint(token),
    expiresAt,
    refreshAt: Math.max(startedAt, expiresAt - REFRESH_LEAD_MS),
  };
  return { token, apiKeyId: location.apiKeyId };
}

/**
 * A project access token for `family`'s individual Coding Plan, traded from
 * the desktop's OAuth sign-in. Cached until shortly before expiry and
 * single-flighted.
 *
 * Recovery contract (same as the desktop host): a `rejectedFingerprint`
 * (the backend's `rejectedProjectTokenFingerprint`, sent after a model 401)
 * must come with the `expectedAccountScope` of the answer that served the
 * rejected token; a mismatch means the sign-in changed in between and fails
 * with `project_token_scope_invalidated` instead of re-serving a stale token.
 */
export async function resolveOAuthProjectToken(
  family: CodingPlanFamily,
  options: { rejectedFingerprint?: string; expectedAccountScope?: string } = {},
): Promise<ProjectTokenMaterial> {
  const loginToken = readLoginToken(family);
  if (!loginToken) throw new ProjectTokenError("project_token_login_required");
  const accountScope = accountScopeFor(family, loginToken);
  if (options.rejectedFingerprint && !options.expectedAccountScope) {
    throw new ProjectTokenError("project_token_scope_invalidated");
  }
  if (options.expectedAccountScope !== undefined && options.expectedAccountScope !== accountScope) {
    throw new ProjectTokenError("project_token_scope_invalidated");
  }
  const loginFingerprint = projectTokenFingerprint(loginToken);
  let session = sessions.get(family);
  if (!session || session.loginFingerprint !== loginFingerprint) {
    // A new sign-in (or a different account) invalidates every cached location and token.
    session = { loginFingerprint };
    sessions.set(family, session);
  }
  if (session.token && options.rejectedFingerprint === session.token.fingerprint) {
    session.token = undefined;
  }
  const cached = session.token;
  if (!session.pending && cached && Date.now() < cached.refreshAt) {
    return { token: cached.token, apiKeyId: cached.apiKeyId, accountScope };
  }
  const current = session;
  if (!current.pending) {
    const pending: NonNullable<LoginSession["pending"]> = issueToken(family, loginToken, current)
      .catch((error: unknown) => {
        const still = current.token;
        if (isTransient(error) && still && Date.now() < still.expiresAt) {
          // Desktop parity: keep serving the still-valid token, retry the refresh
          // in a few seconds rather than on every model request.
          current.token = {
            ...still,
            refreshAt: Math.min(Date.now() + TRANSIENT_RETRY_BACKOFF_MS, still.expiresAt),
          };
          return { token: still.token, apiKeyId: still.apiKeyId };
        }
        current.token = undefined;
        throw error;
      })
      .finally(() => {
        if (current.pending === pending) current.pending = undefined;
      });
    current.pending = pending;
  }
  const material = await current.pending;
  // The sign-in may have changed while the exchange was in flight: never hand
  // out a token under a scope it was not issued for.
  if (readLoginToken(family) !== loginToken) {
    throw new ProjectTokenError("project_token_scope_invalidated");
  }
  return { ...material, accountScope };
}
