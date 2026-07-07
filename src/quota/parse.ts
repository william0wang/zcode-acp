/**
 * Quota response parsing — turns the raw GLM `limits[]` array into a flat list
 * of normalised {@link QuotaItem}s.
 *
 * Design goals (vs. the reference project):
 *   - **No hardcoded type whitelist.** Unknown `type` values still render,
 *     labelled by their raw type string, so future windows surface
 *     automatically.
 *   - **Percentage fallback chain** that tolerates inconsistent field sets
 *     across limit kinds (some carry absolute counters, some only a legacy
 *     `percentage`).
 *   - **Labels derived from `type` + `number`**, without magic-number coupling.
 */

import type { QuotaItem, QuotaResult, RawLimit } from "./types.js";

/** Coerce an unknown value to a finite number, or `null`. */
function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Clamp a percentage to the valid [0, 100] range, or `null` if not finite. */
function clampPercent(value: unknown): number | null {
  const n = asFiniteNumber(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Compute `{ leftPercent, usedPercent }` from a single raw limit, tolerating
 * several field combinations (preferred → fallback):
 *   1. `remaining` + `currentValue` (absolute counters) — most precise;
 *   2. `currentValue` / `usage`                         — used over total;
 *   3. `percentage` (legacy, treated as *used* percent) — last resort.
 * Returns `null` when no percentage can be derived.
 */
function computePercentages(limit: RawLimit): {
  leftPercent: number;
  usedPercent: number;
} | null {
  const usage = asFiniteNumber(limit.usage);
  const remaining = asFiniteNumber(limit.remaining);
  const currentValue = asFiniteNumber(limit.currentValue);

  // Path 1: absolute remaining/used counters → derive total from parts.
  const totalFromParts =
    remaining !== null && currentValue !== null ? remaining + currentValue : null;
  const total = totalFromParts !== null && totalFromParts > 0 ? totalFromParts : usage;

  if (total !== null && total > 0) {
    if (remaining !== null && remaining >= 0 && remaining <= total) {
      const leftPercent = clampPercent((remaining / total) * 100);
      if (leftPercent !== null) {
        return { leftPercent, usedPercent: 100 - leftPercent };
      }
    }
    if (currentValue !== null && currentValue >= 0 && currentValue <= total) {
      const usedPercent = clampPercent((currentValue / total) * 100);
      if (usedPercent !== null) {
        return { leftPercent: 100 - usedPercent, usedPercent };
      }
    }
  }

  // Path 3: legacy `percentage` (treated as used percent — GLM convention).
  const usedPercent = clampPercent(limit.percentage);
  if (usedPercent === null) return null;
  return { leftPercent: 100 - usedPercent, usedPercent };
}

/** Map a `type` to a coarse category used for label/key derivation. */
function categoryOf(type: string): "token" | "mcp" | "other" {
  switch (type) {
    case "TOKENS_LIMIT":
      return "token";
    case "MCP_LIMIT":
    case "TIME_LIMIT":
      return "mcp";
    default:
      return "other";
  }
}

/**
 * Derive a stable key and human-readable label for a limit.
 *
 * Known windows get friendly labels; anything else falls back to the raw
 * `type` (or `"Quota"`) so it still renders.
 */
function deriveLabel(
  limit: RawLimit,
  category: "token" | "mcp" | "other",
): {
  key: string;
  label: string;
} {
  const number = limit.number;
  if (category === "token") {
    // GLM convention: number===5 → 5-hour window; number===7 → weekly.
    if (number === 5) return { key: "token_5h", label: "5h" };
    if (number === 7) return { key: "token_week", label: "Week" };
    if (number !== undefined) return { key: `token_${number}`, label: `${number}` };
    return { key: "token", label: "Token" };
  }
  if (category === "mcp") {
    return { key: "mcp", label: "MCP" };
  }
  // Unknown type — surface it verbatim rather than hide it.
  const fallback = limit.type || "Quota";
  return { key: fallback.toLowerCase(), label: fallback };
}

/**
 * Parse one raw limit into a {@link QuotaItem}, or `null` if no percentage
 * can be computed (the limit is then dropped from display).
 */
export function parseLimit(limit: RawLimit): QuotaItem | null {
  const percent = computePercentages(limit);
  if (!percent) return null;

  const category = categoryOf(limit.type);
  const { key, label } = deriveLabel(limit, category);

  const item: QuotaItem = {
    key,
    label,
    usedPercent: percent.usedPercent,
    leftPercent: percent.leftPercent,
  };

  // Absolute counters — only some limit kinds carry them (MCP/TIME_LIMIT do,
  // legacy TOKENS_LIMIT often does not). Surface them when present so the
  // formatter can show "(used / total)".
  const usedCount = asFiniteNumber(limit.currentValue);
  if (usedCount !== null) item.usedCount = usedCount;
  const totalCount = asFiniteNumber(limit.usage);
  if (totalCount !== null) item.totalCount = totalCount;

  const nextResetTime = asFiniteNumber(limit.nextResetTime);
  if (nextResetTime !== null) item.nextResetTime = nextResetTime;

  if (Array.isArray(limit.usageDetails) && limit.usageDetails.length > 0) {
    item.detail = limit.usageDetails;
  }

  return item;
}

/** Auth-failure detection from the business-layer `msg` (zh/en keywords). */
function isAuthFailureMessage(msg: unknown): boolean {
  return typeof msg === "string" && /authorization|auth|token|鉴权|授权|未登录/i.test(msg);
}

/** Rate-limit detection from the business-layer `msg` (zh/en keywords). */
function isRateLimitedMessage(msg: unknown): boolean {
  return (
    typeof msg === "string" &&
    /rate\s*limit|too many requests|too frequent|frequency|限流|频率|过于频繁|稍后再试/i.test(msg)
  );
}

/** Shape of the successful API envelope we expect: `{ success, data: { level, limits } }`. */
interface QuotaEnvelope {
  success?: boolean;
  code?: number;
  msg?: string;
  data?: { level?: string; limits?: RawLimit[] };
}

/**
 * Parse the full API response (already classified by the fetch layer as a
 * `response` with a status + body) into a {@link QuotaResult}.
 *
 * State machine: 429/rate-limit text → `rate_limited`; auth codes/text →
 * `auth_error`; success with zero parseable items → `unavailable`; otherwise
 * the items are returned in original order.
 */
export function parseQuotaEnvelope(envelope: {
  status: number;
  json: unknown;
  text: string;
}): QuotaResult {
  // HTTP-level rate limit.
  if (envelope.status === 429 || isRateLimitedMessage(envelope.text)) {
    return { kind: "rate_limited" };
  }

  const payload = envelope.json as QuotaEnvelope | null;
  if (!payload || typeof payload !== "object") {
    return { kind: "unavailable" };
  }

  if (payload.success !== true) {
    if (payload.code === 1001 || payload.code === 401 || isAuthFailureMessage(payload.msg)) {
      return { kind: "auth_error" };
    }
    if (isRateLimitedMessage(payload.msg)) {
      return { kind: "rate_limited" };
    }
    return { kind: "unavailable" };
  }

  const limits = Array.isArray(payload.data?.limits) ? payload.data!.limits! : [];
  const items = limits
    .map(parseLimit)
    .filter((x): x is QuotaItem => x !== null)
    .sort(byDisplayOrder);
  if (items.length === 0) {
    return { kind: "unavailable" };
  }

  return {
    kind: "success",
    level: typeof payload.data?.level === "string" ? payload.data.level : "",
    items,
  };
}

/**
 * Display ordering: token windows first (5h before Week before other token
 * windows), then MCP, then anything else — by stable key. Keeps the card
 * layout predictable regardless of the API's array order.
 */
function byDisplayOrder(a: QuotaItem, b: QuotaItem): number {
  return rankOf(a.key) - rankOf(b.key) || a.key.localeCompare(b.key);
}

/** Stable rank for a quota key — lower renders first. */
function rankOf(key: string): number {
  if (key === "token_5h") return 0;
  if (key === "token_week") return 1;
  if (key.startsWith("token_")) return 2; // other token windows
  if (key === "mcp") return 3;
  return 4; // unknown types last
}
