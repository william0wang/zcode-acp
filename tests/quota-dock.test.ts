/**
 * formatQuotaDock tests (ADR-0021): the compact one-line dock string for the
 * Martty TUI — success shape, omitted MCP, missing windows, reset rendering,
 * and the null-on-failure contract.
 */

import { describe, expect, it } from "vitest";

import { formatQuotaDock } from "../src/quota/format.js";
import type { QuotaItem, QuotaResult } from "../src/quota/types.js";

const NOW = 1_800_000_000_000;

function item(overrides: Partial<QuotaItem> & { key: string }): QuotaItem {
  return { label: overrides.key, usedPercent: 0, leftPercent: 100, ...overrides };
}

/** Local HH:MM of an epoch-ms timestamp (the dock shows the reset clock time). */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

describe("formatQuotaDock", () => {
  it("renders 5h + weekly + reset clock time and omits MCP", () => {
    const reset = NOW + 2 * 3_600_000 + 13 * 60_000;
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [
        item({ key: "token_5h", usedPercent: 45, nextResetTime: reset }),
        item({ key: "token_week", usedPercent: 12 }),
        item({ key: "mcp", usedPercent: 80 }),
      ],
    };
    expect(formatQuotaDock(result)).toBe(`5h 45% · wk 12% · reset ${clock(reset)}`);
  });

  it("omits the weekly segment when absent", () => {
    const reset = NOW + 43 * 60_000;
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_5h", usedPercent: 7, nextResetTime: reset })],
    };
    expect(formatQuotaDock(result)).toBe(`5h 7% · reset ${clock(reset)}`);
  });

  it("zero-pads the clock minutes", () => {
    const reset = NOW + 3_600_000 + 2 * 60_000;
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_5h", usedPercent: 61, nextResetTime: reset })],
    };
    expect(formatQuotaDock(result)).toBe(`5h 61% · reset ${clock(reset)}`);
    expect(clock(reset)).toMatch(/^\d{2}:\d{2}$/);
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
    expect(formatQuotaDock(result)).toBe("5h 30% · wk 5%");
  });

  it("returns null without a 5h window even on success", () => {
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_week", usedPercent: 5 }), item({ key: "mcp", usedPercent: 5 })],
    };
    expect(formatQuotaDock(result)).toBeNull();
  });

  it("returns null for every non-success result", () => {
    expect(formatQuotaDock({ kind: "auth_error" })).toBeNull();
    expect(formatQuotaDock({ kind: "rate_limited" })).toBeNull();
    expect(formatQuotaDock({ kind: "unavailable" })).toBeNull();
  });

  it("still shows a clock time when the reset moment is in the past", () => {
    const reset = NOW - 5_000;
    const result: QuotaResult = {
      kind: "success",
      level: "pro",
      items: [item({ key: "token_5h", usedPercent: 99, nextResetTime: reset })],
    };
    expect(formatQuotaDock(result)).toBe(`5h 99% · reset ${clock(reset)}`);
  });
});
