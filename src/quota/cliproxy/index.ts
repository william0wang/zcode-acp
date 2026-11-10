/**
 * CLIProxyAPI quota orchestration — the entry used by `zcode-acp quota cp`
 * and the combined card.
 *
 * Flow: config (file → env) → plain-HTTP guard → cache → credentials listing
 * → per-Gemini-account quota relay (parallel across accounts, three upstream
 * URL variants in order) → parse → cache. Account-level failures degrade to
 * that account's omission; a failed listing degrades the whole section — but
 * a transient failure never evicts the last SUCCESS from the display (see
 * `queryCpUsage`).
 *
 * Never throws — the CLI always produces output.
 */

import { log } from "../../utils.js";
import { fetchCredentials, fetchQuotaSummary } from "./client.js";
import { loadCpConfig } from "./config.js";
import {
  ANTIGRAVITY_PROVIDER,
  parseCredentialEntries,
  parseQuotaSummary,
  relayUpstreamBody,
  relayUpstreamStatus,
} from "./parse.js";
import type { CpAccountQuota, CpQueryResult } from "./types.js";

/** Result carrying the non-Gemini account count for the renderer's tail. */
export interface CpQueryOutcome {
  result: CpQueryResult;
  /** Credential entries whose provider is not Gemini (codex/claude/…). */
  otherCount: number;
}

/**
 * Success TTL — deliberately MUCH longer than the other providers (10s): the
 * Gemini quota summary rides `v1internal:retrieveUserQuotaSummary`, a Google
 * INTERNAL endpoint reached with the account's own OAuth token, so every
 * refresh is charged to that Google account. High-frequency polling risks
 * rate-limiting or account-level risk flags, and quota buckets move at
 * minute-scale anyway. This TTL is the rate guard NO MATTER how often the
 * caller polls (watch mode's 30s ticks included — they must not clear this
 * cache; see `clearCpCache`).
 */
const TTL_MS = 5 * 60_000;
/**
 * Failure re-entry gate: a failed sweep is retried at most once a minute, so
 * the dock's 60s tick cannot turn a down proxy into a poll storm — but unlike
 * the success TTL it is short, so a single blip recovers on the next tick
 * instead of blanking the card for the whole 5 minutes.
 */
const FAILURE_RETRY_MS = 60_000;
/** Last SUCCESSFUL outcome — the only record allowed on the display path. */
let lastSuccess: { outcome: CpQueryOutcome; at: number } | null = null;
/** Last failed sweep and when it happened (drives the retry gate + sticky). */
let lastFailure: { outcome: CpQueryOutcome; at: number } | null = null;

/**
 * Drop the cached outcomes. NOT wired into the CLI watch tick on purpose —
 * clearing it per tick would restore the 30s poll this TTL exists to prevent.
 * Tests use it to force a fresh query.
 */
export function clearCpCache(): void {
  lastSuccess = null;
  lastFailure = null;
}

async function queryOneAccount(
  base: string,
  key: string,
  entry: { authIndex: string; label: string; projectId?: string },
): Promise<CpAccountQuota | null> {
  try {
    const relay = await fetchQuotaSummary(base, key, entry.authIndex, entry.projectId);
    if (!relay) return null;
    if (relayUpstreamStatus(relay.text) !== 200) return null;
    const body = relayUpstreamBody(relay.text);
    if (body === undefined) return null;
    const models = parseQuotaSummary(body);
    if (models.length === 0) return null;
    return { label: entry.label, provider: ANTIGRAVITY_PROVIDER, models };
  } catch (e) {
    log(`cliproxy: account ${entry.authIndex} quota relay failed (${String(e)})`);
    return null;
  }
}

/**
 * Query the remote CLIProxyAPI. Returns `{result, otherCount}` so the caller
 * can render the codex/claude tail without a second listing.
 *
 * STICKY LAST-SUCCESS: a transient failure (`unavailable` — listing timeout,
 * relay failures) never evicts the last successful outcome from the display;
 * the stale success keeps its original `fetchedAt`, so the card header stamps
 * its age honestly (observed 2026-11-10: the credentials listing times out
 * intermittently and one blip blanked the Gemini quota for the whole TTL).
 * `auth_error` (wrong management key) is durable and actionable — it still
 * surfaces.
 */
export async function queryCpUsage(): Promise<CpQueryOutcome> {
  if (lastSuccess && Date.now() - lastSuccess.at < TTL_MS) {
    log("cliproxy: serving cached result");
    return lastSuccess.outcome;
  }
  if (lastFailure && Date.now() - lastFailure.at < FAILURE_RETRY_MS) {
    if (lastFailure.outcome.result.kind === "unavailable" && lastSuccess) {
      log("cliproxy: serving the last success after a failed sweep");
      return lastSuccess.outcome;
    }
    return lastFailure.outcome;
  }

  const cfg = loadCpConfig();
  if (!cfg) return { result: { kind: "not_configured" }, otherCount: 0 };
  // The management key relays credential-bearing upstream calls — refuse a
  // plaintext connection to anything but loopback (an SSH tunnel is the
  // recommended way to reach a plain-HTTP instance).
  if (cfg.url.startsWith("http://") && !/^http:\/\/(127\.|localhost|\[::1\])/.test(cfg.url)) {
    log(
      "cliproxy: refusing plain-HTTP management URL to a non-loopback host (use https or an SSH tunnel)",
    );
    return { result: { kind: "unavailable" }, otherCount: 0 };
  }

  let outcome: CpQueryOutcome;
  try {
    const resp = await fetchCredentials(cfg.url, cfg.key);
    if (resp.status === 401 || resp.status === 403) {
      outcome = { result: { kind: "auth_error" }, otherCount: 0 };
    } else if (resp.status !== 200) {
      log(`cliproxy: unexpected status ${resp.status}`);
      outcome = { result: { kind: "unavailable" }, otherCount: 0 };
    } else {
      const entries = parseCredentialEntries(resp.text);
      const gemini = entries.filter((e) => e.provider === ANTIGRAVITY_PROVIDER);
      const accounts = (
        await Promise.all(gemini.map((e) => queryOneAccount(cfg.url, cfg.key, e)))
      ).filter((a): a is CpAccountQuota => a !== null);
      // Every Gemini account failing its relay reads as "unreachable quota",
      // not as an empty success — with accounts present but none answering,
      // the honest row is an error line.
      outcome = {
        result:
          gemini.length > 0 && accounts.length === 0
            ? { kind: "unavailable" }
            : { kind: "success", accounts, fetchedAt: Date.now() },
        otherCount: entries.length - gemini.length,
      };
    }
  } catch (e) {
    log(`cliproxy: fetch failed (${e instanceof Error ? e.message : String(e)})`);
    outcome = { result: { kind: "unavailable" }, otherCount: 0 };
  }

  if (outcome.result.kind === "success") {
    lastSuccess = { outcome, at: Date.now() };
    lastFailure = null;
  } else {
    lastFailure = { outcome, at: Date.now() };
    if (outcome.result.kind === "unavailable" && lastSuccess) {
      log("cliproxy: sweep failed — serving the last successful result");
      return lastSuccess.outcome;
    }
  }
  return outcome;
}

export { formatCpSection } from "./format.js";
export { loadCpConfig, ENV_KEY, ENV_URL } from "./config.js";
export { ANTIGRAVITY_PROVIDER, parseCredentialEntries, parseQuotaSummary } from "./parse.js";
export type {
  CpAccountQuota,
  CpModelQuota,
  CpQueryResult,
  CpWindow,
  CpWindowQuota,
} from "./types.js";
