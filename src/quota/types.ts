/**
 * Type definitions for the GLM Coding Plan quota feature.
 *
 * The `/quota` slash command queries `bigmodel.cn` / `api.z.ai` for the
 * current account's usage limits and renders them as a multi-line card.
 * These types model the raw API response and the normalised shape consumed
 * by the formatter.
 */

/** A single raw limit entry from the GLM quota API (`data.limits[]`). */
export interface RawLimit {
  /** Limit family — "TOKENS_LIMIT" | "TIME_LIMIT" | "MCP_LIMIT" | <unknown>. */
  type: string;
  /** Window-count sub-identifier; meaning varies by backend (unused for classification). */
  unit?: number;
  /** Window span; GLM uses 5 for the 5-hour window, 7 for the weekly window. */
  number?: number;
  /** Total allowance for the window (absolute counter). */
  usage?: number;
  /** Absolute remaining counter (preferred for percentage). */
  remaining?: number;
  /** Absolute used counter (preferred for percentage alongside `usage`). */
  currentValue?: number;
  /** Legacy percentage field — historically represents *used* percent. */
  percentage?: number;
  /** Reset timestamp in epoch milliseconds. */
  nextResetTime?: number;
  /** Per-model usage breakdown (present on MCP/TIME limits). */
  usageDetails?: { modelCode: string; usage: number }[];
}

/**
 * Normalised quota item — one rendered line.
 *
 * Every raw limit that yields a valid percentage becomes a `QuotaItem`;
 * limits with no computable percentage are silently dropped.
 */
export interface QuotaItem {
  /** Stable key derived from type+number, e.g. "token_5h" / "mcp". */
  key: string;
  /** Human-readable label for the line, e.g. "5h" / "MCP" / "Week". */
  label: string;
  /** Used percentage, clamped to [0, 100]. */
  usedPercent: number;
  /** Remaining percentage = 100 - usedPercent. */
  leftPercent: number;
  /** Absolute used count (only some limits carry this, e.g. MCP/TIME). */
  usedCount?: number;
  /** Absolute total allowance (only some limits carry this). */
  totalCount?: number;
  /** Reset timestamp in epoch milliseconds, if present. */
  nextResetTime?: number;
  /** Per-model usage breakdown, if present (rendered as indented sub-lines). */
  detail?: { modelCode: string; usage: number }[];
}

/** Top-level parsed result — a 4-state sum type. */
export type QuotaResult =
  | { kind: "success"; level: string; items: QuotaItem[] }
  | { kind: "auth_error" }
  | { kind: "rate_limited" }
  | { kind: "unavailable" };
