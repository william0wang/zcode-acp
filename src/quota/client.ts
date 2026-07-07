/**
 * GLM quota API HTTP client.
 *
 * Queries `bigmodel.cn` (CN) or `api.z.ai` (intl) for the current account's
 * usage limits. Credentials come from the active ZCode provider in
 * `~/.zcode/v2/config.json` via {@link loadZcodeCredentials} — the same apiKey
 * the backend already uses for model calls.
 */

import { loadZcodeCredentials } from "../backend/credentials.js";

/** Quota endpoint path, appended to the chosen host. */
const QUOTA_PATH = "/api/monitor/usage/quota/limit";

/** Request timeout (ms). The endpoint is fast; keep this tight. */
const TIMEOUT_MS = 8000;

/** Hosts for the CN and intl deployments. */
const HOST_CN = "https://open.bigmodel.cn";
const HOST_INTL = "https://api.z.ai";

/** Raw response from the quota endpoint, pre-parsing. */
export interface QuotaResponse {
  status: number;
  json: unknown;
  text: string;
}

/**
 * Pick the quota host from a provider `baseURL`.
 *
 * `api.z.ai` → intl; anything else (including `open.bigmodel.cn`,
 * `bigmodel.cn`, empty) → CN. This mirrors how the backend routes model
 * traffic.
 */
export function resolveQuotaHost(baseURL: string): string {
  return baseURL.includes("api.z.ai") ? HOST_INTL : HOST_CN;
}

/**
 * Fetch the quota envelope from the GLM API.
 *
 * @throws if the active provider has no apiKey in config, or on network/timeout
 *         errors. The caller maps these to `unavailable`.
 */
export async function fetchQuotaResponse(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<QuotaResponse> {
  const { ANTHROPIC_API_KEY, ZCODE_BASE_URL } = loadZcodeCredentials();
  if (!ANTHROPIC_API_KEY) {
    throw new Error("no apiKey in ZCode config — cannot query quota");
  }

  const url = resolveQuotaHost(ZCODE_BASE_URL ?? "") + QUOTA_PATH;
  const resp = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${ANTHROPIC_API_KEY}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — leave json null; the parser treats it as unavailable.
  }

  return { status: resp.status, json, text };
}
