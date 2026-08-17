/**
 * account/usage_stats handler tests (Proposal 0002).
 *
 * Verifies the quota → plans mapping (percent always present, counts and
 * reset timestamps only when the API reported them) and the graceful-failure
 * contract: a non-success quota result throws a JSON-RPC error carrying the
 * failure kind in `data.kind` so remote clients hide the quota UI.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryQuotaMock } = vi.hoisted(() => ({ queryQuotaMock: vi.fn() }));

vi.mock("../src/quota/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/quota/index.js")>("../src/quota/index.js");
  return { ...actual, queryQuota: queryQuotaMock };
});

import { accountUsageStats } from "../src/handlers/account.js";
import type { QuotaResult } from "../src/quota/types.js";

beforeEach(() => {
  queryQuotaMock.mockReset();
});

describe("accountUsageStats", () => {
  it("maps parsed quota items to plan entries", async () => {
    const result: QuotaResult = {
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
          nextResetTime: 1723812000000,
        },
      ],
    };
    queryQuotaMock.mockResolvedValue(result);

    const out = await accountUsageStats();
    expect(out.plans).toHaveLength(2);

    const fiveHour = out.plans[0]!;
    expect(fiveHour.id).toBe("token_5h");
    expect(fiveHour.usedPercent).toBe(35);
    expect(fiveHour.windowHours).toBe(5);
    expect(fiveHour.resetsAt).toBe(1723812000000);
    // No counts reported → no used/limit fields (client falls back to percent).
    expect(fiveHour.used).toBeUndefined();
    expect(fiveHour.limit).toBeUndefined();

    const mcp = out.plans[1]!;
    expect(mcp.id).toBe("mcp");
    expect(mcp.used).toBe(3);
    expect(mcp.limit).toBe(30);
    expect(mcp.windowHours).toBeUndefined();
  });

  it("throws a JSON-RPC error with the failure kind when quota is unavailable", async () => {
    queryQuotaMock.mockResolvedValue({ kind: "unavailable" } satisfies QuotaResult);
    await expect(accountUsageStats()).rejects.toMatchObject({
      code: -32003,
      data: { kind: "unavailable" },
    });
  });

  it("throws with kind auth_error on auth failures", async () => {
    queryQuotaMock.mockResolvedValue({ kind: "auth_error" } satisfies QuotaResult);
    await expect(accountUsageStats()).rejects.toMatchObject({
      data: { kind: "auth_error" },
    });
  });

  it("returns an empty plans array when the API reports no windows", async () => {
    queryQuotaMock.mockResolvedValue({
      kind: "success",
      level: "pro",
      items: [],
    } satisfies QuotaResult);
    const out = await accountUsageStats();
    expect(out.plans).toEqual([]);
  });
});
