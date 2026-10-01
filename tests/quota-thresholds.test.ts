/**
 * Quota threshold push warnings (§5.7): edge-triggered tiers (80/90/100) per
 * watched window, drop-below-80 re-arm, persisted state surviving process
 * restarts (module reset = a reborn hub/bridge reading the same file), and
 * the notify switch muting the push without freezing the state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({
  cfg: null as {
    contentDetail: "full" | "minimal";
    notify: Record<string, boolean>;
    quietMs?: number;
  } | null,
}));
vi.mock("../src/push/config.js", async (orig) => {
  const actual = await orig<typeof import("../src/push/config.js")>();
  return { ...actual, pushActive: () => h.cfg !== null, pushConfig: () => h.cfg };
});
vi.mock("../src/crash-guards.js", async (orig) => {
  const actual = await orig<typeof import("../src/crash-guards.js")>();
  return { ...actual, appendDiary: () => undefined };
});

const { checkQuotaThresholds, quotaTier, resetQuotaThresholdsForTest } =
  await import("../src/quota/thresholds.js");
const { setPushSenderForTests, resetPushSenderForTests } = await import("../src/push/push.js");
import type { QuotaItem, QuotaResult } from "../src/quota/types.js";

const pushes: string[] = [];
const stateFile = path.join(
  process.env.HOME ?? "",
  ".config",
  "zcode-acp",
  "quota-push-state.json",
);

function item(key: string, usedPercent: number, nextResetTime?: number): QuotaItem {
  return {
    key,
    label: key === "token_week" ? "Week" : "5h",
    usedPercent,
    leftPercent: 100 - usedPercent,
    ...(nextResetTime !== undefined ? { nextResetTime } : {}),
  };
}

function result(...items: QuotaItem[]): QuotaResult {
  return { kind: "success", level: "PRO", items };
}

beforeEach(() => {
  h.cfg = {
    contentDetail: "full",
    notify: {
      turn: true,
      goal: true,
      run: true,
      task: true,
      compact: true,
      ask: true,
      workflowStage: true,
      quota: true,
    },
    quietMs: 0,
  };
  pushes.length = 0;
  resetQuotaThresholdsForTest();
  rmSync(stateFile, { force: true });
  setPushSenderForTests({
    sendText: async (c) => {
      pushes.push(c);
    },
  });
});

afterEach(() => {
  resetPushSenderForTests();
  h.cfg = null;
});

describe("quotaTier", () => {
  it("maps percentages onto the 80/90/100 tiers", () => {
    expect(quotaTier(79.9)).toBe(0);
    expect(quotaTier(80)).toBe(80);
    expect(quotaTier(89.9)).toBe(80);
    expect(quotaTier(90)).toBe(90);
    expect(quotaTier(99.9)).toBe(90);
    expect(quotaTier(100)).toBe(100);
  });
});

describe("checkQuotaThresholds", () => {
  it("pushes each newly-crossed tier once; a drop re-arms the window", async () => {
    const reset = Date.now() + 3 * 3600_000;
    await checkQuotaThresholds(result(item("token_5h", 81)));
    await checkQuotaThresholds(result(item("token_5h", 85))); // same tier — silent
    await checkQuotaThresholds(result(item("token_5h", 91, reset)));
    await checkQuotaThresholds(result(item("token_5h", 95))); // same tier — silent
    await checkQuotaThresholds(result(item("token_5h", 100)));
    await checkQuotaThresholds(result(item("token_5h", 12))); // new window — re-arm
    await checkQuotaThresholds(result(item("token_5h", 82))); // fires again

    expect(pushes).toHaveLength(4);
    expect(pushes[0]).toContain("5h quota 81% used");
    expect(pushes[1]).toContain("5h quota 91% used");
    expect(pushes[1]).toContain(`resets `);
    expect(pushes[2]).toContain("5h quota exhausted");
    expect(pushes[3]).toContain("5h quota 82% used");
  });

  it("tracks the weekly window independently and ignores non-budget keys", async () => {
    await checkQuotaThresholds(result(item("token_week", 85), item("mcp", 95), item("token", 99)));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("weekly quota 85% used");
  });

  it("persisted state survives a process restart (no re-push per rebirth)", async () => {
    await checkQuotaThresholds(result(item("token_5h", 81)));
    expect(pushes).toHaveLength(1);

    // A reborn hub/bridge: fresh in-memory mirror, same disk state.
    resetQuotaThresholdsForTest();
    await checkQuotaThresholds(result(item("token_5h", 83)));
    expect(pushes).toHaveLength(1); // still tier-80 — no duplicate

    await checkQuotaThresholds(result(item("token_5h", 92)));
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toContain("5h quota 92% used");
  });

  it("notify.quota=false mutes the push but the tier state still advances", async () => {
    h.cfg = { ...h.cfg!, notify: { ...h.cfg!.notify, quota: false } };
    await checkQuotaThresholds(result(item("token_5h", 81)));
    expect(pushes).toHaveLength(0);

    // Re-enabled later: the 80 crossing does NOT replay; only the next tier fires.
    h.cfg = { ...h.cfg!, notify: { ...h.cfg!.notify, quota: true } };
    await checkQuotaThresholds(result(item("token_5h", 91)));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("5h quota 91% used");
  });

  it("touching nothing when push is inactive — not even the state file", async () => {
    h.cfg = null;
    await checkQuotaThresholds(result(item("token_5h", 100)));
    expect(pushes).toHaveLength(0);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("non-success results are a no-op", async () => {
    await checkQuotaThresholds({ kind: "unavailable" });
    await checkQuotaThresholds({ kind: "auth_error" });
    expect(pushes).toHaveLength(0);
  });
});
