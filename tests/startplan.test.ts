/**
 * ZCode Start Plan quota reader tests — the `billing/balance` mapper, the
 * credential/device-id reader, the `queryStartPlan` failure mapping, and the
 * `zcode` section wiring in `account/usage_stats`.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryStartPlanMock, storeStartPlanJwtMock, queryCombinedMock, remoteConfigMock } =
  vi.hoisted(() => ({
    queryStartPlanMock: vi.fn(),
    storeStartPlanJwtMock: vi.fn(),
    queryCombinedMock: vi.fn(),
    remoteConfigMock: vi.fn(),
  }));

vi.mock("../src/config/account-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config/account-provider.js")>(
    "../src/config/account-provider.js",
  );
  return { ...actual, storeStartPlanJwt: storeStartPlanJwtMock };
});

vi.mock("../src/quota/startplan.js", async () => {
  const actual = await vi.importActual<typeof import("../src/quota/startplan.js")>(
    "../src/quota/startplan.js",
  );
  return { ...actual, queryStartPlan: queryStartPlanMock };
});

vi.mock("../src/remote/config.js", () => ({ parseRemoteConfig: remoteConfigMock }));

vi.mock("../src/quota/combined.js", () => ({ queryCombined: queryCombinedMock }));

import { accountUsageStats, accountUsageStatsViaHub } from "../src/handlers/account.js";
import {
  parseStartPlanBalance,
  readZcodeAccountAuth,
  resetStartPlanCacheForTests,
} from "../src/quota/startplan.js";
import {
  resetStartPlanVerdictForTests,
  setStartPlanVerdict,
  startPlanVerdict,
} from "../src/config/start-plan-verdict.js";

let home: string | null = null;

beforeEach(() => {
  resetStartPlanCacheForTests();
  resetStartPlanVerdictForTests();
  storeStartPlanJwtMock.mockReset();
  queryStartPlanMock.mockReset();
  queryCombinedMock.mockReset();
  remoteConfigMock.mockReset();
  home = mkdtempSync(path.join(os.tmpdir(), "zcode-startplan-test-"));
  process.env.ZCODE_HOME = home;
  mkdirSync(path.join(home, "v2"), { recursive: true });
});

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
  delete process.env.ZCODE_HOME;
  vi.unstubAllGlobals();
});

function writeTelemetryState(deviceMid: string): void {
  writeFileSync(path.join(home!, "v2", "telemetry-state.json"), JSON.stringify({ deviceMid }));
}

/** Envelope mirroring a live `billing/balance` response (2026-11-13). */
const ENVELOPE = {
  code: 0,
  msg: "",
  data: {
    server_time: 1794516413,
    plans: [
      {
        user_plan_id: "upl_1",
        plan_id: "zcode-v3-start-plan-1113-wk",
        name: "ZCODE WEEKEND BUILD",
        status: "active",
        starts_at: 1794488473,
        ends_at: 1794790800,
      },
      {
        user_plan_id: "upl_other",
        plan_id: "zcode-v3-start-plan-expired",
        name: "ZCODE GLOBAL BUILD",
        status: "expired",
      },
    ],
    balances: [
      {
        bucket_id: "bucket_1",
        user_plan_id: "upl_1",
        plan_id: "zcode-v3-start-plan-1113-wk",
        entitlement_id: "ent-zcode-v3-start-plan-1113-wk-1",
        show_name: "GLM-5.3-Flash",
        meter: "model_usage",
        unit_type: "token",
        capabilities: ["model:glm-5.3-flash"],
        total_units: 500000000,
        used_units: 1059633,
        remaining_units: 498940367,
        period_start: 1794488473,
        period_end: 1794790800,
        expires_at: 1794790800,
      },
    ],
  },
};

describe("parseStartPlanBalance", () => {
  it("maps the active start plan and its grant into normalised windows", () => {
    const result = parseStartPlanBalance(ENVELOPE);
    expect(result).toMatchObject({
      kind: "success",
      planId: "zcode-v3-start-plan-1113-wk",
      planName: "ZCODE WEEKEND BUILD",
    });
    expect(result.kind === "success" && result.windows).toHaveLength(1);
    const window = result.kind === "success" ? result.windows[0]! : undefined;
    expect(window).toMatchObject({
      key: "ent-zcode-v3-start-plan-1113-wk-1",
      label: "ZCODE WEEKEND BUILD · GLM-5.3-Flash",
      plan: "ZCODE WEEKEND BUILD",
      model: "GLM-5.3-Flash",
      modelIds: ["glm-5.3-flash"],
      usedUnits: 1059633,
      totalUnits: 500000000,
      remainingUnits: 498940367,
      resetsAt: 1794790800000,
      oneTime: true,
    });
    expect(window!.usagePercent).toBeCloseTo(0.2119266, 6);
  });

  it("prefers the active zcode plan over other active rows", () => {
    const result = parseStartPlanBalance({
      code: 0,
      data: {
        plans: [
          { user_plan_id: "upl_x", plan_id: "other-plan", name: "Other", status: "active" },
          ENVELOPE.data.plans[0],
        ],
        balances: ENVELOPE.data.balances,
      },
    });
    expect(result.kind === "success" && result.planId).toBe("zcode-v3-start-plan-1113-wk");
  });

  it("maps business codes to per-section kinds", () => {
    expect(parseStartPlanBalance({ code: 401 })).toMatchObject({ kind: "auth_error" });
    expect(parseStartPlanBalance({ code: 3101 })).toMatchObject({ kind: "unavailable" });
  });

  it("is `none` without an active plan — the authoritative negative (#406)", () => {
    // Distinct from `unavailable` (query failed): billing answered, the
    // account simply holds no active start plan.
    expect(
      parseStartPlanBalance({ code: 0, data: { plans: [{ status: "expired" }] } }),
    ).toMatchObject({ kind: "none" });
  });

  it("is success with empty windows when the plan holds no balances", () => {
    const result = parseStartPlanBalance({
      code: 0,
      data: { plans: ENVELOPE.data.plans, balances: [] },
    });
    expect(result.kind === "success" && result.windows).toHaveLength(0);
  });
});

describe("readZcodeAccountAuth", () => {
  it("reads the JWT from the store and the device id from telemetry state", () => {
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    expect(readZcodeAccountAuth()).toEqual({ jwt: "test-jwt", deviceMid: "device-1234" });
  });

  it("is null without the account JWT", () => {
    storeStartPlanJwtMock.mockReturnValue(null);
    writeTelemetryState("device-1234");
    expect(readZcodeAccountAuth()).toBeNull();
  });

  it("is null without a telemetry device id", () => {
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    expect(readZcodeAccountAuth()).toBeNull();
  });
});

describe("queryStartPlan", () => {
  it("maps fetch failures to unavailable", async () => {
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    // The module-level mock replaces queryStartPlan; pull the real one for these.
    const { queryStartPlan: realQueryStartPlan } = await vi.importActual<
      typeof import("../src/quota/startplan.js")
    >("../src/quota/startplan.js");
    const result = await realQueryStartPlan((() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch);
    expect(result).toMatchObject({ kind: "unavailable" });
  });

  it("returns the parsed envelope on success", async () => {
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    const { queryStartPlan: realQueryStartPlan } = await vi.importActual<
      typeof import("../src/quota/startplan.js")
    >("../src/quota/startplan.js");
    const result = await realQueryStartPlan((() =>
      Promise.resolve(
        new Response(JSON.stringify(ENVELOPE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch);
    expect(result.kind).toBe("success");
  });

  it("maps status-line failures to kinds regardless of the body (proposal 0002)", async () => {
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    const { queryStartPlan: realQueryStartPlan } = await vi.importActual<
      typeof import("../src/quota/startplan.js")
    >("../src/quota/startplan.js");
    const statusFetch = (status: number): typeof fetch =>
      (() =>
        Promise.resolve(
          new Response("gateway said no", { status, headers: { "content-type": "text/plain" } }),
        )) as unknown as typeof fetch;
    expect(await realQueryStartPlan(statusFetch(401))).toEqual({ kind: "auth_error" });
    resetStartPlanCacheForTests();
    expect(await realQueryStartPlan(statusFetch(403))).toEqual({ kind: "auth_error" });
    resetStartPlanCacheForTests();
    expect(await realQueryStartPlan(statusFetch(429))).toEqual({ kind: "rate_limited" });
  });
});

describe("queryStartPlan cache", () => {
  const NOW = 1_700_000_000_000;

  /** The real queryStartPlan (the module mock replaces it). */
  const realQueryStartPlan = async (
    ...args: Parameters<typeof import("../src/quota/startplan.js").queryStartPlan>
  ) => {
    const { queryStartPlan } = await vi.importActual<typeof import("../src/quota/startplan.js")>(
      "../src/quota/startplan.js",
    );
    return queryStartPlan(...args);
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  const okFetch = (): typeof fetch =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify(ENVELOPE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;

  it("serves repeat queries from the 10s cache — one gateway hit per TTL window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    const fetchMock = vi.fn(okFetch());
    const first = await realQueryStartPlan(fetchMock);
    const second = await realQueryStartPlan(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    vi.setSystemTime(NOW + 10_001);
    await realQueryStartPlan(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches parsed failure kinds too — an envelope auth-error storm makes one gateway hit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    const fetchMock = vi.fn((() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 401, msg: "unauthorized" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch);
    const first = await realQueryStartPlan(fetchMock);
    expect(first).toEqual({ kind: "auth_error" });
    await realQueryStartPlan(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache status-line failures — the next call retries the gateway", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    const fetchMock = vi.fn((() =>
      Promise.resolve(new Response("nope", { status: 429 }))) as unknown as typeof fetch);
    expect(await realQueryStartPlan(fetchMock)).toEqual({ kind: "rate_limited" });
    expect(await realQueryStartPlan(fetchMock)).toEqual({ kind: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache thrown network failures — the next call retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(ENVELOPE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch;
    expect(await realQueryStartPlan(fetchMock)).toMatchObject({ kind: "unavailable" });
    expect(await realQueryStartPlan(fetchMock)).toMatchObject({ kind: "success" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("queryStartPlan entitlement verdict (#406)", () => {
  /** The real queryStartPlan (the module mock replaces it). */
  const realQueryStartPlan = async (fetchImpl: typeof fetch) => {
    const { queryStartPlan } = await vi.importActual<typeof import("../src/quota/startplan.js")>(
      "../src/quota/startplan.js",
    );
    return queryStartPlan(fetchImpl);
  };

  const jsonFetch = (body: unknown, status = 200): typeof fetch =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;

  it("writes `entitled` with the grants' capability model ids on success", async () => {
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    const result = await realQueryStartPlan(jsonFetch(ENVELOPE));
    expect(result.kind).toBe("success");
    expect(startPlanVerdict()).toEqual({ status: "entitled", modelIds: ["glm-5.3-flash"] });
  });

  it("writes `none` when billing holds no active plan", async () => {
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    const result = await realQueryStartPlan(
      jsonFetch({ code: 0, data: { plans: [{ status: "expired" }] } }),
    );
    expect(result).toEqual({ kind: "none" });
    expect(startPlanVerdict()).toEqual({ status: "none" });
  });

  it("leaves an earlier verdict standing on failures — entitlement never flaps on a blip", async () => {
    setStartPlanVerdict({ status: "entitled", modelIds: ["glm-5.3-flash"] });
    storeStartPlanJwtMock.mockReturnValue("test-jwt");
    writeTelemetryState("device-1234");
    // Network failure: not a verdict.
    await realQueryStartPlan((() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch);
    expect(startPlanVerdict()).toEqual({ status: "entitled", modelIds: ["glm-5.3-flash"] });
    // Status-line auth error: the desktop may be mid-refresh of the JWT —
    // still not a `none` verdict.
    const result = await realQueryStartPlan((() =>
      Promise.resolve(
        new Response("gateway said no", { status: 401, headers: { "content-type": "text/plain" } }),
      )) as unknown as typeof fetch);
    expect(result).toEqual({ kind: "auth_error" });
    expect(startPlanVerdict()).toEqual({ status: "entitled", modelIds: ["glm-5.3-flash"] });
  });
});

describe("accountUsageStats zcode section", () => {
  it("passes the zcode section through verbatim", async () => {
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "not_configured" },
    });
    queryStartPlanMock.mockResolvedValue({
      kind: "success",
      planId: "zcode-v3-start-plan-1113-wk",
      planName: "ZCODE WEEKEND BUILD",
      windows: [
        {
          key: "ent-zcode-v3-start-plan-1113-wk-1",
          label: "ZCODE WEEKEND BUILD · GLM-5.3-Flash",
          usagePercent: 0.21,
          resetsAt: 1794790800000,
          modelIds: ["glm-5.3-flash"],
          usedUnits: 1059633,
          totalUnits: 500000000,
          remainingUnits: 498940367,
          oneTime: true,
        },
      ],
    });
    const stats = await accountUsageStats();
    expect(stats.zcode).toMatchObject({
      kind: "success",
      planId: "zcode-v3-start-plan-1113-wk",
      planName: "ZCODE WEEKEND BUILD",
      windows: [
        expect.objectContaining({
          key: "ent-zcode-v3-start-plan-1113-wk-1",
          label: "ZCODE WEEKEND BUILD · GLM-5.3-Flash",
          oneTime: true,
        }),
      ],
    });
  });

  it("reports per-section kinds instead of throwing", async () => {
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "not_configured" },
    });
    queryStartPlanMock.mockResolvedValue({ kind: "unavailable" });
    const stats = await accountUsageStats();
    expect(stats.zcode).toEqual({ kind: "unavailable" });
  });

  it("maps the internal `none` verdict kind to `unavailable` on the wire", async () => {
    // `none` is the entitlement signal, not a client-facing status — proposal
    // 0002's kind vocabulary stays frozen.
    queryCombinedMock.mockResolvedValue({
      glm: { kind: "unavailable" },
      go: { kind: "not_configured" },
      oc: { kind: "not_configured" },
    });
    queryStartPlanMock.mockResolvedValue({ kind: "none" });
    const stats = await accountUsageStats();
    expect(stats.zcode).toEqual({ kind: "unavailable" });
  });
});

describe("accountUsageStatsViaHub skew guard", () => {
  const ZCODE_LOCAL = {
    kind: "success" as const,
    planId: "zcode-v3-start-plan-1113-wk",
    planName: "ZCODE WEEKEND BUILD",
    windows: [
      {
        key: "ent-zcode-v3-start-plan-1113-wk-1",
        label: "ZCODE WEEKEND BUILD · GLM-5.3-Flash",
        usagePercent: 0.21,
        resetsAt: 1794790800000,
        modelIds: ["glm-5.3-flash"],
        usedUnits: 1059633,
        totalUnits: 500000000,
        remainingUnits: 498940367,
        oneTime: true,
      },
    ],
  };

  const COMBINED = {
    glm: { kind: "unavailable" },
    go: { kind: "not_configured" },
    oc: { kind: "not_configured" },
  };

  const hubFetch = (body: object): typeof fetch =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;

  it("falls back to the local sweep when an older hub answers without zcode", async () => {
    remoteConfigMock.mockReturnValue({ hubHost: "hub.test", hubPort: 1, token: "t" });
    const fetchMock = vi.fn(hubFetch({ glm: { kind: "unavailable" } }));
    vi.stubGlobal("fetch", fetchMock);
    queryCombinedMock.mockResolvedValue(COMBINED);
    queryStartPlanMock.mockResolvedValue(ZCODE_LOCAL);
    const stats = await accountUsageStatsViaHub();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The local sweep fills every section: no silent zcode hole.
    expect(stats.glm).toEqual({ kind: "unavailable" });
    expect(stats.zcode).toMatchObject({ kind: "success", planName: "ZCODE WEEKEND BUILD" });
  });

  it("uses the hub answer when it carries the zcode section — no local sweep", async () => {
    remoteConfigMock.mockReturnValue({ hubHost: "hub.test", hubPort: 1, token: "t" });
    const hubBody = {
      glm: { kind: "unavailable" },
      zcode: { kind: "unavailable" },
    };
    vi.stubGlobal("fetch", vi.fn(hubFetch(hubBody)));
    const stats = await accountUsageStatsViaHub();
    expect(stats).toEqual(hubBody);
    expect(queryStartPlanMock).not.toHaveBeenCalled();
    expect(queryCombinedMock).not.toHaveBeenCalled();
  });
});
