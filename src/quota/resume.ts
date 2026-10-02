/**
 * Quota-exhaustion classification and reset-time math — the shared brain of
 * the two auto-resume paths (workflow run watchdog, /auto goal-loop wait).
 *
 * Why this exists: a GlM-style usage cap (business code 1308, …) is a
 * DETERMINISTIC model failure — upstream's workflow policy stops the whole run
 * as `stopped(provider)` with `ProviderStopDetails{kind:"quota"}` and its
 * notification tells the main agent to call ResumeWorkflowRun AFTER the reset
 * (workflow-model-failure-policy.ts:36-55 workflown quata codes;
 * workflow-notification-copy.ts:55-64). Nothing in the stack schedules that
 * "after": the desktop expects a human/model to act later. The bridge owns
 * both surfaces that CAN wait (the /auto driver and the workflow poller), so
 * the wait-and-continue behavior lives here.
 *
 * Everything is defensive: error payload shapes span bridge RequestError data,
 * raw turn.failed causes, and upstream WorkflowErrorJson — read by shape,
 * never by class identity.
 */

import type { QuotaResult } from "./types.js";

/** Upstream stop-class quota business codes (adapters/src/model/workflow-model-failure-policy.ts:36-55). */
export const QUOTA_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "1005",
  "1308",
  "1310",
  "1313",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "2056",
  "20097",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);

/**
 * A window at/above this used-percent counts as exhausted when a quota stop
 * was already observed (only used to pick the reset moment, never to detect a
 * stop by itself). 98 leaves room for the API's integer rounding.
 */
export const QUOTA_EXHAUSTED_PERCENT = 98;

/** Provider business code and/or reset moment of a quota exhaustion. */
export interface QuotaExhaustionInfo {
  providerCode?: string;
  /** Reset moment (epoch ms) when the provider (or a Retry-After) told us. */
  resetAt?: number;
}

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Message wording that points at quota rather than a plain rate limit. */
const QUOTA_MESSAGE_HINT = /quota|usage cap|额度|配额|余额|balance|credit/i;

/** Explicit `[<business code>]` bracket (upstream driver message format). */
const QUOTA_CODE_BRACKET =
  /\[(1005|1308|1310|1313|1316|1317|1318|1319|1320|1321|2056|20097|insufficient_quota|credit_balance_exhausted|organization_spend_limit_exceeded|project_spend_limit_exceeded|organization_usage_limit_exceeded|exceeded_current_quota_error)\]/;

/**
 * Whether a run's `failureMessage` reads as a quota stop. Used by the
 * workflow scan, where only the summary string travels — the structured
 * `providerStop` does not. The bracket check mirrors the upstream driver's
 * fixed message format; the wording fallback covers providers without a
 * numeric code. Re-check against `workflow-notification-copy.ts` on version
 * bumps.
 */
export function isQuotaStopFailureMessage(message: unknown): boolean {
  if (typeof message !== "string" || message === "") return false;
  if (QUOTA_CODE_BRACKET.test(message)) return true;
  return message.includes("rate_limited") && QUOTA_MESSAGE_HINT.test(message);
}

/**
 * Classify an error as a quota exhaustion, digging through the shapes seen in
 * practice: bridge `RequestError.data` (AcpTurnFailureData), raw turn.failed
 * `cause`/`context`, and upstream WorkflowErrorJson (`providerStop`).
 *
 * The structured `providerStop.kind` verdict is authoritative when present —
 * a non-quota stop never falls through to the message heuristics.
 */
export function classifyQuotaExhaustion(error: unknown): QuotaExhaustionInfo | undefined {
  const root = asRec(error);
  if (!root) return undefined;

  const nodes: Rec[] = [];
  const visit = (value: unknown, depth: number): void => {
    const rec = asRec(value);
    if (!rec || depth > 3) return;
    nodes.push(rec);
    visit(rec["data"], depth + 1);
    visit(rec["cause"], depth + 1);
    visit(rec["context"], depth + 1);
  };
  visit(error, 0);

  // Structured workflow provider stop wins — including a negative verdict.
  for (const node of nodes) {
    const stop = asRec(node["providerStop"]);
    if (!stop) continue;
    if (stop["kind"] !== "quota") return undefined;
    const info = infoFromStop(stop);
    return info;
  }

  const providerCode =
    firstString(nodes, ["providerCode"]) ?? firstCodeInQuotaSet(nodes) ?? undefined;
  const resetAt = resetAtFromNodes(nodes);
  if (providerCode !== undefined && QUOTA_PROVIDER_CODES.has(providerCode)) {
    return { providerCode, ...(resetAt === undefined ? {} : { resetAt }) };
  }

  // No usable code: a non-retryable rate-limit rejection whose wording says
  // quota. Deliberately conservative — a plain rate limit is retried upstream
  // with backoff and never reaches a stop.
  const reason = firstString(nodes, ["reason"]) ?? "";
  const retryable = firstBool(nodes, ["retryable"]);
  const message = firstString(nodes, ["message", "detail"]) ?? "";
  if (
    (reason === "rate_limited" || reason === "invalid_request") &&
    retryable !== true &&
    QUOTA_MESSAGE_HINT.test(message)
  ) {
    return { ...(resetAt === undefined ? {} : { resetAt }) };
  }
  return undefined;
}

function infoFromStop(stop: Rec): QuotaExhaustionInfo {
  const providerCode =
    typeof stop["providerCode"] === "string" && stop["providerCode"]
      ? stop["providerCode"]
      : undefined;
  const resetAt = finiteNumber(stop["resetAt"]);
  return {
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(resetAt === undefined || resetAt <= Date.now() ? {} : { resetAt }),
  };
}

function firstString(nodes: Rec[], keys: readonly string[]): string | undefined {
  for (const node of nodes) {
    for (const key of keys) {
      const v = node[key];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  return undefined;
}

function firstBool(nodes: Rec[], keys: readonly string[]): boolean | undefined {
  for (const node of nodes) {
    for (const key of keys) {
      const v = node[key];
      if (typeof v === "boolean") return v;
    }
  }
  return undefined;
}

/** A `code` value that is itself a quota business code (raw error spellings). */
function firstCodeInQuotaSet(nodes: Rec[]): string | undefined {
  for (const node of nodes) {
    const code = node["code"];
    if (typeof code === "string" && QUOTA_PROVIDER_CODES.has(code)) return code;
  }
  return undefined;
}

/** `resetAt` from a Retry-After-derived duration or an explicit timestamp. */
function resetAtFromNodes(nodes: Rec[]): number | undefined {
  for (const node of nodes) {
    const direct = finiteNumber(node["resetAt"]);
    if (direct !== undefined && direct > Date.now()) return direct;
  }
  for (const node of nodes) {
    const ms = finiteNumber(node["retryAfterMs"]);
    if (ms !== undefined && ms > 0) return Date.now() + ms;
    const seconds = finiteNumber(node["retryAfterSeconds"]);
    if (seconds !== undefined && seconds > 0) return Date.now() + seconds * 1000;
  }
  return undefined;
}

/**
 * The moment to try again, derived from a fresh quota card: the EARLIEST
 * future reset among windows already at/near exhaustion. Min (not max) is
 * deliberate: resuming a touch early only costs one rejected request, while
 * waiting for the LAST window can delay work by days when a second window was
 * only caught by the rounding margin.
 */
export function quotaResetAtFromResult(result: QuotaResult, now = Date.now()): number | undefined {
  if (result.kind !== "success") return undefined;
  let best: number | undefined;
  for (const item of result.items) {
    if (item.usedPercent < QUOTA_EXHAUSTED_PERCENT) continue;
    const reset = item.nextResetTime;
    if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= now) continue;
    if (best === undefined || reset < best) best = reset;
  }
  return best;
}

/**
 * Exponential backoff for resume attempts with no known reset moment
 * (attempt 1 = base). Capped so a long outage still gets periodic tries
 * without hammering a provider that is plainly still capped.
 */
export function quotaBackoffMs(
  attempt: number,
  baseMs = 5 * 60_000,
  capMs = 2 * 60 * 60_000,
): number {
  const raw = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, capMs);
}
