/**
 * Quota-exhaustion classification and reset-math tests (src/quota/resume.ts).
 *
 * Shapes are copied from the real producers: bridge AcpTurnFailureData
 * (turnFailureRequestError), raw backend turn.failed causes, and upstream
 * WorkflowErrorJson with ProviderStopDetails (workflow-notification-copy.ts).
 */

import { describe, expect, it } from "vitest";

import {
  QUOTA_PROVIDER_CODES,
  classifyQuotaExhaustion,
  isQuotaStopFailureMessage,
  quotaBackoffMs,
  quotaResetAtFromResult,
} from "../src/quota/resume.js";
import type { QuotaResult } from "../src/quota/types.js";

const NOW = 1_700_000_000_000;

describe("classifyQuotaExhaustion", () => {
  it("reads the bridge AcpTurnFailureData shape (providerCode in data)", () => {
    const info = classifyQuotaExhaustion({
      code: -32603,
      message: "ZCode turn failed: model rate limited",
      data: {
        type: "zcode_turn_failed",
        reason: "rate_limited",
        providerCode: "1308",
        retryable: false,
        retryAfterMs: 3_600_000,
      },
    });
    expect(info?.providerCode).toBe("1308");
    expect(info?.resetAt).toBeGreaterThan(Date.now());
  });

  it("reads a raw turn.failed cause (code is the business code)", () => {
    const info = classifyQuotaExhaustion({
      cause: {
        code: "1308",
        message: "5小时的使用上限",
        context: { reason: "rate_limited", retryable: false, providerCode: "1308" },
      },
    });
    expect(info?.providerCode).toBe("1308");
  });

  it("reads the upstream WorkflowErrorJson providerStop (kind quota)", () => {
    const future = Date.now() + 7_200_000;
    const info = classifyQuotaExhaustion({
      code: "ProviderStop",
      message: "Subagent a hit a permanent model-side error (rate_limited [1308])",
      providerStop: {
        kind: "quota",
        reason: "rate_limited",
        providerCode: "1308",
        resetAt: future,
      },
    });
    expect(info?.providerCode).toBe("1308");
    expect(info?.resetAt).toBe(future);
  });

  it("a structured non-quota stop is authoritative (no message fallback)", () => {
    expect(
      classifyQuotaExhaustion({
        providerStop: { kind: "auth", reason: "rate_limited" },
        message: "quota exhausted [1308]",
      }),
    ).toBeUndefined();
  });

  it("message fallback requires a quota wording AND a non-retryable rate limit", () => {
    expect(
      classifyQuotaExhaustion({
        cause: { message: "quota exceeded", context: { reason: "rate_limited", retryable: false } },
      }),
    ).toBeDefined();
    // A plain (retryable) rate limit is retried upstream — never a quota stop.
    expect(
      classifyQuotaExhaustion({
        cause: {
          message: "too many requests",
          context: { reason: "rate_limited", retryable: true },
        },
      }),
    ).toBeUndefined();
    // Non-retryable but no quota wording — some other terminal rejection.
    expect(
      classifyQuotaExhaustion({
        cause: {
          message: "request rejected",
          context: { reason: "rate_limited", retryable: false },
        },
      }),
    ).toBeUndefined();
  });

  it("ignores a past resetAt (stale) and returns undefined for junk", () => {
    const info = classifyQuotaExhaustion({
      cause: { code: "1310", context: { providerCode: "1310", retryAfterMs: -5 } },
    });
    expect(info).toEqual({ providerCode: "1310" });
    expect(classifyQuotaExhaustion(null)).toBeUndefined();
    expect(classifyQuotaExhaustion("1308")).toBeUndefined();
    expect(classifyQuotaExhaustion({})).toBeUndefined();
  });

  it("covers the upstream stop-class quota code set", () => {
    for (const code of ["1005", "1308", "1310", "1316", "2056", "20097"]) {
      expect(QUOTA_PROVIDER_CODES.has(code)).toBe(true);
      expect(classifyQuotaExhaustion({ cause: { code } })?.providerCode).toBe(code);
    }
  });
});

describe("isQuotaStopFailureMessage", () => {
  it("matches the upstream driver message bracket", () => {
    expect(
      isQuotaStopFailureMessage(
        "Subagent a hit a permanent model-side error (rate_limited [1308]): 5小时的使用上限",
      ),
    ).toBe(true);
    expect(
      isQuotaStopFailureMessage("Subagent b hit a permanent model-side error (auth_failed [401])"),
    ).toBe(false);
  });

  it("matches a quota wording with the rate_limited reason", () => {
    expect(isQuotaStopFailureMessage("rate_limited: quota exceeded for the day")).toBe(true);
    expect(isQuotaStopFailureMessage("rate_limited: slow down")).toBe(false);
    expect(isQuotaStopFailureMessage(undefined)).toBe(false);
  });
});

describe("quotaResetAtFromResult", () => {
  const result = (items: Array<{ usedPercent: number; nextResetTime?: number }>): QuotaResult => ({
    kind: "success",
    level: "pro",
    items: items.map((i, n) => ({
      key: n === 0 ? "token_5h" : "token_week",
      label: n === 0 ? "5h" : "Week",
      usedPercent: i.usedPercent,
      leftPercent: 100 - i.usedPercent,
      ...(i.nextResetTime !== undefined ? { nextResetTime: i.nextResetTime } : {}),
    })),
  });

  it("picks the earliest future reset among exhausted windows", () => {
    const at = quotaResetAtFromResult(
      result([
        { usedPercent: 100, nextResetTime: NOW + 7_200_000 },
        { usedPercent: 99, nextResetTime: NOW + 172_800_000 },
      ]),
      NOW,
    );
    expect(at).toBe(NOW + 7_200_000);
  });

  it("ignores non-exhausted windows and past timestamps", () => {
    expect(
      quotaResetAtFromResult(result([{ usedPercent: 80, nextResetTime: NOW + 1000 }]), NOW),
    ).toBe(undefined);
    expect(
      quotaResetAtFromResult(result([{ usedPercent: 100, nextResetTime: NOW - 1000 }]), NOW),
    ).toBe(undefined);
    expect(quotaResetAtFromResult({ kind: "unavailable" }, NOW)).toBe(undefined);
  });
});

describe("quotaBackoffMs", () => {
  it("doubles and caps", () => {
    expect(quotaBackoffMs(1, 1000, 10_000)).toBe(1000);
    expect(quotaBackoffMs(2, 1000, 10_000)).toBe(2000);
    expect(quotaBackoffMs(5, 1000, 10_000)).toBe(10_000);
    expect(quotaBackoffMs(0, 1000, 10_000)).toBe(1000);
  });
});
