/**
 * account/usage_stats handler tests (Proposal 0002).
 *
 * Verifies the combined dual-provider mapping: GLM items pass through with
 * plan level and per-model details; Opencode Go windows are emitted with the
 * relative reset countdown converted to an absolute timestamp; per-provider
 * failures become `kind` strings (never thrown), and a `not_configured` Go
 * section is reported as-is so the client can omit it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryCombinedMock } = vi.hoisted(() => ({ queryCombinedMock: vi.fn() }));

vi.mock("../src/quota/combined.js", async () => {
  const actual = await vi.importActual<typeof import("../src/quota/combined.js")>(
    "../src/quota/combined.js",
  );
  return { ...actual, queryCombined: queryCombinedMock };
});

import { accountUsageStats } from "../src/handlers/account.js";
import type { CombinedResult } from "../src/quota/combined.js";

const NOW = 1_700_000_000_000;

beforeEach(() => {
  queryCombinedMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("accountUsageStats", () => {
  it("passes GLM items through with level and per-model details", async () => {
    queryCombinedMock.mockResolvedValue({
      glm: {
        kind: "success",
        level: "pro",
        items: [
          {
            key: "token_5h",
            label: "5h",
            usedPercent: 35,
            leftPercent: 65,
            nextResetTime: 1723812000000,
          },
          {
            key: "mcp",
            label: "MCP",
            usedPercent: 10,
            leftPercent: 90,
            usedCount: 3,
            totalCount: 30,
            detail: [{ modelCode: "search-prime", usage: 2 }],
          },
        ],
      },
      go: { kind: "not_configured" },
      oc: { kind: "not_configured" },
    } satisfies CombinedResult);

    const out = await accountUsageStats();
    expect(out.glm.kind).toBe("success");
    expect(out.glm.level).toBe("pro");
    expect(out.glm.items).toHaveLength(2);
    // Verbatim passthrough: counts and details ride along for the client.
    expect(out.glm.items![1]).toMatchObject({
      key: "mcp",
      usedCount: 3,
      totalCount: 30,
      detail: [{ modelCode: "search-prime", usage: 2 }],
    });
    // not_configured Go is reported as-is — the client omits the section.
    expect(out.opencode).toEqual({ kind: "not_configured" });
    expect(out.ollama).toEqual({ kind: "not_configured" });
  });

  it("converts Go reset countdowns to absolute timestamps", async () => {
    const fetchedAt = NOW - 60_000; // snapshot is 1 minute old
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "unavailable" },
      go: {
        kind: "success",
        fetchedAt,
        rolling: { usagePercent: 5, resetInSec: 3600 }, // 1h left at fetch time
        weekly: { usagePercent: 25, resetInSec: 86_400 },
        monthly: null, // absent window is dropped, not rendered as "(no data)"
      },
      oc: { kind: "not_configured" },
    } satisfies CombinedResult);

    const out = await accountUsageStats();
    expect(out.opencode.kind).toBe("success");
    expect(out.opencode.windows).toEqual([
      // resetsAt = fetchedAt + (resetInSec − 60s elapsed since the snapshot)
      { key: "rolling", label: "5h", usagePercent: 5, resetsAt: fetchedAt + 3_540_000 },
      { key: "weekly", label: "Week", usagePercent: 25, resetsAt: fetchedAt + 86_340_000 },
    ]);
    // GLM failure is a kind string, never a thrown JSON-RPC error.
    expect(out.glm).toEqual({ kind: "unavailable" });
  });

  it("reports auth failures as section kinds instead of throwing", async () => {
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "auth_error" },
      go: { kind: "auth_error" },
      oc: { kind: "auth_error" },
    } satisfies CombinedResult);

    const out = await accountUsageStats();
    expect(out).toEqual({
      glm: { kind: "auth_error" },
      opencode: { kind: "auth_error" },
      ollama: { kind: "auth_error" },
    });
  });

  it("returns empty sections when the API reports no windows", async () => {
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "success", level: "pro", items: [] },
      go: { kind: "not_configured" },
      oc: { kind: "not_configured" },
    } satisfies CombinedResult);

    const out = await accountUsageStats();
    expect(out.glm.items).toEqual([]);
    expect(out.opencode.kind).toBe("not_configured");
  });

  it("converts Ollama fractions to percent windows (no resetsAt)", async () => {
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "success", session: 0.31, weekly: 0.675, fetchedAt: NOW },
    } satisfies CombinedResult);

    const out = await accountUsageStats();
    expect(out.ollama.kind).toBe("success");
    expect(out.ollama.windows).toEqual([
      { key: "session", label: "5h", usagePercent: 31 },
      { key: "weekly", label: "Week", usagePercent: 67.5 },
    ]);
  });

  it("passes derived Ollama reset moments through as resetsAt", async () => {
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: {
        kind: "success",
        session: 0.31,
        sessionResetAt: NOW + 7_200_000,
        monthly: 0.006,
        monthlyResetAt: NOW + 5 * 86_400_000,
        fetchedAt: NOW,
      },
    } satisfies CombinedResult);

    const out = await accountUsageStats();
    expect(out.ollama.windows).toEqual([
      { key: "session", label: "5h", usagePercent: 31, resetsAt: NOW + 7_200_000 },
      { key: "monthly", label: "Month", usagePercent: 0.6, resetsAt: NOW + 5 * 86_400_000 },
    ]);
  });

  it("credit-plan Ollama (monthly only) emits a single Month window", async () => {
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "success", monthly: 0.006, fetchedAt: NOW },
    } satisfies CombinedResult);

    const out = await accountUsageStats();
    expect(out.ollama.windows).toEqual([{ key: "monthly", label: "Month", usagePercent: 0.6 }]);
  });

  it("analytics Ollama: derived Month window plus the additive spend detail", async () => {
    // 2026-10 API: percent derived from 30d spend ÷ plan credit; `usage` is an
    // additive field older clients ignore.
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: {
        kind: "success",
        monthly: 1.5747 / 60,
        monthlyResetAt: NOW + 5 * 86_400_000,
        usageUsd: 1.5747,
        plan: "pro",
        creditUsd: 60,
        requestCount: 246,
        inputTokens: 14_294_081,
        cachedInputTokens: 12_922_504,
        outputTokens: 940_919,
        fetchedAt: NOW,
      },
    } satisfies CombinedResult);

    const out = await accountUsageStats();
    expect(out.ollama.windows).toEqual([
      {
        key: "monthly",
        label: "Month",
        usagePercent: (1.5747 / 60) * 100,
        resetsAt: NOW + 5 * 86_400_000,
      },
    ]);
    expect(out.ollama.usage).toEqual({
      plan: "pro",
      usageUsd: 1.5747,
      creditUsd: 60,
      requestCount: 246,
      inputTokens: 14_294_081,
      cachedInputTokens: 12_922_504,
      outputTokens: 940_919,
      window: "30d",
    });
  });

  it("analytics Ollama without a known plan: spend detail, no windows", async () => {
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "success", usageUsd: 0.44, plan: "free", fetchedAt: NOW },
    } satisfies CombinedResult);

    const out = await accountUsageStats();
    expect(out.ollama.windows).toEqual([]);
    expect(out.ollama.usage).toEqual({ plan: "free", usageUsd: 0.44, window: "30d" });
  });
});
