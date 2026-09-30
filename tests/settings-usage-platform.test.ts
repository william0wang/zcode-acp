/**
 * Tests for the platform-usage aggregation (src/quota/platform-usage.ts).
 *
 * The risk here is not the HTTP but the CONTRACT, so everything runs against
 * a fake fetch + fake clock (the quota tests' pattern): envelope
 * classification, the legacy fallback chain, the breakdown-bucket filter
 * (unfiltered, credit-usage totals read ~2x), heatmap bucketing, and the
 * TTL cache / single-flight rules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the credentials loader so no test depends on a real
// ~/.zcode/v2/config.json (absent in CI → "no apiKey" → unavailable).
vi.mock("../src/backend/credentials.js", () => ({
  loadZcodeCredentials: () => ({
    ANTHROPIC_API_KEY: "test-key",
    providerBaseURL: "https://open.bigmodel.cn",
  }),
}));

import {
  isPlatformUsageRange,
  readPlatformUsage,
  resetPlatformUsageCacheForTest,
  setPlatformUsageClockForTest,
} from "../src/quota/platform-usage.js";

/** Scripted answers keyed by URL fragment; longest fragment wins. */
let calls: Array<{ url: string; auth?: string }> = [];
let scripted: Array<{ match: string; status: number; body: unknown }> = [];

function script(match: string, body: unknown, status = 200): void {
  scripted = scripted.filter((s) => s.match !== match);
  scripted.push({ match, status, body });
}

/** The monitor envelope shape every endpoint answers with. */
const envelope = (data: unknown, over: Record<string, unknown> = {}) => ({
  code: 200,
  msg: "操作成功",
  success: true,
  data,
  ...over,
});

beforeEach(() => {
  calls = [];
  scripted = [];
  resetPlatformUsageCacheForTest();
  setPlatformUsageClockForTest(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      calls.push({ url, auth: init?.headers?.Authorization });
      const hit = scripted
        .filter((s) => url.includes(s.match))
        .sort((a, b) => b.match.length - a.match.length)[0];
      if (!hit) throw new Error(`test bug: no scripted response for ${url}`);
      return {
        ok: hit.status === 200,
        status: hit.status,
        text: async () => JSON.stringify(hit.body),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- fixtures -----------------------------------------------------------------

/** Two real models + both breakdown-bucket shapes the platform mixes in. */
const MODEL_DETAIL = envelope({
  summary: {
    cacheHitRate: { value: "72.4", trend: 3.1 },
    totalCredits: { value: 3400, trend: -2 },
    averageDailyCredits: { value: 120, trend: null },
  },
  modelUsage: {
    xTime: ["2026-09-28", "2026-09-29"],
    modelDataList: [
      {
        modelName: "glm-4.7",
        modelCode: "glm-4.7",
        sortOrder: 0,
        totalTokens: 800,
        totalCredits: 2000,
        totalTokensUsage: [500, 300],
      },
      {
        modelName: "glm-4.7-air",
        sortOrder: 1,
        totalTokens: 200,
        totalTokensUsage: [120, 80],
      },
      // Billing components, not models — must not reach the models list.
      {
        modelCode: "cached_input",
        modelName: "缓存",
        totalTokens: 400,
        totalTokensUsage: [250, 150],
      },
      { modelCode: "uncached_input", totalTokens: 100, totalTokensUsage: [60, 40] },
    ],
  },
});

const MCP_DETAIL = envelope({
  summary: {
    cacheHitRate: { value: null, trend: null },
    totalCredits: { value: 12, trend: 1 },
    averageDailyCredits: { value: 1.5, trend: null },
  },
  mcpUsage: {
    xTime: ["2026-09-28", "2026-09-29"],
    mcpDataList: [
      { mcpName: "web-reader", totalUsageCount: 14, totalCredits: 8, usageCount: [10, 4] },
      { mcpName: "search-prime", totalUsageCount: 3, mcpCallCount: [2, 1] },
    ],
  },
});

const ACTIVITY = envelope({
  summary: {
    totalTokens: 1_200_000,
    peakDailyTokens: "86,000".replace(",", ""), // numeric strings arrive sometimes
    peakDailyTokensDate: "2026-09-12",
    totalUsageDurationMs: 4_980_000,
    currentStreakDays: 6,
    longestStreakDays: 41,
  },
  series: [
    { date: "2026-09-01", totalTokens: 100, modelCallCount: 2, mcpCalls: 1 },
    { date: "2026-09-02", totalTokens: 50, modelCallCount: 1, mcpCalls: 0 },
    { date: "not-a-date", totalTokens: 7 },
  ],
});

function scriptHappyPath(): void {
  script("credit-usage/activity", ACTIVITY);
  // Match on the usageType param alone: the client's query order puts other
  // params between the path and usageType.
  script("usageType=MODEL", MODEL_DETAIL);
  script("usageType=MCP", MCP_DETAIL);
}

// ---- the aggregation ----------------------------------------------------------

describe("readPlatformUsage", () => {
  it("aggregates the three blocks and filters breakdown buckets", async () => {
    scriptHappyPath();
    const result = await readPlatformUsage("7d");

    expect(result.kind).toBe("success");
    // Buckets filtered: only the two real models, in sortOrder.
    expect(result.models?.map((m) => m.name)).toEqual(["glm-4.7", "glm-4.7-air"]);
    // Series totals sum the REAL rows only (the cached_input bucket would
    // otherwise double them: [930, 570] instead of [620, 380]).
    expect(result.series?.totals).toEqual([620, 380]);
    expect(result.series?.granularity).toBe("day");
    // Numeric-string tolerance on the way in, plain numbers on the way out.
    expect(result.activity?.summary.peakDailyTokens).toBe(86000);
    expect(result.activity?.summary.currentStreakDays).toBe(6);
    expect(result.detail?.model?.cacheHitRate).toBe(72.4);
    expect(result.detail?.model?.totalCreditsTrend).toBe(-2);
    expect(result.tools).toHaveLength(2);
    // No fallback fired — usage-detail had rows for both blocks.
    expect(calls.some((c) => c.url.includes("usage/model-usage"))).toBe(false);
    expect(calls.some((c) => c.url.includes("usage/tool-usage"))).toBe(false);
    // The auth contract: bearer apiKey on every upstream call.
    expect(calls.every((c) => c.auth === "Bearer test-key")).toBe(true);
    // Personal scope and the range parameters the platform expects.
    expect(calls.some((c) => c.url.includes("type=1"))).toBe(true);
    expect(calls.some((c) => c.url.includes("startTime="))).toBe(true);
  });

  it("buckets the activity series into Sunday-start weeks with levels", async () => {
    scriptHappyPath();
    const result = await readPlatformUsage("7d");

    const heatmap = result.activity?.heatmap;
    expect(heatmap?.startDate).toBe("2026-09-01");
    expect(heatmap?.endDate).toBe("2026-09-02");
    expect(heatmap?.maxTokens).toBe(100);
    // Every week is a full 7-slot column; only recorded days are cells.
    expect(heatmap?.weeks[0]?.days).toHaveLength(7);
    const cells = heatmap?.weeks[0]?.days.filter((d) => d !== null) ?? [];
    expect(cells.map((c) => c!.date)).toEqual(["2026-09-01", "2026-09-02"]);
    // 100/100 → level 4, 50/100 → level 2.
    expect(cells.map((c) => c!.level)).toEqual([4, 2]);
  });

  it("falls back to the legacy monitor series when usage-detail has no rows", async () => {
    script("credit-usage/activity", ACTIVITY);
    // usage-detail answers success with an empty/absent block for both types.
    script("usageType=MODEL", envelope({ modelUsage: null, mcpUsage: null }));
    script("usageType=MCP", envelope(null));
    script(
      "usage/model-usage",
      envelope({
        x_time: ["2026-09-28", "2026-09-29"],
        tokensUsage: [700, 300],
        totalUsage: {
          modelSummaryList: [{ modelName: "glm-4.7", totalTokens: 1000 }],
        },
      }),
    );
    script(
      "usage/tool-usage",
      envelope({
        toolSummaryList: [{ toolName: "web-reader", toolCode: "web-reader", totalUsageCount: 9 }],
      }),
    );

    const result = await readPlatformUsage("30d");
    expect(result.kind).toBe("success");
    expect(result.models?.map((m) => m.name)).toEqual(["glm-4.7"]);
    // Legacy fallback carries no credits — the field stays absent, not zero.
    expect(result.models?.[0]?.totalCredits).toBeUndefined();
    expect(result.series?.totals).toEqual([700, 300]);
    expect(result.tools).toEqual([{ name: "web-reader", totalUsageCount: 9 }]);
  });

  it("maps a total auth failure to auth_error", async () => {
    // The three primaries refuse; the fallbacks then also fail (unscripted
    // routes throw inside the fake fetch), so no block lands anywhere.
    script("credit-usage/activity", { success: false, code: 401, msg: "unauthorized" }, 401);
    script("credit-usage/usage-detail", { success: false, code: 401, msg: "unauthorized" }, 401);
    const result = await readPlatformUsage("7d");
    expect(result.kind).toBe("auth_error");
    expect(result.models).toBeUndefined();
  });

  it("maps HTTP 429 to rate_limited", async () => {
    script("credit-usage", { success: false, code: 429, msg: "too many requests" }, 429);
    const result = await readPlatformUsage("7d");
    expect(result.kind).toBe("rate_limited");
  });

  it("degrades a failed block to empty data while the rest succeed", async () => {
    script("credit-usage/activity", { success: false, code: 500, msg: "boom" }, 500);
    script("usageType=MODEL", MODEL_DETAIL);
    script("usageType=MCP", MCP_DETAIL);
    const result = await readPlatformUsage("7d");

    expect(result.kind).toBe("success");
    expect(result.activity).toBeUndefined();
    expect(result.models).toHaveLength(2);
  });

  it("serves a cached result within the TTL and coalesces concurrent reads", async () => {
    scriptHappyPath();
    let now = 1_000_000;
    setPlatformUsageClockForTest(() => now);

    // Two concurrent opens share one upstream round trip.
    await Promise.all([readPlatformUsage("7d"), readPlatformUsage("7d")]);
    expect(calls.filter((c) => c.url.includes("credit-usage/activity"))).toHaveLength(1);

    // A read inside the TTL does not refetch.
    await readPlatformUsage("7d");
    expect(calls.filter((c) => c.url.includes("credit-usage/activity"))).toHaveLength(1);

    // Past the TTL it does — and the fresh result replaces the slot.
    now += 16_000;
    await readPlatformUsage("7d");
    expect(calls.filter((c) => c.url.includes("credit-usage/activity"))).toHaveLength(2);
  });

  it("keeps ranges separate in the cache", async () => {
    scriptHappyPath();
    await readPlatformUsage("today");
    await readPlatformUsage("7d");
    // today = hour granularity, 7d = day — one slot per range, no cross-talk.
    const today = await readPlatformUsage("today");
    expect(today.range).toBe("today");
    // Granularity follows the RANGE, not the fixture's day-shaped xTime.
    expect(today.series?.granularity).toBe("hour");
  });
});

describe("isPlatformUsageRange", () => {
  it("accepts the three route ranges and nothing else", () => {
    expect(isPlatformUsageRange("today")).toBe(true);
    expect(isPlatformUsageRange("7d")).toBe(true);
    expect(isPlatformUsageRange("30d")).toBe(true);
    expect(isPlatformUsageRange("all")).toBe(false);
    expect(isPlatformUsageRange("")).toBe(false);
  });
});
