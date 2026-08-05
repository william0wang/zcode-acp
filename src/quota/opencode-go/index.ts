/**
 * Opencode Go usage orchestration — the entry point used by the
 * `zcode-quota` CLI.
 *
 * Flow: credentials (env + config file) → cache check → fetch → redirect/auth
 * check → parse → cache write. Any thrown error degrades to `unavailable`
 * rather than propagating, so the CLI always produces output.
 *
 * A missing/invalid credential pair yields `not_configured`, which the
 * combined view silently skips (vs. `unavailable`, which renders an error
 * line) — so users who only care about GLM see no noise.
 */

import { log } from "../../utils.js";
import { getCached, setCached } from "./cache.js";
import { ENV_AUTH_COOKIE, ENV_WORKSPACE_ID, readConfigFile } from "./config.js";
import { fetchGoDashboard } from "./client.js";
import { parseGoDashboard } from "./parse.js";
import type { GoQueryResult } from "./types.js";

/** Format validators (match pi-go-bars conventions). */
const RE_WORKSPACE = /^wrk_[A-Za-z0-9]+$/;
const COOKIE_PREFIX = "Fe26.2**";

/**
 * Resolve & validate credentials.
 *
 * Environment variables take precedence over `~/.pi/agent/opencode-go.json`,
 * merged field-by-field: env overrides the same field from the file, but a
 * field present only in the file still counts. Returns `null` when the
 * resolved pair is incomplete or malformed — `queryGoUsage` maps that to
 * `not_configured`.
 */
function loadCredentials(): { workspaceId: string; authCookie: string } | null {
  const file = readConfigFile();
  const workspaceId = process.env[ENV_WORKSPACE_ID] ?? file.workspaceId;
  const authCookie = process.env[ENV_AUTH_COOKIE] ?? file.authCookie;

  if (!workspaceId || !authCookie) return null;
  if (!RE_WORKSPACE.test(workspaceId)) {
    log(`opencode-go: invalid workspaceId format (expected wrk_…)`);
    return null;
  }
  if (!authCookie.startsWith(COOKIE_PREFIX)) {
    log(`opencode-go: authCookie does not start with ${COOKIE_PREFIX}`);
    return null;
  }
  return { workspaceId, authCookie };
}

/**
 * Query the Opencode Go dashboard and return a normalised {@link GoQueryResult}.
 *
 * - No credentials / invalid → `not_configured`.
 * - Serves a cached result when fresh (< 10s).
 * - HTTP redirect to login (final URL no longer contains the workspace path)
 *   → `auth_error`.
 * - Network/timeout/parse failure → `unavailable`.
 */
export async function queryGoUsage(): Promise<GoQueryResult> {
  const cached = getCached();
  if (cached) {
    log("opencode-go: serving cached result");
    return cached;
  }

  const creds = loadCredentials();
  if (!creds) return { kind: "not_configured" };

  let result: GoQueryResult;
  try {
    const resp = await fetchGoDashboard(creds.workspaceId, creds.authCookie);

    // Redirect-to-login detection: an expired cookie silently bounces to the
    // login page with a 200, so we check the final URL rather than the status.
    if (!resp.finalUrl.includes(`/workspace/${creds.workspaceId}/go`)) {
      result = { kind: "auth_error" };
    } else {
      const parsed = parseGoDashboard(resp.text);
      if (parsed.parserOutdated) {
        log("opencode-go: dashboard HTML recognised but no windows parsed (parser outdated)");
        result = { kind: "unavailable" };
      } else if (!parsed.rolling && !parsed.weekly && !parsed.monthly) {
        // Not a dashboard page at all (e.g. error page the redirect check missed).
        result = { kind: "unavailable" };
      } else {
        result = {
          kind: "success",
          // Rolling and weekly are the two windows the CLI shows by default;
          // fall back to zeroes if somehow absent so the type stays simple.
          rolling: parsed.rolling ?? { usagePercent: 0, resetInSec: 0 },
          weekly: parsed.weekly ?? { usagePercent: 0, resetInSec: 0 },
          monthly: parsed.monthly,
          fetchedAt: Date.now(),
        };
      }
    }
  } catch (e) {
    log(`opencode-go: fetch failed (${e instanceof Error ? e.message : String(e)})`);
    result = { kind: "unavailable" };
  }

  setCached(result);
  return result;
}

// Re-exports for consumers (CLI + tests).
export { clearCache, clearCache as clearGoCache } from "./cache.js";
export { fetchGoDashboard, dashboardUrl } from "./client.js";
export { parseGoDashboard, looksLikeDashboard } from "./parse.js";
export { formatDuration, formatGoSection } from "./format.js";
export { readConfigFile, CONFIG_PATH, ENV_WORKSPACE_ID, ENV_AUTH_COOKIE } from "./config.js";
export type { GoQueryResult, GoWindow, GoWindowKey, GoDashboardResponse } from "./types.js";
