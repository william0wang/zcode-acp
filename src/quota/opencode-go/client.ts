/**
 * Opencode Go dashboard HTTP client.
 *
 * There is no JSON API for Go subscription usage. The only data source is the
 * authenticated web dashboard at `https://opencode.ai/workspace/<id>/go`,
 * which serves an HTML page with usage embedded in a SolidJS SSR hydration
 * payload. We fetch the HTML here and hand it to the parser.
 *
 * Credentials come from environment variables (set by the user) — not from
 * `~/.zcode/v2/config.json`, since Opencode Go is unrelated to the ZCode
 * provider the bridge talks to.
 */

/** Request timeout (ms). The dashboard is a full HTML page; allow a bit more. */
const TIMEOUT_MS = 10_000;

/**
 * Browser-like User-Agent. opencode.ai returns a login redirect for
 * unauthenticated requests; sending a real browser UA avoids any
 * bot-detection short-circuit that would bypass the dashboard route.
 */
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

/** Build the dashboard URL for a workspace. */
export function dashboardUrl(workspaceId: string): string {
  return `https://opencode.ai/workspace/${workspaceId}/go`;
}

/**
 * Fetch the Go dashboard HTML.
 *
 * @throws on non-2xx responses, network errors, or timeout. The caller maps
 *         these to `unavailable`. A redirect-to-login is NOT thrown here —
 *         the final URL is returned so the orchestrator can classify it as
 *         `auth_error`.
 */
export async function fetchGoDashboard(
  workspaceId: string,
  authCookie: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ status: number; text: string; finalUrl: string }> {
  const url = dashboardUrl(workspaceId);
  const resp = await fetchImpl(url, {
    method: "GET",
    headers: {
      Cookie: `auth=${authCookie}`,
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await resp.text();
  return { status: resp.status, text, finalUrl: resp.url };
}
