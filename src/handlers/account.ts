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
 * details) and one Opencode Go section (rolling/weekly/monthly windows, the
 * relative reset countdown converted to an absolute timestamp). Provider
 * failures are reported per-section as `kind` strings rather than throwing —
 * the client renders the same status line the CLI would (a `not_configured`
 * Go section is simply omitted, matching the CLI).
 */

import { queryCombined } from "../quota/combined.js";
import type { GoQueryResult, GoWindowKey } from "../quota/opencode-go/types.js";
import type { QuotaItem, QuotaResult } from "../quota/types.js";

/** GLM section — `items` present only on success. */
export interface GlmUsageStats {
  kind: QuotaResult["kind"];
  level?: string;
  items?: QuotaItem[];
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

export interface UsageStatsResult {
  glm: GlmUsageStats;
  opencode: GoUsageStats;
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

/** `account/usage_stats` handler — both providers, queried in parallel. */
export async function accountUsageStats(): Promise<UsageStatsResult> {
  const { glm, go } = await queryCombined("all");
  return { glm: toGlmStats(glm), opencode: toGoStats(go) };
}
