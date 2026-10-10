/**
 * Ollama Cloud usage HTTP client.
 *
 * Talks to `https://ollama.com/api/usage` — an undocumented but live endpoint.
 * Rewritten upstream (observed 2026-10-10) to return usage analytics
 * (`{range, totals:{usage_usd, request_count, …}, buckets}`); the accepted
 * ranges are 24h / 7d / 30d. We request the 30d rolling window — the closest
 * match to a credit plan's monthly billing period, and the numerator for the
 * derived monthly percent. Auth is a plain Bearer API key (docs.ollama.com).
 * No rate-limit headers exist on any Ollama endpoint, so the body is the only
 * data source.
 */

/** Request timeout (ms). Small JSON response; 10s is plenty. */
const TIMEOUT_MS = 10_000;

/** The undocumented usage endpoint (verified live 2026-09). */
export const USAGE_URL = "https://ollama.com/api/usage";

/**
 * The rolling window we request — the numerator window for the derived
 * monthly percent. Not the billing month itself: the API offers no
 * billing-period range, so the percent is an approximation near the reset.
 */
export const USAGE_RANGE = "30d";

/**
 * Fetch the usage JSON body.
 *
 * @throws on network errors or timeout. The caller maps these to
 *         `unavailable`. Auth failures are NOT thrown — the status is
 *         returned so the orchestrator can classify 401/403 as `auth_error`.
 */
export async function fetchOcUsage(
  apiKey: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ status: number; text: string }> {
  const resp = await fetchImpl(`${USAGE_URL}?range=${USAGE_RANGE}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

/** The undocumented account-status endpoint (verified live 2026-09). */
export const ME_URL = "https://ollama.com/api/me";

/**
 * Fetch the account-status JSON body (plan tier, subscription period end,
 * suspended flag) — the only source for the monthly billing-period reset.
 *
 * Same contract as {@link fetchOcUsage}: throws on network errors/timeout,
 * returns the status so the caller classifies 401/403.
 */
export async function fetchOcMe(
  apiKey: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ status: number; text: string }> {
  const resp = await fetchImpl(ME_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}
