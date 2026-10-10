/**
 * Type definitions for the Ollama Cloud subscription usage feature.
 *
 * `zcode-acp quota` queries the undocumented-but-live
 * `GET https://ollama.com/api/usage?range=30d` endpoint with the user's API
 * key. The API was rewritten (observed 2026-10-10) from a quota-fractions
 * shape (`{limits:{session,weekly,monthly}}`) to a usage-analytics shape
 * (`{range, totals:{usage_usd, request_count, …}, buckets}`) — it now reports
 * SPEND in USD, not usage fractions, and exposes no plan limit. The percent
 * windows on the success variant are therefore DERIVED:
 *   - `monthly` = 30d `usage_usd` ÷ the plan's monthly credit (pricing table
 *     in index.js, keyed by POST /api/me's `Plan`); absent when the plan's
 *     credit is unknown (e.g. the Free tier's starter credit is unlisted).
 *   - resets from the /api/me billing-period lookup (SubscriptionPeriodEnd,
 *     else the CreatedAt monthly anniversary).
 * The pre-2026-10 `limits` shape is still parsed when the server returns it,
 * as a rollback guard.
 *
 * Shape verified against live probes + the pi-multi-account reference client
 * (2026-09); see `.zcode/scratch/research-ollama-cloud-usage.md`. Undocumented
 * — treat parse failures as `unavailable`, never as a crash.
 */

/**
 * Result of querying Ollama Cloud usage — a 4-state sum type mirroring
 * {@link ../opencode-go/types.js GoQueryResult}.
 *
 * `not_configured` is distinct from `unavailable`: the CLI uses it to silently
 * skip the Ollama section in default (all-provider) mode when the user has not
 * supplied an API key, rather than printing an error.
 */
export type OcQueryResult =
  | {
      kind: "success";
      /** Present windows only. Fractions in [0, 1]. `monthly` is derived from
       *  30d spend ÷ plan credit (see the module header) — undefined when the
       *  plan's credit is unknown. `session`/`weekly` only ever come from the
       *  pre-2026-10 legacy response shape. */
      session?: number;
      weekly?: number;
      monthly?: number;
      /** Derived reset moments (epoch ms). session/weekly are computed from
       *  the window anchoring (epoch-aligned 5h buckets; Monday 00:00 UTC
       *  weeks) — the API itself returns no timestamps. monthly comes from
       *  POST /api/me's SubscriptionPeriodEnd when that lookup succeeds;
       *  absent otherwise. */
      sessionResetAt?: number;
      weeklyResetAt?: number;
      monthlyResetAt?: number;
      /** Spend over the rolling 30d window (USD) — the API's own numerator
       *  for the derived `monthly` fraction. */
      usageUsd?: number;
      /** Plan id from POST /api/me ("pro" / "max" / "team" / …). */
      plan?: string;
      /** The plan's monthly usage credit (USD) — the denominator of the
       *  derived `monthly` fraction; present only for plans in the pricing
       *  table. */
      creditUsd?: number;
      /** Rolling-30d request count and token totals, when the API reports
       *  them (additive detail for future clients). */
      requestCount?: number;
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      /** Epoch ms of the fetch (kept for symmetry with the other providers). */
      fetchedAt: number;
    }
  | { kind: "not_configured" }
  | { kind: "auth_error" }
  | { kind: "unavailable" };

/** Raw /api/usage fetch result — status + body text. */
export interface OcUsageResponse {
  status: number;
  text: string;
}
