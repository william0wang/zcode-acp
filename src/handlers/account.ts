/**
 * Account-level usage stats — Proposal 0002 (`account/usage_stats`).
 *
 * Exposes the combined dual-provider quota behind the `zcode-acp quota` CLI
 * (GLM Coding Plan + Opencode Go) to remote clients as a pull-only ACP
 * method, callable any time after `initialize` (no session required — quota
 * is account-level, so it fits no `session/update` kind).
 *
 * The response mirrors the CLI card's data model so clients can reproduce it
 * exactly: one GLM section (plan level + per-window items with per-model
 * details), one Opencode Go section (rolling/weekly/monthly windows, the
 * relative reset countdown converted to an absolute timestamp), and one Ollama
 * Cloud section (session/weekly/monthly fractions as percents, with the
 * derived reset moments when available — the API itself returns none), and
 * one ZCode section (Start Plan promo grants on `zcode.z.ai`, absolute token
 * counters with the grant deadline — `one_time` grants do not refill).
 * Provider failures are reported per-section as
 * `kind` strings rather than throwing — the client renders the same status
 * line the CLI would (a `not_configured` section is simply omitted, matching
 * the CLI).
 */

import { parseRemoteConfig } from "../remote/config.js";
import { queryCombined } from "../quota/combined.js";
import type { OcQueryResult } from "../quota/ollama-cloud/types.js";
import type { GoQueryResult, GoWindowKey } from "../quota/opencode-go/types.js";
import { queryStartPlan } from "../quota/startplan.js";
import type { StartPlanResult, StartPlanWindow } from "../quota/startplan.js";
import type { QuotaItem, QuotaResult } from "../quota/types.js";

/** GLM section — `items` present only on success. */
export interface GlmUsageStats {
  kind: QuotaResult["kind"];
  level?: string;
  items?: QuotaItem[];
}

/**
 * One ZCode Start Plan window: one `one_time` grant's token usage. `resetsAt`
 * carries the grant's `expires_at` deadline — start-plan grants do not refill,
 * so clients must present it as an expiry, not a guaranteed reset. Everything
 * the reader normalises except the plan/model identity fields, which live on
 * the section.
 */
export type ZcodeWindowEntry = Omit<StartPlanWindow, "plan" | "model">;

/** ZCode Start Plan section (promo plans on `zcode.z.ai`) — `windows` only on success. */
export interface ZcodeUsageStats {
  kind: StartPlanResult["kind"];
  planId?: string;
  planName?: string;
  windows?: ZcodeWindowEntry[];
}

/** One Opencode Go window with the reset countdown resolved to epoch ms. */
export interface GoWindowEntry {
  key: GoWindowKey;
  label: string;
  usagePercent: number;
  resetsAt: number;
}

/** Opencode Go section — `windows` present only on success. */
export interface GoUsageStats {
  kind: GoQueryResult["kind"];
  windows?: GoWindowEntry[];
}

/**
 * One Ollama Cloud window with the derived reset moment (epoch ms) when
 * available — the API returns no timestamps, so resets are computed at query
 * time (window anchoring, or /api/me's billing period for monthly).
 */
export interface OcWindowEntry {
  key: "session" | "weekly" | "monthly";
  label: string;
  usagePercent: number;
  resetsAt?: number;
}

/**
 * Ollama Cloud spend detail (analytics API, 2026-10+): usage in USD over the
 * rolling 30d window. `creditUsd` is present only when the plan's monthly
 * credit is known (pricing table) — which is also what makes the `monthly`
 * percent window derivable; without it the client can still render the raw
 * spend. Additive field: older clients ignore it.
 */
export interface OcUsageDetail {
  plan?: string;
  usageUsd: number;
  creditUsd?: number;
  requestCount?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** The rolling window the spend covers — the API offers no billing-period
   *  range, so the monthly percent is this window ÷ credit (approximation). */
  window: "30d";
}

/** Ollama Cloud section — `windows` present only on success. */
export interface OcUsageStats {
  kind: OcQueryResult["kind"];
  windows?: OcWindowEntry[];
  usage?: OcUsageDetail;
}

export interface UsageStatsResult {
  glm: GlmUsageStats;
  opencode: GoUsageStats;
  ollama: OcUsageStats;
  zcode: ZcodeUsageStats;
}

/** Window labels matching the CLI's card (`5h` / `Week` / `Month`). */
const GO_WINDOW_LABELS: Record<GoWindowKey, string> = {
  rolling: "5h",
  weekly: "Week",
  monthly: "Month",
};

/** GLM items pass through verbatim — the client renders the CLI layout. */
function toGlmStats(result: QuotaResult): GlmUsageStats {
  if (result.kind !== "success") return { kind: result.kind };
  return { kind: "success", level: result.level, items: result.items };
}

/**
 * Go windows with the same absolute-reset math the CLI formatter uses:
 * subtract the elapsed time since the fetch snapshot from `resetInSec`.
 */
function toGoStats(result: GoQueryResult, now = Date.now()): GoUsageStats {
  if (result.kind !== "success") return { kind: result.kind };
  const elapsedSec = Math.max(0, (now - result.fetchedAt) / 1000);
  const windows = (["rolling", "weekly", "monthly"] as const).flatMap((key) => {
    const w = result[key];
    if (!w) return [];
    const remainingSec = Math.max(0, w.resetInSec - elapsedSec);
    return [
      {
        key,
        label: GO_WINDOW_LABELS[key],
        usagePercent: w.usagePercent,
        resetsAt: result.fetchedAt + remainingSec * 1000,
      },
    ];
  });
  return { kind: "success", windows };
}

/**
 * Ollama windows as percents — the API's 0..1 fractions converted once here
 * so remote clients can render the same bar the CLI does. Which windows exist
 * depends on the plan (legacy: session+weekly; credit: monthly, derived from
 * 30d spend ÷ plan credit). The derived reset moments and the analytics spend
 * detail pass through when present.
 */
function toOcStats(result: OcQueryResult): OcUsageStats {
  if (result.kind !== "success") return { kind: result.kind };
  const LABELS = { session: "5h", weekly: "Week", monthly: "Month" } as const;
  const RESETS = {
    session: "sessionResetAt",
    weekly: "weeklyResetAt",
    monthly: "monthlyResetAt",
  } as const;
  const windows = (["session", "weekly", "monthly"] as const).flatMap((key) => {
    if (result[key] === undefined) return [];
    const reset = result[RESETS[key]];
    return [
      {
        key,
        label: LABELS[key],
        usagePercent: result[key]! * 100,
        ...(typeof reset === "number" && { resetsAt: reset }),
      },
    ];
  });
  const usage =
    result.usageUsd !== undefined
      ? {
          ...(result.plan !== undefined && { plan: result.plan }),
          usageUsd: result.usageUsd,
          ...(result.creditUsd !== undefined && { creditUsd: result.creditUsd }),
          ...(result.requestCount !== undefined && { requestCount: result.requestCount }),
          ...(result.inputTokens !== undefined && { inputTokens: result.inputTokens }),
          ...(result.cachedInputTokens !== undefined && {
            cachedInputTokens: result.cachedInputTokens,
          }),
          ...(result.outputTokens !== undefined && { outputTokens: result.outputTokens }),
          window: "30d" as const,
        }
      : undefined;
  return { kind: "success", windows, ...(usage !== undefined && { usage }) };
}

/** ZCode Start Plan windows pass through with their absolute counters. */
function toZcodeStats(result: StartPlanResult): ZcodeUsageStats {
  if (result.kind !== "success") return { kind: result.kind };
  const toWindow = (w: StartPlanWindow): ZcodeWindowEntry => {
    const { plan: _plan, model: _model, ...window } = w;
    return window;
  };
  return {
    kind: "success",
    planId: result.planId,
    planName: result.planName,
    windows: result.windows.map(toWindow),
  };
}

/** `account/usage_stats` handler — all providers, queried in parallel. */
export async function accountUsageStats(): Promise<UsageStatsResult> {
  const [{ glm, go, oc }, zcode] = await Promise.all([
    queryCombined("all"),
    queryStartPlan(),
  ]);
  return {
    glm: toGlmStats(glm),
    opencode: toGoStats(go),
    ollama: toOcStats(oc),
    zcode: toZcodeStats(zcode),
  };
}

/**
 * Budget for the hub-first lookup in {@link accountUsageStatsViaHub}. Longer
 * than the dock's 500ms (live.ts): this answers an explicit client request,
 * and the hub's own cache may be cold — better to wait than to fire a second
 * full provider sweep in this process. A down hub still falls back instantly
 * (loopback connect-refused), so the budget only ever waits on a live hub.
 */
const HUB_QUOTA_BUDGET_MS = 2_000;

/**
 * Hub-first `account/usage_stats` — quota traffic converges on the hub's
 * cache whenever one exists (same policy as the dock refresher, live.ts), so
 * many clients/bridges translate to one upstream sweep per TTL window. Any
 * failure (no remote config, hub down, budget exceeded) falls back to the
 * local {@link accountUsageStats} — the normal path for local-only setups.
 */
export async function accountUsageStatsViaHub(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageStatsResult> {
  const remote = parseRemoteConfig(env);
  if (remote) {
    try {
      const resp = await fetch(`http://${remote.hubHost}:${remote.hubPort}/api/quota`, {
        headers: { Authorization: `Bearer ${remote.token}` },
        signal: AbortSignal.timeout(HUB_QUOTA_BUDGET_MS),
      });
      if (resp.ok) {
        const body = (await resp.json()) as Partial<UsageStatsResult>;
        // Require the `zcode` section too: an older hub without it would
        // silently hide the section from clients. The hub auto-upgrades onto
        // the current dist, so the skew window is short; meanwhile a local
        // query keeps the answer complete.
        if (body.glm && body.zcode) return body as UsageStatsResult;
      }
    } catch {
      // hub absent/restarting — local fallback below
    }
  }
  return accountUsageStats();
}
