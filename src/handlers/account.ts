/**
 * Account-level usage stats — Proposal 0002 (`account/usage_stats`).
 *
 * Exposes the GLM Coding Plan quota (5h / weekly / MCP windows) to remote
 * clients as a pull-only ACP method, callable any time after `initialize`
 * (no session required — quota is account-level, so it fits no
 * `session/update` kind).
 *
 * Data source: the same `quota/` pipeline behind the `/quota` command (GLM
 * usage API + 10s cache). The app-server's `usage/stats` RPC is NOT used — it
 * returns token analytics over a time range, not billing-window quotas.
 *
 * Failure degrades per the proposal: a JSON-RPC error (with the failure kind
 * in `data`) so the client hides its quota UI.
 */

import { RequestError } from "@agentclientprotocol/sdk";

import { queryQuota } from "../quota/index.js";
import type { QuotaItem } from "../quota/types.js";

/** One plan window in the response — the shape remote clients render. */
export interface UsagePlanEntry {
  /** Stable id, e.g. "token_5h" / "token_week" / "mcp". */
  id: string;
  /** Human-readable label, e.g. "5h" / "Week" / "MCP". */
  name: string;
  /** Used percentage 0-100 (always present — some windows expose no counts). */
  usedPercent: number;
  /** Absolute used count, when the API reports one. */
  used?: number;
  /** Absolute allowance, when the API reports one. */
  limit?: number;
  /** Window span in hours, when known. */
  windowHours?: number;
  /** Reset timestamp (epoch ms), when the API reports one. */
  resetsAt?: number;
}

/** Map a parsed quota item to the wire entry (additive fields only). */
function toPlanEntry(item: QuotaItem): UsagePlanEntry {
  const windowHours = item.key === "token_5h" ? 5 : item.key === "token_week" ? 168 : undefined;
  return {
    id: item.key,
    name: item.label,
    usedPercent: item.usedPercent,
    ...(item.usedCount !== undefined ? { used: item.usedCount } : {}),
    ...(item.totalCount !== undefined ? { limit: item.totalCount } : {}),
    ...(windowHours !== undefined ? { windowHours } : {}),
    ...(item.nextResetTime !== undefined ? { resetsAt: item.nextResetTime } : {}),
  };
}

/**
 * `account/usage_stats` handler — one row per quota window.
 *
 * @throws RequestError (-32003) with `data.kind` when the quota API is
 *         unavailable/unauthorized/rate-limited, so clients hide the quota UI.
 */
export async function accountUsageStats(): Promise<{ plans: UsagePlanEntry[] }> {
  const result = await queryQuota();
  if (result.kind !== "success") {
    throw new RequestError(-32003, `quota unavailable (${result.kind})`, {
      kind: result.kind,
    });
  }
  return { plans: result.items.map(toPlanEntry) };
}
