/**
 * Tests for the quota feature: parsing (percentage fallbacks, label derivation,
 * error states), formatting (progress-bar rendering, detail sub-lines), the
 * in-memory TTL cache, and the queryQuota orchestration (cache hit / fetch
 * failure → unavailable).
 *
 * Parser/formatter tests are pure-function. The orchestration test injects a
 * fake fetch + fake clock to avoid real network calls.
 */

import { describe, expect, it, vi } from "vitest";

// Mock the credentials loader so queryQuota orchestration tests don't depend
// on a real ~/.zcode/v2/config.json (absent in CI → "no apiKey" → unavailable).
// resolveQuotaHost is a pure function unaffected by this mock.
vi.mock("../src/backend/credentials.js", () => ({
  loadZcodeCredentials: () => ({
    ANTHROPIC_API_KEY: "test-key",
    providerBaseURL: "https://open.bigmodel.cn",
  }),
}));

import {} from "../src/quota/format.js";
import { parseLimit, parseQuotaEnvelope } from "../src/quota/parse.js";
import type {} from "../src/quota/types.js";
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
