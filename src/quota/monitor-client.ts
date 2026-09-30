/**
 * BigModel/Z.AI monitor-usage HTTP client (platform usage statistics).
 *
 * The monitor family lives on the same hosts and uses the same auth as the
 * quota endpoint (`client.ts`): the active provider's apiKey over the host
 * derived from its baseURL. Every endpoint answers the `{code, msg, success,
 * data}` envelope; classification (auth / rate-limit / empty) happens in the
 * consumer, `src/quota/platform-usage.ts`.
 */

import { loadZcodeCredentials } from "../backend/credentials.js";

import { resolveQuotaHost } from "./client.js";

/** Monitor endpoints this client serves. */
export type MonitorEndpoint =
  | "/api/monitor/credit-usage/activity"
  | "/api/monitor/credit-usage/usage-detail"
  | "/api/monitor/usage/model-usage"
  | "/api/monitor/usage/tool-usage";

/**
 * Request timeout. Desktop parity — the 365-day activity series is the worst
 * case, so this is looser than the quota client's 8s.
 */
const TIMEOUT_MS = 15_000;

/** Raw response from a monitor endpoint, pre-classification. */
export interface MonitorResponse {
  status: number;
  json: unknown;
  text: string;
}

/**
 * Fetch one monitor endpoint for the active account.
 *
 * @throws if the active provider has no apiKey in config, or on network/timeout
 *         errors. The caller maps these to `unavailable`.
 */
export async function fetchMonitorResponse(
  endpoint: MonitorEndpoint,
  search: Record<string, string>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<MonitorResponse> {
  const { ANTHROPIC_API_KEY, providerBaseURL } = loadZcodeCredentials();
  if (!ANTHROPIC_API_KEY) {
    throw new Error("no apiKey in ZCode config — cannot query platform usage");
  }

  const url = new URL(resolveQuotaHost(providerBaseURL ?? "") + endpoint);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);

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
    // Non-JSON body — leave json null; the classifier treats it as unavailable.
  }

  return { status: resp.status, json, text };
}
