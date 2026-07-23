/**
 * Tests for multi-provider model discovery and runtimeModel construction.
 *
 * History: loadProviderModels() hardcoded a single builtin provider id, so
 * custom providers configured in the ZCode desktop app never appeared in the
 * dropdown. These tests lock the new behaviour: loadAllModels() aggregates ALL
 * enabled providers, buildRuntimeModel() NEVER carries apiKey (the backend's
 * runtimeModel schema rejects it), builtin models encode as bare modelIds, and
 * third-party models carry their providerId prefix.
 */

import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

/** Fake config.json with one builtin (OAuth, no apiKey) + one custom (apiKey). */
const FAKE_CONFIG = {
  provider: {
    "builtin:bigmodel-coding-plan": {
      name: "BigModel",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://open.bigmodel.cn/api/anthropic" },
      models: {
        "GLM-5.2": { limit: { context: 1000000 } },
        "GLM-5-Turbo": { limit: { context: 200000 } },
      },
    },
    "builtin:zai-coding-plan": {
      name: "ZAI",
      kind: "anthropic",
      enabled: false,
      options: { baseURL: "https://api.z.ai" },
      models: { "GLM-5.2": { limit: { context: 1000000 } } },
    },
    "2e06bf1a-custom-nvidia": {
      name: "Nvidia",
      kind: "openai-compatible",
      enabled: true,
      source: "custom",
      options: {
        apiKey: "sk-custom-key-123",
        baseURL: "http://127.0.0.1:18586/openai",
      },
      models: {
        "nvidia/stepfun-ai/step-3.7-flash": { limit: { context: 200000 } },
      },
    },
    "b5b27f58-custom-glm": {
      name: "GLM-Code-Plan",
      kind: "anthropic",
      source: "custom",
      options: { apiKey: "key-456", baseURL: "https://open.bigmodel.cn/api/anthropic" },
      models: { "glm-4.7": { limit: { context: 200000 } } },
    },
  },
};

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(FAKE_CONFIG);
      return actual.readFileSync(p);
    },
  };
});

// Import AFTER vi.mock is set up.
const { loadAllModels, modelContextWindow, parseModelValue, formatModelValue, buildRuntimeModel } =
  await import("../src/config/options.js").then(async () => {
    const opts = await import("../src/config/options.js");
    const rm = await import("../src/config/runtime-model.js");
    return { ...opts, buildRuntimeModel: rm.buildRuntimeModel };
  });

describe("loadAllModels", () => {
  it("only collects models from enabled providers", () => {
    const models = loadAllModels();
    const ids = models.map((m) => m.modelId);
    // Enabled builtin + enabled custom. The disabled ZAI and the custom-without-
    // enabled (b5b27f58) must NOT appear.
    expect(ids).toContain("GLM-5.2");
    expect(ids).toContain("GLM-5-Turbo");
    expect(ids).toContain("nvidia/stepfun-ai/step-3.7-flash");
    // glm-4.7 is in a provider WITHOUT an enabled flag → excluded.
    expect(ids).not.toContain("glm-4.7");
  });

  it("carries the provider name for display", () => {
    const models = loadAllModels();
    const nvidia = models.find((m) => m.modelId.includes("step-3.7-flash"));
    expect(nvidia?.providerName).toBe("Nvidia");
    expect(nvidia?.providerId).toBe("2e06bf1a-custom-nvidia");
  });
});

describe("modelContextWindow", () => {
  it("looks up context by provider+model (not hardcoded provider)", () => {
    expect(modelContextWindow("builtin:bigmodel-coding-plan", "GLM-5.2")).toBe(1000000);
    expect(modelContextWindow("2e06bf1a-custom-nvidia", "nvidia/stepfun-ai/step-3.7-flash")).toBe(
      200000,
    );
  });

  it("returns 0 for an unknown provider/model", () => {
    expect(modelContextWindow("unknown", "nope")).toBe(0);
  });
});

describe("parseModelValue / formatModelValue", () => {
  it("builtin providers encode as bare modelId (no prefix)", () => {
    // The common case stays clean — builtin models show just the modelId.
    const value = formatModelValue("builtin:bigmodel-coding-plan", "GLM-5.2");
    expect(value).toBe("GLM-5.2");
    expect(parseModelValue(value)).toEqual({
      providerId: "builtin:bigmodel-coding-plan",
      modelId: "GLM-5.2",
    });
  });

  it("third-party providers round-trip providerId + modelId", () => {
    const value = formatModelValue("2e06bf1a-custom-nvidia", "nvidia/stepfun-ai/step-3.7-flash");
    expect(value).toBe("2e06bf1a-custom-nvidia\\nvidia/stepfun-ai/step-3.7-flash");
    expect(parseModelValue(value)).toEqual({
      providerId: "2e06bf1a-custom-nvidia",
      modelId: "nvidia/stepfun-ai/step-3.7-flash",
    });
  });

  it("a plain modelId (no backslash) resolves to the first enabled builtin provider", () => {
    const parsed = parseModelValue("GLM-5.2");
    expect(parsed.modelId).toBe("GLM-5.2");
    expect(parsed.providerId).toBe("builtin:bigmodel-coding-plan");
  });

  it("splits on the FIRST backslash only (modelId may contain none)", () => {
    const parsed = parseModelValue("pid\\GLM-5.2");
    expect(parsed).toEqual({ providerId: "pid", modelId: "GLM-5.2" });
  });
});

describe("buildRuntimeModel", () => {
  it("NEVER carries apiKey — the backend schema rejects it and resolves auth itself", () => {
    // Even for a custom provider WITH an apiKey in config (2e06bf1a-custom-nvidia),
    // the overlay must omit it: the backend's runtimeModel schema types apiKey as
    // a discriminated-union object, and a bare string → "Invalid params".
    const rm = buildRuntimeModel({
      providerId: "2e06bf1a-custom-nvidia",
      providerName: "Nvidia",
      modelId: "nvidia/stepfun-ai/step-3.7-flash",
    }) as { provider: { apiKey?: string; baseURL?: string; kind?: string } };

    expect(rm.provider.apiKey).toBeUndefined();
    expect(rm.provider.baseURL).toBe("http://127.0.0.1:18586/openai");
    expect(rm.provider.kind).toBe("openai-compatible");
  });

  it("omits apiKey for builtin OAuth providers (no apiKey in config)", () => {
    const rm = buildRuntimeModel({
      providerId: "builtin:bigmodel-coding-plan",
      providerName: "BigModel",
      modelId: "GLM-5.2",
    }) as { provider: { apiKey?: string } };

    expect(rm.provider.apiKey).toBeUndefined();
  });

  it("returns null for an unknown provider", () => {
    expect(
      buildRuntimeModel({ providerId: "nope", providerName: "nope", modelId: "x" }),
    ).toBeNull();
  });

  it("includes all the provider's models in the overlay", () => {
    const rm = buildRuntimeModel({
      providerId: "builtin:bigmodel-coding-plan",
      providerName: "BigModel",
      modelId: "GLM-5.2",
    }) as { provider: { models: Array<{ modelId: string }> } };

    const modelIds = rm.provider.models.map((m) => m.modelId);
    expect(modelIds).toEqual(["GLM-5.2", "GLM-5-Turbo"]);
  });
});
