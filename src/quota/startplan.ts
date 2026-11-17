/**
 * ZCode Start Plan quota reader (`billing/balance`).
 *
 * The Start Plan gateway (`zcode.z.ai`, the "ZCODE <promo>" plans such as
 * ZCODE GLOBAL BUILD) is a separate backend from the GLM Coding Plan MaaS
 * (`api.z.ai` / `open.bigmodel.cn`): the classic `/api/monitor/usage/quota/limit`
 * endpoint answers "no coding plan" for these accounts, and the plan apiKey is
 * not accepted there. The desktop app instead reads plan entitlement from
 * `GET /api/v1/zcode-plan/billing/current` and per-entitlement usage from
 * `GET /api/v1/zcode-plan/billing/balance` — this module mirrors those calls
 * with the same two credentials the app sends:
 *
 *  - the Start Plan JWT from the encrypted credential store, via
 *    `storeStartPlanJwt()` (the `zcodejwttoken` the 3.15+ desktop hosts for
 *    `account:*-start-plan`), sent as `Authorization: Bearer …`;
 *  - the device id (`deviceMid`) from `telemetry-state.json` — the same
 *    identity `settings/app-update.ts` reads for the update check — sent as
 *    `X-Device-Mid`. Without it the gateway answers `400 parameter error`
 *    (verified 2026-11-12); no other header or query parameter is required.
 *
 * `billing/balance` returns both `plans[]` (the promo identity: name, status,
 * window) and `balances[]` (per-entitlement token counters). Entitlements are
 * `one_time` grants, so `expires_at` / `period_end` is the grant's deadline,
 * not a recurring reset — callers must not present it as a guaranteed refill.
 *
 * Results are cached process-wide for 10s like every other quota reader
 * (`quota/cache.ts`, `opencode-go/cache.ts`): repeated `account/usage_stats`
 * calls — ACP, CLI, hub fallback — collapse to at most one gateway hit per
 * TTL window. Parsed results (any `kind`, failures included) are cached;
 * thrown failures — network errors and status-line auth/rate-limit — are not,
 * so the next call retries.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { storeStartPlanJwt } from "../config/account-provider.js";
import { log, zcodeHomeDir } from "../utils.js";

/** Request timeout (ms). The endpoint is fast; keep this tight. */
const TIMEOUT_MS = 8000;

/** Balance endpoint on the Start Plan gateway. */
const BALANCE_PATH = "/api/v1/zcode-plan/billing/balance";

/** Default gateway origin. `ZCODE_ENDPOINT_ORIGIN` overrides (self-hosted). */
function apiOrigin(env: NodeJS.ProcessEnv): string {
  return env.ZCODE_ENDPOINT_ORIGIN ?? env.ZCODE_BASE_URL ?? "https://zcode.z.ai";
}

/** Raw one-entitlement balance row from `data.balances[]`. */
interface RawBalance {
  user_plan_id?: unknown;
  plan_id?: unknown;
  plan_name?: unknown;
  entitlement_id?: unknown;
  show_name?: unknown;
  meter?: unknown;
  unit_type?: unknown;
  capabilities?: unknown;
  total_units?: unknown;
  used_units?: unknown;
  remaining_units?: unknown;
  available_units?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  expires_at?: unknown;
}

/** Raw plan row from `data.plans[]`. */
interface RawPlan {
  user_plan_id?: unknown;
  plan_id?: unknown;
  name?: unknown;
  status?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
}

interface BalanceEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: { plans?: unknown; balances?: unknown };
}

/** Normalised window: one entitlement's usage, ready for the stats sections. */
export interface StartPlanWindow {
  /** Stable per-entitlement key, e.g. "ent-zcode-v3-start-plan-1112-1". */
  key: string;
  /** Human label: "<plan name> · <model>", e.g. "ZCODE GLOBAL BUILD · GLM-5.3-Flash". */
  label: string;
  /** Plan name verbatim from the API, e.g. "ZCODE GLOBAL BUILD". */
  plan: string;
  /** Model the entitlement meters, from `show_name` (e.g. "GLM-5.3-Flash"). */
  model: string;
  /** Model ids derived from `capabilities` ("model:<id>" → "<id>"). */
  modelIds: string[];
  /** Used percentage, clamped to [0, 100]. */
  usagePercent: number;
  /** Absolute counters (tokens). */
  usedUnits: number;
  totalUnits: number;
  remainingUnits: number;
  /** Grant deadline (epoch ms). One-time grants do not refill after it. */
  resetsAt?: number;
  /** Always true today — the API only issues `one_time` start-plan grants. */
  oneTime: boolean;
}

/** Account credentials the gateway requires: the hosted JWT plus the device id. */
interface StartPlanAuth {
  jwt: string;
  deviceMid: string;
}

export type StartPlanResult =
  | {
      kind: "success";
      /** Active plan id, e.g. "zcode-v3-start-plan-1112". */
      planId: string;
      /** Active plan name verbatim, e.g. "ZCODE GLOBAL BUILD". */
      planName: string;
      windows: StartPlanWindow[];
    }
  | {
      kind: "auth_error";
    }
  | {
      kind: "rate_limited";
    }
  | {
      kind: "unavailable";
    };

/**
 * Failure the gateway reports on the HTTP status line (a 401/403/429 body may
 * be HTML from a proxy, not the JSON envelope) — mapped per proposal 0002's
 * kind vocabulary before it can degrade to `unavailable`.
 */
class StartPlanStatusError extends Error {
  constructor(
    readonly kind: "auth_error" | "rate_limited",
    readonly status: number,
  ) {
    super(`startplan: HTTP ${status}`);
  }
}

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" ? (Number.isFinite(value) ? value : null) : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const epochMsFromSeconds = (value: unknown): number | undefined => {
  const n = asFiniteNumber(value);
  return n !== null && n > 0 ? n * 1000 : undefined;
};

/** Printable-ASCII device ids only — the same tolerance app-update.ts applies. */
const DEVICE_MID_PATTERN = /^[\x20-\x7e]+$/u;

/**
 * Read the Start Plan credentials: the account JWT (via `storeStartPlanJwt()`)
 * and the device id from `telemetry-state.json` — the same identity
 * `settings/app-update.ts` sends to the release service. `null` when either
 * is absent: the gateway requires both.
 */
export function readZcodeAccountAuth(): StartPlanAuth | null {
  const jwt = storeStartPlanJwt();
  let deviceMid: string | undefined;
  try {
    const stateFile = path.join(zcodeHomeDir(), "v2", "telemetry-state.json");
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as { deviceMid?: unknown };
    if (typeof parsed.deviceMid === "string") {
      const candidate = parsed.deviceMid.trim();
      deviceMid = candidate && DEVICE_MID_PATTERN.test(candidate) ? candidate : undefined;
    }
  } catch {
    // Absent or unreadable telemetry state — without a device id the
    // gateway answers 400, so the reader is unavailable.
  }
  return jwt && deviceMid ? { jwt, deviceMid } : null;
}

/**
 * Pick the plan the desktop considers current: active status, start-plan
 * spelling first (plan_id "zcode-*" / name "ZCODE *"), then any active row —
 * every plan on this gateway is a ZCode plan, so the catch-all is safe.
 */
function pickActiveStartPlan(plans: RawPlan[]): RawPlan | null {
  const active = plans.filter((p) => asString(p.status)?.toLowerCase() === "active");
  return (
    active.find((p) => /^zcode-/iu.test(asString(p.plan_id) ?? "")) ??
    active.find((p) => /^zcode /iu.test(asString(p.name) ?? "")) ??
    active[0] ??
    null
  );
}

/** Parse the `billing/balance` envelope into normalised windows. */
export function parseStartPlanBalance(payload: BalanceEnvelope): StartPlanResult {
  if (typeof payload.code === "number" && payload.code !== 0) {
    // 3101 "coding plan is required" → not entitled; 3001 parameter/auth
    // shape issues → treat as unavailable rather than a hard failure.
    if (payload.code === 401) return { kind: "auth_error" };
    return { kind: "unavailable" };
  }
  const plans = Array.isArray(payload.data?.plans) ? (payload.data!.plans as RawPlan[]) : [];
  const balances = Array.isArray(payload.data?.balances)
    ? (payload.data!.balances as RawBalance[])
    : [];
  const startPlan = pickActiveStartPlan(plans);
  if (!startPlan) return { kind: "unavailable" };
  const planName = asString(startPlan.name) ?? asString(startPlan.plan_id) ?? "ZCODE plan";
  const planId = asString(startPlan.plan_id) ?? "";
  const windows = balances
    .filter((b) => {
      const matchesPlan =
        asString(b.user_plan_id) === asString(startPlan.user_plan_id) ||
        asString(b.plan_id) === planId;
      const total = asFiniteNumber(b.total_units);
      return matchesPlan && total !== null && total > 0;
    })
    .map((b): StartPlanWindow => {
      const totalUnits = asFiniteNumber(b.total_units) ?? 0;
      const usedUnits = Math.max(0, asFiniteNumber(b.used_units) ?? 0);
      const remainingRaw = asFiniteNumber(b.remaining_units);
      const remainingUnits = Math.max(
        0,
        remainingRaw ?? (usedUnits > 0 ? totalUnits - usedUnits : totalUnits),
      );
      const capabilities = Array.isArray(b.capabilities)
        ? b.capabilities.filter((c): c is string => typeof c === "string")
        : [];
      const modelIds = capabilities
        .map((c) => (c.startsWith("model:") ? c.slice(6) : c))
        .filter((c) => c.trim().length > 0);
      const resetsAt = epochMsFromSeconds(b.expires_at ?? b.period_end);
      return {
        key: asString(b.entitlement_id) ?? `${planId}:${asString(b.meter) ?? "usage"}`,
        label: `${planName} · ${asString(b.show_name) ?? modelIds[0] ?? "grant"}`,
        plan: planName,
        model: asString(b.show_name) ?? modelIds[0] ?? "",
        modelIds,
        usagePercent: Math.max(0, Math.min(100, (usedUnits / totalUnits) * 100)),
        usedUnits,
        totalUnits,
        remainingUnits,
        ...(resetsAt !== undefined && { resetsAt }),
        oneTime: true,
      };
    });
  return { kind: "success", planId, planName, windows };
}

/**
 * Fetch the balance envelope. Throws on missing credentials, status-line
 * failures ({@link StartPlanStatusError}) or network errors — the caller maps
 * them to `kind`s, and unknown ones to `unavailable`.
 */
async function fetchStartPlanBalance(
  auth: StartPlanAuth,
  fetchImpl: typeof fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BalanceEnvelope> {
  const resp = await fetchImpl(apiOrigin(env) + BALANCE_PATH, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: auth.jwt.startsWith("Bearer ") ? auth.jwt : `Bearer ${auth.jwt}`,
      "X-Device-Mid": auth.deviceMid,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new StartPlanStatusError("auth_error", resp.status);
  }
  if (resp.status === 429) {
    throw new StartPlanStatusError("rate_limited", resp.status);
  }
  const text = await resp.text();
  let json: BalanceEnvelope | null = null;
  try {
    json = text ? (JSON.parse(text) as BalanceEnvelope) : null;
  } catch {
    // Non-JSON body — treated as unavailable by the parser.
  }
  if (json === null) {
    throw new Error(`startplan: non-JSON response (HTTP ${resp.status})`);
  }
  return json;
}

/** Cache TTL — mirrors `quota/cache.ts` and the other per-reader caches. */
const CACHE_TTL_MS = 10_000;

let cache: { at: number; result: StartPlanResult } | null = null;

/** Test-only: drop the cached result (the `setClock` hook of `quota/cache.ts`). */
export function resetStartPlanCacheForTests(): void {
  cache = null;
}

/**
 * Query the active Start Plan's usage. Never throws: every failure mode maps
 * to a `kind` so the stats handler can report per-section status.
 */
export async function queryStartPlan(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<StartPlanResult> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
  const auth = readZcodeAccountAuth();
  if (!auth) return { kind: "unavailable" };
  try {
    const result = parseStartPlanBalance(
      await fetchStartPlanBalance(auth, fetchImpl, process.env),
    );
    cache = { at: Date.now(), result };
    return result;
  } catch (error) {
    if (error instanceof StartPlanStatusError) return { kind: error.kind };
    log(
      `startplan: balance query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { kind: "unavailable" };
  }
}
