/**
 * ACP model option values always encode as providerId\modelId, including
 * builtins. Bare GLM-5.3 collided when two coding plans shipped the same id
 * and crashed clients that key on uniqueness (Paseo Command Center). A
 * collision-only prefix would have advertised different id shapes depending
 * on the user's enabled-provider set.
 *
 * parseModelValue still accepts a legacy bare modelId (first enabled builtin).
 * Dropdown labels stay the bare modelId for a single builtin; colliding
 * modelIds are qualified with the provider name.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";
import { ZcodeAcpServer } from "../src/server.js";

function codingPlan(name: string, baseURL: string) {
  return {
    name,
    kind: "anthropic",
    enabled: true,
    options: { apiKey: "plan-token", apiKeyRequired: true, baseURL },
    models: {
      "GLM-5.3": { limit: { context: 200000 } },
      "GLM-5.3-Flash": { limit: { context: 200000 } },
    },
  };
}

function collidingPlansConfig() {
  return {
    provider: {
      "builtin:zai-coding-plan": codingPlan("Z.ai - Coding Plan", "https://api.z.ai/api/anthropic"),
      "builtin:zai-start-plan": codingPlan(
        "Z.ai - Start Plan",
        "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      ),
    },
  };
}

let fakeConfig: unknown = collidingPlansConfig();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(fakeConfig);
      return actual.readFileSync(p);
    },
  };
});

const { buildConfigOptions, buildModes, formatModelValue, loadAllModels, parseModelValue } =
  await import("../src/config/options.js");

afterEach(() => {
  fakeConfig = collidingPlansConfig();
});

describe("model configOptions uniqueness", () => {
  it("does not advertise duplicate values when two builtins share GLM-5.3", async () => {
    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const values = model?.options.map((option) => option.value) ?? [];

    expect(values).toEqual([...new Set(values)]);
    expect(values).toHaveLength(4);
    expect(model?.currentValue).toBeDefined();
    expect(values).toContain(model?.currentValue);
  });

  it("keeps both colliding coding plans selectable", async () => {
    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const parsed = (model?.options ?? []).map((option) => parseModelValue(option.value));

    expect(parsed).toEqual([
      { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" },
      { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3-Flash" },
      { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3" },
      { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3-Flash" },
    ]);
    expect(model?.options.map((option) => option.name)).toEqual([
      "Z.ai - Coding Plan › GLM-5.3",
      "Z.ai - Coding Plan › GLM-5.3-Flash",
      "Z.ai - Start Plan › GLM-5.3",
      "Z.ai - Start Plan › GLM-5.3-Flash",
    ]);
  });

  it("encodes a single builtin as providerId\\modelId too", async () => {
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": codingPlan(
          "Z.ai - Coding Plan",
          "https://api.z.ai/api/anthropic",
        ),
      },
    };

    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const values = model?.options.map((option) => option.value) ?? [];

    expect(values).toEqual([
      "builtin:zai-coding-plan\\GLM-5.3",
      "builtin:zai-coding-plan\\GLM-5.3-Flash",
    ]);
    expect(model?.options.map((option) => option.name)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    expect(model?.currentValue).toBe(formatModelValue("builtin:zai-coding-plan", "GLM-5.3"));
    expect(parseModelValue("GLM-5.3")).toEqual({
      providerId: "builtin:zai-coding-plan",
      modelId: "GLM-5.3",
    });
    expect(loadAllModels()).toHaveLength(2);
  });
});

describe("thought option display clamp", () => {
  it("never advertises a current outside the model's available levels (stale after setModel)", async () => {
    // The runtime can briefly keep the PREVIOUS model's thoughtLevel after a
    // setModel (upstream clamps its own snapshot for the same reason). The
    // bridge must not relay the stale value: the CLI would display — and
    // re-send — the old model's level.
    const server = new ZcodeAcpServer();
    server.backend = {
      isDead: false,
      request: async () => ({
        result: {
          settings: {
            mode: { current: "build" },
            model: { current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" } },
            thoughtLevel: {
              current: "max", // stale: the previous model's level
              defaultLevel: "high",
              available: [
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
              ],
            },
          },
        },
      }),
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;

    const options = await buildConfigOptions(server, "zc-clamp-1");
    const thought = options.find((option) => option.id === "thought");
    expect(thought?.currentValue).toBe("high");
    expect(thought?.options.map((option) => option.value)).toEqual(["low", "high"]);
  });

  it("falls back to the first available level when the default is also outside the list", async () => {
    const server = new ZcodeAcpServer();
    server.backend = {
      isDead: false,
      request: async () => ({
        result: {
          settings: {
            mode: { current: "build" },
            model: { current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" } },
            thoughtLevel: {
              current: "max",
              defaultLevel: "max", // stale too
              available: [
                { value: "enabled", label: "Enabled" },
                { value: "off", label: "Off" },
              ],
            },
          },
        },
      }),
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;

    const options = await buildConfigOptions(server, "zc-clamp-2");
    const thought = options.find((option) => option.id === "thought");
    expect(thought?.currentValue).toBe("enabled");
  });
});

describe("plan-mode display fold", () => {
  // The runtime's EnterPlanMode flips the execution state's planEnabled
  // WITHOUT touching settings.mode — session/read keeps reporting the
  // underlying mode (verified upstream). The tracked plan flag must force
  // every advertised mode to "plan" while it is on.
  function planServer(): ZcodeAcpServer {
    const server = new ZcodeAcpServer();
    server.backend = {
      isDead: false,
      request: async () => ({
        result: {
          settings: {
            mode: { current: "yolo" },
            model: { current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.3" } },
            thoughtLevel: { current: "max" },
          },
        },
      }),
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
    return server;
  }

  it("buildModes advertises plan while the flag is tracked", async () => {
    const server = planServer();
    server.sessionPlanActive.add("zc-plan-1");
    expect((await buildModes(server, "zc-plan-1")).currentModeId).toBe("plan");
    server.sessionPlanActive.delete("zc-plan-1");
    expect((await buildModes(server, "zc-plan-1")).currentModeId).toBe("yolo");
  });

  it("buildConfigOptions sets the mode dropdown to plan while the flag is tracked", async () => {
    const server = planServer();
    server.sessionPlanActive.add("zc-plan-2");
    const options = await buildConfigOptions(server, "zc-plan-2");
    const mode = options.find((option) => option.id === "mode");
    expect(mode?.currentValue).toBe("plan");
  });
});
