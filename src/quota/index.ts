/**
 * Quota orchestration — the single entry point used by the `/quota` slash
 * command.
 *
 * Flow: cache check → fetch → parse → cache write. Any thrown error (missing
 * apiKey, network/timeout) degrades to `unavailable` rather than propagating,
 * so the command always produces a user-visible message.
 */

import { getCached, setCached } from "./cache.js";
import { fetchQuotaResponse } from "./client.js";
import { log } from "../utils.js";
import { parseQuotaEnvelope } from "./parse.js";
import type { QuotaResult } from "./types.js";

/**
 * Query the GLM quota API and return a normalised {@link QuotaResult}.
 *
 * Serves a cached result when fresh (< 10s). On fetch failure the result is
 * `unavailable`; on a successful fetch the parsed envelope is cached and
 * returned.
 */
export async function queryQuota(): Promise<QuotaResult> {
  const cached = getCached();
  if (cached) {
    log("quota: serving cached result");
    return cached;
  }

  let result: QuotaResult;
  try {
    const resp = await fetchQuotaResponse();
    result = parseQuotaEnvelope(resp);
  } catch (e) {
    log(`quota: fetch failed (${e instanceof Error ? e.message : String(e)})`);
    result = { kind: "unavailable" };
  }

  setCached(result);
  return result;
}

// Re-exports for consumers (slash handler + CLI + tests).
export { formatQuota, formatQuotaPlain } from "./format.js";
export { parseLimit, parseQuotaEnvelope } from "./parse.js";
export { renderBar } from "./format.js";
export type { QuotaItem, QuotaResult, RawLimit } from "./types.js";
