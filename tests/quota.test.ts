/**
 * Tests for the quota feature: parsing (percentage fallbacks, label derivation,
 * error states), formatting (progress-bar rendering, detail sub-lines), the
 * in-memory TTL cache, and the queryQuota orchestration (cache hit / fetch
 * failure → unavailable).
 *
 * Parser/formatter tests are pure-function. The orchestration test injects a
 * fake fetch + fake clock to avoid real network calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the credentials loader so queryQuota orchestration tests don't depend
// on a real ~/.zcode/v2/config.json (absent in CI → "no apiKey" → unavailable).
// resolveQuotaHost is a pure function unaffected by this mock.
vi.mock("../src/backend/credentials.js", () => ({
  loadZcodeCredentials: () => ({
    ANTHROPIC_API_KEY: "test-key",
    ZCODE_BASE_URL: "https://open.bigmodel.cn",
  }),
}));

import { clearCache, getCached, setCached, setClock } from "../src/quota/cache.js";
import { formatQuota, renderBar } from "../src/quota/format.js";
import { parseLimit, parseQuotaEnvelope } from "../src/quota/parse.js";
import type { QuotaResult } from "../src/quota/types.js";
import { resolveQuotaHost } from "../src/quota/client.js";

// Real-shape fixture mirroring the live API response (CN, Pro plan).
const PRO_FIXTURE = {
  success: true,
  code: 200,
  msg: "操作成功",
  data: {
    level: "pro",
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 1000,
        currentValue: 237,
        remaining: 763,
        percentage: 24,
        nextResetTime: 1784166659961,
        usageDetails: [
          { modelCode: "search-prime", usage: 169 },
          { modelCode: "web-reader", usage: 68 },
        ],
      },
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 5,
        nextResetTime: 1783436462284,
      },
    ],
  },
} as const;

describe("parseLimit", () => {
  it("prefers remaining+currentValue over percentage (most precise)", () => {
    const item = parseLimit({
      type: "TIME_LIMIT",
      remaining: 763,
      currentValue: 237,
      percentage: 90, // misleading legacy field — must be ignored
    });
    expect(item?.usedPercent).toBe(24); // 237 / (763+237)
    expect(item?.leftPercent).toBe(76);
  });

  it("falls back to currentValue / usage when no remaining", () => {
    const item = parseLimit({
      type: "TOKENS_LIMIT",
      number: 5,
      currentValue: 50,
      usage: 200,
    });
    expect(item?.usedPercent).toBe(25);
  });

  it("falls back to legacy percentage field (treated as used)", () => {
    const item = parseLimit({ type: "TOKENS_LIMIT", number: 5, percentage: 5 });
    expect(item?.usedPercent).toBe(5);
    expect(item?.leftPercent).toBe(95);
  });

  it("returns null when no percentage can be computed", () => {
    expect(parseLimit({ type: "TOKENS_LIMIT", number: 5 })).toBeNull();
    expect(parseLimit({ type: "UNKNOWN" })).toBeNull();
  });

  it("derives labels: 5h / Week / MCP / unknown", () => {
    expect(parseLimit({ type: "TOKENS_LIMIT", number: 5, percentage: 10 })?.label).toBe("5h");
    expect(parseLimit({ type: "TOKENS_LIMIT", number: 7, percentage: 10 })?.label).toBe("Week");
    expect(parseLimit({ type: "TIME_LIMIT", percentage: 10 })?.label).toBe("MCP");
    expect(parseLimit({ type: "MCP_LIMIT", percentage: 10 })?.label).toBe("MCP");
    expect(parseLimit({ type: "FUTURE_LIMIT", percentage: 10 })?.label).toBe("FUTURE_LIMIT");
  });

  it("carries nextResetTime and detail when present", () => {
    const item = parseLimit({
      type: "TIME_LIMIT",
      percentage: 24,
      nextResetTime: 1784166659961,
      usageDetails: [{ modelCode: "search-prime", usage: 169 }],
    });
    expect(item?.nextResetTime).toBe(1784166659961);
    expect(item?.detail).toEqual([{ modelCode: "search-prime", usage: 169 }]);
  });

  it("clamps out-of-range percentages to [0, 100]", () => {
    expect(parseLimit({ type: "X", percentage: 150 })?.usedPercent).toBe(100);
    expect(parseLimit({ type: "X", percentage: -5 })?.usedPercent).toBe(0);
  });
});

describe("parseQuotaEnvelope", () => {
  it("parses the Pro fixture into 2 items with correct kinds", () => {
    const result = parseQuotaEnvelope({
      status: 200,
      json: PRO_FIXTURE,
      text: JSON.stringify(PRO_FIXTURE),
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.level).toBe("pro");
    expect(result.items).toHaveLength(2);
    // Both items must have valid percentages.
    for (const item of result.items) {
      expect(item.usedPercent).toBeGreaterThanOrEqual(0);
      expect(item.usedPercent).toBeLessThanOrEqual(100);
    }
  });

  it("HTTP 429 → rate_limited", () => {
    const result = parseQuotaEnvelope({ status: 429, json: null, text: "" });
    expect(result.kind).toBe("rate_limited");
  });

  it("business code 1001 / 401 → auth_error", () => {
    expect(
      parseQuotaEnvelope({ status: 200, json: { success: false, code: 1001 }, text: "" }).kind,
    ).toBe("auth_error");
    expect(
      parseQuotaEnvelope({ status: 200, json: { success: false, code: 401 }, text: "" }).kind,
    ).toBe("auth_error");
  });

  it("non-JSON body → unavailable", () => {
    expect(parseQuotaEnvelope({ status: 200, json: null, text: "oops" }).kind).toBe("unavailable");
  });

  it("success but zero parseable limits → unavailable", () => {
    const result = parseQuotaEnvelope({
      status: 200,
      json: { success: true, data: { level: "pro", limits: [{ type: "X" }] } },
      text: "",
    });
    expect(result.kind).toBe("unavailable");
  });
});

describe("renderBar", () => {
  it("0% → all empty cells", () => {
    expect(renderBar(0)).toBe("░".repeat(20));
  });

  it("100% → all full cells", () => {
    expect(renderBar(100)).toBe("█".repeat(20));
  });

  it("50% → 10 full + 10 empty", () => {
    expect(renderBar(50)).toBe("█".repeat(10) + "░".repeat(10));
  });

  it("rounds to the nearest cell (each cell = 5%)", () => {
    // 24% of 20 = 4.8 → rounds to 5 full.
    expect(renderBar(24)).toBe("█".repeat(5) + "░".repeat(15));
    // 5% of 20 = 1 → 1 full.
    expect(renderBar(5)).toBe("█" + "░".repeat(19));
    // 21% of 20 = 4.2 → rounds to 4 full.
    expect(renderBar(21)).toBe("█".repeat(4) + "░".repeat(16));
  });

  it("clamps inputs outside [0, 100]", () => {
    expect(renderBar(150)).toBe("█".repeat(20));
    expect(renderBar(-10)).toBe("░".repeat(20));
  });
});

describe("formatQuota", () => {
  it("renders a success card with header, divider, bars, and detail", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [
        {
          key: "token_5h",
          label: "5h",
          usedPercent: 5,
          leftPercent: 95,
          nextResetTime: 1783436462284,
        },
        {
          key: "mcp",
          label: "MCP",
          usedPercent: 24,
          leftPercent: 76,
          usedCount: 237,
          totalCount: 1000,
          nextResetTime: 1784166659961,
          detail: [
            { modelCode: "search-prime", usage: 169 },
            { modelCode: "web-reader", usage: 68 },
          ],
        },
      ],
    };
    const out = formatQuota(result);
    const lines = out.split("\n");
    // The whole card is wrapped in a ```text fenced block so the editor
    // renders it in a bordered, monospace, copy-able frame.
    expect(lines[0]).toBe("```text");
    expect(lines[1]).toBe("GLM Coding Plan · Pro");
    expect(lines[2]).toMatch(/^─+$/);
    // 5h line: percent + reset time, no "resets" word, no absolute counts.
    expect(lines[3]).toContain("5h");
    expect(lines[3]).toContain("5%");
    expect(lines[3]).not.toContain("resets");
    expect(lines[3]).not.toMatch(/\(\d+\/\d+\)/);
    // MCP line: percent + absolute counts + reset time.
    expect(lines[4]).toContain("MCP");
    expect(lines[4]).toContain("24%");
    expect(lines[4]).toContain("(237/1000)");
    expect(lines[4]).not.toContain("resets");
    // Detail branches (now padded model codes).
    expect(lines[5]).toMatch(/├ search-prime\s+\d+/);
    expect(lines[6]).toMatch(/└ web-reader\s+\d+/);
    expect(lines[lines.length - 1]).toBe("```");
  });

  it("omits absolute counts when the limit carries no counters (5h)", () => {
    const out = formatQuota({
      kind: "success",
      level: "pro",
      items: [{ key: "token_5h", label: "5h", usedPercent: 18, leftPercent: 82 }],
    });
    expect(out).not.toMatch(/\(\d+\/\d+\)/);
  });

  it("renders auth_error / rate_limited / unavailable fallbacks", () => {
    expect(formatQuota({ kind: "auth_error" })).toMatch(/auth expired/i);
    expect(formatQuota({ kind: "rate_limited" })).toMatch(/busy/i);
    expect(formatQuota({ kind: "unavailable" })).toMatch(/unavailable/i);
  });
});

describe("cache", () => {
  beforeEach(() => {
    clearCache();
    setClock(() => 1000);
  });
  afterEach(() => {
    clearCache();
    setClock(undefined);
  });

  it("serves a cached result within the TTL window", () => {
    const r: QuotaResult = { kind: "unavailable" };
    setCached(r);
    setClock(() => 1000 + 9_999); // 9.999s later — still fresh
    expect(getCached()).toBe(r);
  });

  it("returns null once the TTL expires", () => {
    setCached({ kind: "unavailable" });
    setClock(() => 1000 + 10_001); // 10.001s later — expired
    expect(getCached()).toBeNull();
  });
});

describe("resolveQuotaHost", () => {
  it("routes api.z.ai → intl, everything else → CN", () => {
    expect(resolveQuotaHost("https://api.z.ai/api/anthropic")).toBe("https://api.z.ai");
    expect(resolveQuotaHost("https://open.bigmodel.cn/api/anthropic")).toBe(
      "https://open.bigmodel.cn",
    );
    expect(resolveQuotaHost("")).toBe("https://open.bigmodel.cn");
  });
});

describe("queryQuota orchestration", () => {
  // queryQuota imports client.ts which calls loadZcodeCredentials at call
  // time, so we mock the module's fetchQuotaResponse via a spy on global fetch.
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearCache();
    setClock(() => 5000);
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(PRO_FIXTURE), { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    clearCache();
    setClock(undefined);
  });

  it("returns parsed success on a 200 response", async () => {
    const { queryQuota } = await import("../src/quota/index.js");
    const result = await queryQuota();
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.items.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("degrades to unavailable on fetch throw", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const { queryQuota } = await import("../src/quota/index.js");
    const result = await queryQuota();
    expect(result.kind).toBe("unavailable");
  });

  it("serves cached result without re-fetching within TTL", async () => {
    const { queryQuota } = await import("../src/quota/index.js");
    await queryQuota();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await queryQuota(); // cached — no new fetch
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
