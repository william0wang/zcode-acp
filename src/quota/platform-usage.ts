/**
 * Platform usage statistics — the account-level monitor data behind the
 * desktop app's Coding Plan usage tab, aggregated for the mobile app's Usage
 * page (contract: `.zcode/docs/platform-usage-backend-requirements.md` in the
 * app repo).
 *
 * Lives in `src/quota/` next to the monitor client: same upstream family
 * (BigModel/Z.AI monitor API), same host derivation and credentials as the
 * quota windows. The settings route (`src/remote/settings-endpoint.ts`) mounts
 * it under `GET /settings/usage-platform`.
 *
 * Three upstream blocks are read in parallel (activity is a fixed 365-day
 * window; model/tool detail follow the requested range), each defensively
 * parsed: a missing block is empty data, not an error, and only a total
 * failure surfaces an error kind. Normalization is ported from the desktop
 * mapper (`packages/services/src/usage-stats/providers/bigmodelUsageMonitorMapper.ts`),
 * including its two load-bearing quirks:
 *
 *  - credit-usage "cached/uncached/output" rows are billing components, not
 *    models — unfiltered they would double the totals;
 *  - every numeric field may arrive as number, numeric string or null.
 */

import {
  fetchMonitorResponse,
  type MonitorEndpoint,
  type MonitorResponse,
} from "./monitor-client.js";
import { isAuthFailureMessage, isRateLimitedMessage } from "./parse.js";
import { log } from "../utils.js";

export type PlatformUsageRange = "today" | "7d" | "30d";
export type PlatformUsageKind = "success" | "auth_error" | "rate_limited" | "unavailable";
type PlatformUsageError = Exclude<PlatformUsageKind, "success">;

export const PLATFORM_USAGE_RANGES: ReadonlySet<string> = new Set(["today", "7d", "30d"]);

export function isPlatformUsageRange(value: string): value is PlatformUsageRange {
  return PLATFORM_USAGE_RANGES.has(value);
}

export interface PlatformHeatmapCell {
  date: string;
  level: number;
  tokens: number;
}

export interface PlatformActivity {
  summary: {
    totalTokens: number;
    peakDailyTokens: number;
    peakDailyTokensDate: string | null;
    totalUsageDurationMs: number;
    currentStreakDays: number;
    longestStreakDays: number;
  };
  heatmap: {
    startDate: string | null;
    endDate: string | null;
    maxTokens: number;
    weeks: Array<{ days: Array<PlatformHeatmapCell | null> }>;
  };
}

export interface PlatformDetailSummary {
  cacheHitRate: number | null;
  cacheHitRateTrend: number | null;
  totalCredits: number;
  totalCreditsTrend: number | null;
  averageDailyCredits: number;
  averageDailyCreditsTrend: number | null;
}

export interface PlatformModelRow {
  name: string;
  totalTokens: number;
  totalCredits?: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  sortOrder: number;
}

export interface PlatformToolRow {
  name: string;
  totalUsageCount: number;
  totalCredits?: number;
}

export interface PlatformSeries {
  granularity: "hour" | "day";
  xTime: string[];
  totals: number[];
}

export interface PlatformUsageResult {
  kind: PlatformUsageKind;
  range: PlatformUsageRange;
  generatedAt: number;
  activity?: PlatformActivity;
  detail?: { model: PlatformDetailSummary | null; tool: PlatformDetailSummary | null };
  models?: PlatformModelRow[];
  tools?: PlatformToolRow[];
  series?: PlatformSeries;
}

// ---- raw upstream shapes (all fields optional; the platform is inconsistent) --

type Series = Array<number | string | null | undefined>;

interface RawMetric {
  value?: number | string | null;
  trend?: number | string | null;
}

interface RawActivityPayload {
  summary?: {
    totalTokens?: number | string | null;
    peakDailyTokens?: number | string | null;
    peakDailyTokensDate?: string | null;
    totalUsageDurationMs?: number | string | null;
    currentStreakDays?: number | string | null;
    longestStreakDays?: number | string | null;
  } | null;
  series?: Array<{
    date?: string | null;
    totalTokens?: number | string | null;
    modelCallCount?: number | string | null;
    mcpCalls?: number | string | null;
  }>;
}

interface RawModelDataItem {
  modelCode?: string | null;
  modelName?: string | null;
  sortOrder?: number | null;
  totalTokens?: number | string | null;
  totalCredits?: number | string | null;
  totalTokensUsage?: Series;
  totalCreditsUsage?: Series;
  tokensUsage?: Series;
  cachedInputTokensUsage?: Series;
  uncachedInputTokensUsage?: Series;
  outputTokensUsage?: Series;
  cachedInputCreditsUsage?: Series;
  uncachedInputCreditsUsage?: Series;
  outputCreditsUsage?: Series;
}

interface RawMcpDataItem {
  mcpCode?: string | null;
  mcpName?: string | null;
  toolCode?: string | null;
  toolName?: string | null;
  sortOrder?: number | null;
  totalCredits?: number | string | null;
  totalUsageCount?: number | string | null;
  creditsUsage?: Series;
  mcpCallCount?: Series;
  usageCount?: Series;
}

interface RawDetailPayload {
  summary?: {
    cacheHitRate?: RawMetric | null;
    totalCredits?: RawMetric | null;
    averageDailyCredits?: RawMetric | null;
  } | null;
  modelUsage?: { xTime?: string[]; modelDataList?: RawModelDataItem[] } | null;
  mcpUsage?: { xTime?: string[]; mcpDataList?: RawMcpDataItem[] } | null;
}

/** Legacy monitor model-usage payload (the fallback when usage-detail is empty). */
interface RawModelUsagePayload {
  x_time?: string[];
  tokensUsage?: Series;
  totalUsage?: {
    totalTokensUsage?: number | string | null;
    modelSummaryList?: Array<{
      modelName?: string | null;
      totalTokens?: number | string | null;
      sortOrder?: number | null;
    }>;
  } | null;
  modelSummaryList?: Array<{
    modelName?: string | null;
    totalTokens?: number | string | null;
    sortOrder?: number | null;
  }>;
}

/** Legacy monitor tool-usage payload (the fallback when usage-detail is empty). */
interface RawToolUsagePayload {
  totalUsage?: {
    toolSummaryList?: Array<{
      toolCode?: string | null;
      toolName?: string | null;
      totalUsageCount?: number | string | null;
      sortOrder?: number | null;
    }>;
  } | null;
  toolSummaryList?: Array<{
    toolCode?: string | null;
    toolName?: string | null;
    totalUsageCount?: number | string | null;
    sortOrder?: number | null;
  }>;
}

// ---- numeric tolerance (desktop `toFiniteNumber` semantics) --------------------

function toFiniteNumber(value: number | string | null | undefined): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function sumSeries(series: Series | undefined): number {
  return (series ?? []).reduce<number>((sum, value) => sum + (toFiniteNumber(value) ?? 0), 0);
}

/** First series in the list with any positive value, normalized to numbers. */
function firstNonEmptySeries(list: Array<Series | undefined>): number[] | undefined {
  const found = list.find((s) => Array.isArray(s) && s.some((v) => (toFiniteNumber(v) ?? 0) > 0));
  return found ? found.map((v) => toFiniteNumber(v) ?? 0) : undefined;
}

/** Element-wise sum (desktop `sumSeries`) — pads shorter lists with zeros. */
function sumSeriesAll(list: Array<Series | undefined>): Series | undefined {
  const maxLength = Math.max(0, ...list.map((s) => s?.length ?? 0));
  if (maxLength === 0) return undefined;
  return Array.from({ length: maxLength }, (_, i) =>
    list.reduce((sum, s) => sum + (toFiniteNumber(s?.[i]) ?? 0), 0),
  );
}

// ---- envelope classification ---------------------------------------------------

interface MonitorEnvelope {
  success?: boolean;
  code?: number;
  msg?: string;
  data?: unknown;
}

type BlockOutcome = { ok: true; data: unknown } | { ok: false; kind: PlatformUsageError };

function classifyMonitor(resp: MonitorResponse): BlockOutcome {
  if (resp.status === 429 || isRateLimitedMessage(resp.text)) {
    return { ok: false, kind: "rate_limited" };
  }
  const payload = resp.json as MonitorEnvelope | null;
  if (!payload || typeof payload !== "object") return { ok: false, kind: "unavailable" };
  const success =
    payload.success === true || (payload.success === undefined && payload.code === 200);
  if (!success) {
    if (
      resp.status === 401 ||
      resp.status === 403 ||
      payload.code === 1001 ||
      payload.code === 401 ||
      isAuthFailureMessage(payload.msg)
    ) {
      return { ok: false, kind: "auth_error" };
    }
    if (isRateLimitedMessage(payload.msg)) return { ok: false, kind: "rate_limited" };
    return { ok: false, kind: "unavailable" };
  }
  // `data: null` is an empty payload, not an error (desktop treats it the same).
  const data = payload.data;
  return { ok: true, data: data && typeof data === "object" ? data : {} };
}

async function safeFetch(
  endpoint: MonitorEndpoint,
  search: Record<string, string>,
): Promise<BlockOutcome> {
  try {
    return classifyMonitor(await fetchMonitorResponse(endpoint, search));
  } catch (e) {
    log(`platform-usage: ${endpoint} failed (${e instanceof Error ? e.message : String(e)})`);
    return { ok: false, kind: "unavailable" };
  }
}

// ---- time ranges (desktop parity: local day keys, `YYYY-MM-DD HH:mm:ss`) -------

function localDateKey(date: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(dateKey: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function monitorTimeRange(
  range: PlatformUsageRange,
  now: Date,
): {
  startTime: string;
  endTime: string;
  granularity: "hour" | "day";
} {
  const endKey = localDateKey(now);
  if (range === "today") {
    return { startTime: `${endKey} 00:00:00`, endTime: `${endKey} 23:59:59`, granularity: "hour" };
  }
  const startKey = addDays(endKey, range === "7d" ? -6 : -29);
  return { startTime: `${startKey} 00:00:00`, endTime: `${endKey} 23:59:59`, granularity: "day" };
}

function activityTimeRange(now: Date): { startTime: string; endTime: string } {
  const endKey = localDateKey(now);
  return { startTime: `${addDays(endKey, -365)} 00:00:00`, endTime: `${endKey} 23:59:59` };
}

// ---- activity + heatmap ----------------------------------------------------------

const DAY_MS = 86_400_000;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function dateKeyToUtcDayIndex(dateKey: string): number | null {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / DAY_MS);
}

function utcDayIndexToDateKey(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function levelForTokens(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

function buildActivity(payload: unknown): PlatformActivity {
  const raw = payload as RawActivityPayload;
  const cells = (raw.series ?? [])
    .map((item) => {
      const date = typeof item.date === "string" ? item.date.trim() : "";
      if (!DATE_KEY_PATTERN.test(date)) return null;
      return {
        date,
        tokens: toFiniteNumber(item.totalTokens) ?? 0,
        calls: toFiniteNumber(item.modelCallCount) ?? 0,
      };
    })
    .filter((cell): cell is { date: string; tokens: number; calls: number } => cell !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const maxTokens = Math.max(0, ...cells.map((cell) => cell.tokens));
  const byDate = new Map(cells.map((cell) => [cell.date, cell] as const));
  // UTC week starts (Sunday); days missing from the series stay null so the
  // grid keeps its shape.
  const weekStarts = new Map<number, Array<PlatformHeatmapCell | null>>();
  for (const cell of cells) {
    const dayIndex = dateKeyToUtcDayIndex(cell.date);
    if (dayIndex === null) continue;
    const weekStart = dayIndex - new Date(dayIndex * DAY_MS).getUTCDay();
    if (weekStarts.has(weekStart)) continue;
    weekStarts.set(
      weekStart,
      Array.from({ length: 7 }, (_, i) => {
        const date = utcDayIndexToDateKey(weekStart + i);
        const source = byDate.get(date);
        return source
          ? { date, level: levelForTokens(source.tokens, maxTokens), tokens: source.tokens }
          : null;
      }),
    );
  }
  const weeks = [...weekStarts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, days]) => ({ days }));

  return {
    summary: {
      totalTokens: toFiniteNumber(raw.summary?.totalTokens) ?? 0,
      peakDailyTokens: toFiniteNumber(raw.summary?.peakDailyTokens) ?? 0,
      peakDailyTokensDate: raw.summary?.peakDailyTokensDate?.trim() || null,
      totalUsageDurationMs: toFiniteNumber(raw.summary?.totalUsageDurationMs) ?? 0,
      currentStreakDays: toFiniteNumber(raw.summary?.currentStreakDays) ?? 0,
      longestStreakDays: toFiniteNumber(raw.summary?.longestStreakDays) ?? 0,
    },
    heatmap: {
      startDate: cells[0]?.date ?? null,
      endDate: cells.at(-1)?.date ?? null,
      maxTokens,
      weeks,
    },
  };
}

// ---- usage detail + models -------------------------------------------------------

const BREAKDOWN_BUCKET_CODES = new Set([
  "cached_input",
  "cachedInput",
  "cache_input",
  "cacheInput",
  "uncached_input",
  "uncachedInput",
  "output",
  "output_tokens",
  "outputTokens",
]);

function isBreakdownBucket(item: RawModelDataItem): boolean {
  const code = item.modelCode?.trim();
  if (code && BREAKDOWN_BUCKET_CODES.has(code)) return true;
  const name = item.modelName?.trim().toLowerCase();
  return name === "缓存" || name === "未缓存" || name === "输出";
}

function hasModelRows(block: NonNullable<RawDetailPayload["modelUsage"]>): boolean {
  return (block.modelDataList ?? []).some((item) =>
    Boolean(item?.modelName?.trim() || item?.modelCode?.trim()),
  );
}

function hasToolRows(block: NonNullable<RawDetailPayload["mcpUsage"]>): boolean {
  return (block.mcpDataList ?? []).some((item) =>
    Boolean(
      item?.mcpCode?.trim() ||
      item?.mcpName?.trim() ||
      item?.toolCode?.trim() ||
      item?.toolName?.trim(),
    ),
  );
}

function buildDetailSummary(payload: unknown): PlatformDetailSummary {
  const raw = (payload as RawDetailPayload).summary;
  return {
    cacheHitRate: toFiniteNumber(raw?.cacheHitRate?.value),
    cacheHitRateTrend: toFiniteNumber(raw?.cacheHitRate?.trend),
    totalCredits: toFiniteNumber(raw?.totalCredits?.value) ?? 0,
    totalCreditsTrend: toFiniteNumber(raw?.totalCredits?.trend),
    averageDailyCredits: toFiniteNumber(raw?.averageDailyCredits?.value) ?? 0,
    averageDailyCreditsTrend: toFiniteNumber(raw?.averageDailyCredits?.trend),
  };
}

function buildModelsFromDetail(
  block: NonNullable<RawDetailPayload["modelUsage"]>,
  granularity: "hour" | "day",
): { models: PlatformModelRow[]; series: PlatformSeries | null } {
  const rows = (block.modelDataList ?? [])
    .filter((item) => Boolean(item?.modelName?.trim() || item?.modelCode?.trim()))
    .filter((item) => !isBreakdownBucket(item))
    .map((item, index) => {
      const tokens =
        firstNonEmptySeries([
          item.totalTokensUsage,
          item.tokensUsage,
          sumSeriesAll([
            item.cachedInputTokensUsage,
            item.uncachedInputTokensUsage,
            item.outputTokensUsage,
          ]),
        ]) ?? [];
      const credits =
        firstNonEmptySeries([
          item.totalCreditsUsage,
          sumSeriesAll([
            item.cachedInputCreditsUsage,
            item.uncachedInputCreditsUsage,
            item.outputCreditsUsage,
          ]),
        ]) ?? [];
      return {
        name: item.modelName?.trim() || item.modelCode?.trim() || "unknown",
        sortOrder: toFiniteNumber(item.sortOrder) ?? index,
        tokens,
        totalTokens: toFiniteNumber(item.totalTokens) ?? sumSeries(tokens),
        totalCredits: toFiniteNumber(item.totalCredits) ?? sumSeries(credits),
        cachedInputTokens: sumSeries(item.cachedInputTokensUsage),
        uncachedInputTokens: sumSeries(item.uncachedInputTokensUsage),
        outputTokens: sumSeries(item.outputTokensUsage),
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // All rows share the payload's xTime, so element-wise summation IS the
  // per-bucket aggregate.
  const totals = rows.reduce<number[]>(
    (acc, row) => row.tokens.map((value, i) => (acc[i] ?? 0) + value),
    [],
  );
  const xTime = block.xTime ?? [];
  return {
    models: rows.map(({ tokens: _tokens, ...rest }) => rest),
    series: xTime.length > 0 ? { granularity, xTime, totals } : null,
  };
}

function buildModelsFromLegacy(
  payload: unknown,
  granularity: "hour" | "day",
): { models: PlatformModelRow[]; series: PlatformSeries | null } {
  const raw = payload as RawModelUsagePayload;
  const models = (raw.modelSummaryList ?? raw.totalUsage?.modelSummaryList ?? [])
    .filter((item) => Boolean(item?.modelName?.trim()))
    .map((item, index) => ({
      name: item.modelName!.trim(),
      sortOrder: toFiniteNumber(item.sortOrder) ?? index,
      totalTokens: toFiniteNumber(item.totalTokens) ?? 0,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const xTime = raw.x_time ?? [];
  return {
    models,
    series:
      xTime.length > 0
        ? {
            granularity,
            xTime,
            totals: (raw.tokensUsage ?? []).map((v) => toFiniteNumber(v) ?? 0),
          }
        : null,
  };
}

function buildToolsFromDetail(block: NonNullable<RawDetailPayload["mcpUsage"]>): PlatformToolRow[] {
  return (block.mcpDataList ?? [])
    .filter((item) =>
      Boolean(
        item?.mcpCode?.trim() ||
        item?.mcpName?.trim() ||
        item?.toolCode?.trim() ||
        item?.toolName?.trim(),
      ),
    )
    .map((item, index) => {
      const usage = firstNonEmptySeries([item.mcpCallCount, item.usageCount]) ?? [];
      const credits = item.creditsUsage ?? [];
      return {
        name:
          item.mcpName?.trim() ||
          item.toolName?.trim() ||
          item.mcpCode?.trim() ||
          item.toolCode?.trim() ||
          "unknown",
        sortOrder: toFiniteNumber(item.sortOrder) ?? index,
        totalUsageCount: toFiniteNumber(item.totalUsageCount) ?? sumSeries(usage),
        totalCredits: toFiniteNumber(item.totalCredits) ?? sumSeries(credits),
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ sortOrder: _sortOrder, ...rest }) => rest);
}

function buildToolsFromLegacy(payload: unknown): PlatformToolRow[] {
  const raw = payload as RawToolUsagePayload;
  return (raw.toolSummaryList ?? raw.totalUsage?.toolSummaryList ?? [])
    .filter((item) => Boolean(item?.toolCode?.trim() || item?.toolName?.trim()))
    .map((item) => ({
      name: item.toolName?.trim() || item.toolCode?.trim() || "unknown",
      totalUsageCount: toFiniteNumber(item.totalUsageCount) ?? 0,
    }));
}

// ---- orchestration ----------------------------------------------------------------

function dominantError(kinds: PlatformUsageError[]): PlatformUsageError {
  if (kinds.includes("auth_error")) return "auth_error";
  if (kinds.includes("rate_limited")) return "rate_limited";
  return "unavailable";
}

async function aggregate(range: PlatformUsageRange): Promise<PlatformUsageResult> {
  try {
    const now = new Date();
    const detailRange = monitorTimeRange(range, now);
    const failures: PlatformUsageError[] = [];
    const failed = (outcome: BlockOutcome): void => {
      if (!outcome.ok) failures.push(outcome.kind);
    };

    const [activityBlock, modelBlock, toolBlock] = await Promise.all([
      safeFetch("/api/monitor/credit-usage/activity", { ...activityTimeRange(now), type: "1" }),
      safeFetch("/api/monitor/credit-usage/usage-detail", {
        ...detailRange,
        type: "1",
        usageType: "MODEL",
      }),
      safeFetch("/api/monitor/credit-usage/usage-detail", {
        ...detailRange,
        type: "1",
        usageType: "MCP",
      }),
    ]);
    const anyPrimaryOk = activityBlock.ok || modelBlock.ok || toolBlock.ok;
    failed(activityBlock);
    failed(modelBlock);
    failed(toolBlock);

    let models: PlatformModelRow[] | null = null;
    let tools: PlatformToolRow[] | null = null;
    let series: PlatformSeries | null = null;

    // Fallback chain: the legacy monitor series when usage-detail carries no
    // usable rows for the block (absent, empty, or errored).
    const modelDetail = modelBlock.ok
      ? ((modelBlock.data as RawDetailPayload).modelUsage ?? null)
      : null;
    if (modelDetail && hasModelRows(modelDetail)) {
      ({ models, series } = buildModelsFromDetail(modelDetail, detailRange.granularity));
    } else {
      const legacy = await safeFetch("/api/monitor/usage/model-usage", {
        ...detailRange,
        type: "1",
      });
      if (legacy.ok) {
        ({ models, series } = buildModelsFromLegacy(legacy.data, detailRange.granularity));
      } else {
        failed(legacy);
      }
    }

    const toolDetail = toolBlock.ok
      ? ((toolBlock.data as RawDetailPayload).mcpUsage ?? null)
      : null;
    if (toolDetail && hasToolRows(toolDetail)) {
      tools = buildToolsFromDetail(toolDetail);
    } else {
      const legacy = await safeFetch("/api/monitor/usage/tool-usage", {
        ...detailRange,
        type: "1",
      });
      if (legacy.ok) {
        tools = buildToolsFromLegacy(legacy.data);
      } else {
        failed(legacy);
      }
    }

    if (!anyPrimaryOk && models === null && tools === null && failures.length > 0) {
      // Every block failed everywhere — surface the dominant error state
      // rather than a success with nothing in it.
      return { kind: dominantError(failures), range, generatedAt: Date.now() };
    }

    return {
      kind: "success",
      range,
      generatedAt: Date.now(),
      ...(activityBlock.ok ? { activity: buildActivity(activityBlock.data) } : {}),
      detail: {
        model: modelBlock.ok ? buildDetailSummary(modelBlock.data) : null,
        tool: toolBlock.ok ? buildDetailSummary(toolBlock.data) : null,
      },
      models: models ?? [],
      tools: tools ?? [],
      ...(series ? { series } : {}),
    };
  } catch (e) {
    log(`platform-usage: aggregation failed (${e instanceof Error ? e.message : String(e)})`);
    return { kind: "unavailable", range, generatedAt: Date.now() };
  }
}

// ---- TTL cache + single flight (queryQuota pattern, one slot per range) ----------

const TTL_MS = 15_000;

const cache = new Map<PlatformUsageRange, { result: PlatformUsageResult; at: number }>();
const inflight = new Map<PlatformUsageRange, Promise<PlatformUsageResult>>();
let clock: () => number = () => Date.now();

/**
 * Read the platform usage snapshot for a range.
 *
 * Serves a cached result when fresh (< 15s); concurrent reads for the same
 * range share one upstream round trip (the 365-day activity fetch is the
 * expensive one, and a burst of range taps must not fan out).
 */
export async function readPlatformUsage(
  range: PlatformUsageRange = "7d",
): Promise<PlatformUsageResult> {
  const hit = cache.get(range);
  if (hit && clock() - hit.at < TTL_MS) {
    log("platform-usage: serving cached result");
    return hit.result;
  }
  const running = inflight.get(range);
  if (running) return running;

  const promise = aggregate(range)
    .then((result) => {
      cache.set(range, { result, at: clock() });
      return result;
    })
    .finally(() => {
      inflight.delete(range);
    });
  inflight.set(range, promise);
  return promise;
}

/** Test helper: drop cached results and in-flight promises. */
export function resetPlatformUsageCacheForTest(): void {
  cache.clear();
  inflight.clear();
}

/** Test helper: inject a fake clock. Pass `undefined` to restore real time. */
export function setPlatformUsageClockForTest(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}
