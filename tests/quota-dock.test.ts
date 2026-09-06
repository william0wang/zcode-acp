/**
 * formatQuotaDock tests (ADR-0021): the compact one-line dock string for the
 * Martty TUI — success shape, omitted MCP, missing windows, reset rendering,
 * and the null-on-failure contract.
 */

import { describe, expect, it } from "vitest";

import { formatQuotaDock } from "../src/quota/format.js";
import type { QuotaItem, QuotaResult } from "../src/quota/types.js";

const NOW = 1_800_000_000_000;
const now = () => NOW;

function item(overrides: Partial<QuotaItem> & { key: string }): QuotaItem {
  return { label: overrides.key, usedPercent: 0, leftPercent: 100, ...overrides };
}

describe("formatQuotaDock", () => {
  it("renders 5h + weekly + reset and omits MCP", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [
        item({
          key: "token_5h",
          usedPercent: 45,
          nextResetTime: NOW + 2 * 3_600_000 + 13 * 60_000,
        }),
        item({ key: "token_week", usedPercent: 12 }),
        item({ key: "mcp", usedPercent: 80 }),
      ],
    };
    expect(formatQuotaDock(result, now)).toBe("5h 45% · wk 12% · reset 2h13m");
  });

  it("omits the weekly segment when absent", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_5h", usedPercent: 7, nextResetTime: NOW + 43 * 60_000 })],
    };
    expect(formatQuotaDock(result, now)).toBe("5h 7% · reset 43m");
  });

  it("zero-pads minutes when hours are present", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [
        item({ key: "token_5h", usedPercent: 61, nextResetTime: NOW + 3_600_000 + 2 * 60_000 }),
      ],
    };
    expect(formatQuotaDock(result, now)).toBe("5h 61% · reset 1h02m");
  });

  it("omits the reset segment when the window carries no reset time", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [
        item({ key: "token_5h", usedPercent: 30 }),
        item({ key: "token_week", usedPercent: 5 }),
      ],
    };
    expect(formatQuotaDock(result, now)).toBe("5h 30% · wk 5%");
  });

  it("returns null without a 5h window even on success", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_week", usedPercent: 5 }), item({ key: "mcp", usedPercent: 5 })],
    };
    expect(formatQuotaDock(result, now)).toBeNull();
  });

  it("returns null for every non-success result", () => {
    expect(formatQuotaDock({ kind: "auth_error" }, now)).toBeNull();
    expect(formatQuotaDock({ kind: "rate_limited" }, now)).toBeNull();
    expect(formatQuotaDock({ kind: "unavailable" }, now)).toBeNull();
  });

  it("clamps a past reset time to 0m instead of going negative", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_5h", usedPercent: 99, nextResetTime: NOW - 5_000 })],
    };
    expect(formatQuotaDock(result, now)).toBe("5h 99% · reset 0m");
  });
});
