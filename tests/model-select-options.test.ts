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

const { buildConfigOptions, formatModelValue, loadAllModels, parseModelValue } =
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
