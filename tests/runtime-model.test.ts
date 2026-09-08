/**
 * Tests for multi-provider model discovery and runtimeModel construction.
 *
 * History: loadProviderModels() hardcoded a single builtin provider id, so
 * custom providers configured in the ZCode desktop app never appeared in the
 * dropdown. These tests lock the new behaviour: loadAllModels() aggregates
 * enabled builtin providers (which must carry a credential — a keyless one is
 * "未启用" in the desktop, #156) PLUS custom providers that are usable (not
 * explicitly disabled, and either credentialed or local/keyless-optional),
 * buildRuntimeModel() inlines apiKey as {source:"inline",value}
 * for third-party providers (the backend resolves model-call auth from the
 * overlay itself; omitting it yields HTTP 401) but omits it for builtins.
 * Builtin models encode as bare modelIds, and third-party models carry their
 * providerId prefix.
 */

import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

/**
 * Fake config.json. Enabled builtins carry their plan token in options.apiKey
 * (the desktop's own storage shape — a keyless builtin is "未启用" there and
 * must not reach the IDE dropdown, issue #156).
 */
const FAKE_CONFIG = {
  provider: {
    "builtin:primary": {
      name: "Primary",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://example.test/api", apiKey: "plan-token" },
      models: {
        "model-a": { limit: { context: 1000000 } },
        "model-b": { limit: { context: 200000 } },
      },
    },
    "builtin:secondary": {
      name: "Secondary",
      kind: "anthropic",
      enabled: false,
      options: { baseURL: "https://example.test/api2" },
      models: { "model-a": { limit: { context: 1000000 } } },
    },
    "builtin:bigmodel": {
      name: "BigModel",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://open.bigmodel.cn/api/anthropic" },
      models: { "bg-1": { limit: { context: 128000 } } },
    },
    "custom-provider-alpha": {
      name: "Alpha",
      kind: "openai-compatible",
      enabled: true,
      source: "custom",
      options: {
        apiKey: "test-key-alpha",
        baseURL: "http://127.0.0.1:8000/v1",
      },
      models: {
        "alpha-1": { limit: { context: 200000 } },
      },
    },
    "custom-provider-beta": {
      name: "Beta",
      kind: "anthropic",
      source: "custom",
      options: { apiKey: "test-key-beta", baseURL: "https://example.test/api" },
      models: { "beta-1": { limit: { context: 200000 } } },
    },
    "custom-provider-gamma": {
      name: "Gamma",
      kind: "openai-compatible",
      enabled: false,
      source: "custom",
      options: { apiKey: "test-key-gamma", baseURL: "http://127.0.0.1:8001/v1" },
      models: { "gamma-1": { limit: { context: 200000 } } },
    },
    "custom-provider-remote-keyless": {
      name: "RemoteKeyless",
      kind: "anthropic",
      source: "custom",
      options: { baseURL: "https://api.example.test/v1" },
      models: { "rk-1": { limit: { context: 200000 } } },
    },
    "custom-provider-required-keyless": {
      name: "RequiredKeyless",
      kind: "anthropic",
      source: "custom",
      options: { apiKeyRequired: true, baseURL: "https://api2.example.test/v1" },
      models: { "req-1": { limit: { context: 200000 } } },
    },
    "custom-provider-local": {
      name: "LocalLlama",
      kind: "openai-compatible",
      source: "custom",
      options: { baseURL: "http://127.0.0.1:8080/v1" },
      models: { "llama-x": { limit: { context: 32000 } } },
    },
  },
};

/** Swapped by tests that need a different config.json (see #156 fallback). */
let fakeConfig: unknown = FAKE_CONFIG;

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

// Import AFTER vi.mock is set up.
const { loadAllModels, modelContextWindow, parseModelValue, formatModelValue, buildRuntimeModel } =
  await import("../src/config/options.js").then(async () => {
    const opts = await import("../src/config/options.js");
    const rm = await import("../src/config/runtime-model.js");
    return { ...opts, buildRuntimeModel: rm.buildRuntimeModel };
  });

describe("loadAllModels", () => {
  it("collects enabled builtins + active custom providers", () => {
    const models = loadAllModels();
    const ids = models.map((m) => m.modelId);
    // Enabled builtin + enabled custom appear.
    expect(ids).toContain("model-a");
    expect(ids).toContain("model-b");
    expect(ids).toContain("alpha-1");
    // Disabled builtin (Secondary) stays out — its model-a never duplicates.
    expect(ids.filter((id) => id === "model-a")).toHaveLength(1);
    // beta-1 (custom WITHOUT an enabled flag) is included: the newer CLI leaves
    // `enabled` unset on active third-party providers, so "absent" = enabled.
    expect(ids).toContain("beta-1");
    // gamma-1 (custom with an EXPLICIT enabled:false) is excluded.
    expect(ids).not.toContain("gamma-1");
  });

  it("excludes providers the desktop marks 未启用 for missing credentials (#156)", () => {
    const ids = loadAllModels().map((m) => m.modelId);
    // Keyless builtin (API-key mode picked, no key entered) — excluded even
    // though enabled:true; it can never authenticate.
    expect(ids).not.toContain("bg-1");
    // Keyless REMOTE custom provider — no credentials, remote baseURL.
    expect(ids).not.toContain("rk-1");
    // apiKeyRequired:true without a key — explicitly unusable.
    expect(ids).not.toContain("req-1");
    // Keyless LOCAL provider (llama.cpp/ollama style) stays selectable.
    expect(ids).toContain("llama-x");
    // The credentialed builtin is still there.
    expect(ids).toContain("model-a");
  });

  it("returns [] when every configured provider is unusable (no default leak, #156)", () => {
    // Review finding: the old empty-list fallback re-advertised the very
    // unusable provider (or one absent from the user's config). With
    // providers configured, [] is the honest answer; the default fallback
    // applies only to a fresh install with NO provider map.
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": {
          name: "ZAI",
          kind: "anthropic",
          enabled: true,
          options: { apiKeyRequired: true, baseURL: "https://api.z.ai/api" },
          models: { "GLM-5.3": {} },
        },
      },
    };
    try {
      expect(loadAllModels()).toEqual([]);
    } finally {
      fakeConfig = FAKE_CONFIG;
    }
  });

  it("tracks provider identity for every custom provider", () => {
    const models = loadAllModels();
    const beta = models.find((m) => m.modelId === "beta-1");
    expect(beta?.providerName).toBe("Beta");
    expect(beta?.providerId).toBe("custom-provider-beta");
  });

  it("carries the provider name for display", () => {
    const models = loadAllModels();
    const alpha = models.find((m) => m.modelId === "alpha-1");
    expect(alpha?.providerName).toBe("Alpha");
    expect(alpha?.providerId).toBe("custom-provider-alpha");
  });
});

describe("modelContextWindow", () => {
  it("looks up context by provider+model (not hardcoded provider)", () => {
    expect(modelContextWindow("builtin:primary", "model-a")).toBe(1000000);
    expect(modelContextWindow("custom-provider-alpha", "alpha-1")).toBe(200000);
  });

  it("returns 0 for an unknown provider/model", () => {
    expect(modelContextWindow("unknown", "nope")).toBe(0);
  });
});

describe("parseModelValue / formatModelValue", () => {
  it("builtin providers encode as bare modelId (no prefix)", () => {
    // The common case stays clean — builtin models show just the modelId.
    const value = formatModelValue("builtin:primary", "model-a");
    expect(value).toBe("model-a");
    expect(parseModelValue(value)).toEqual({
      providerId: "builtin:primary",
      modelId: "model-a",
    });
  });

  it("third-party providers round-trip providerId + modelId", () => {
    const value = formatModelValue("custom-provider-alpha", "alpha-1");
    expect(value).toBe("custom-provider-alpha\\alpha-1");
    expect(parseModelValue(value)).toEqual({
      providerId: "custom-provider-alpha",
      modelId: "alpha-1",
    });
  });

  it("a plain modelId (no backslash) resolves to the first enabled builtin provider", () => {
    const parsed = parseModelValue("model-a");
    expect(parsed.modelId).toBe("model-a");
    expect(parsed.providerId).toBe("builtin:primary");
  });

  it("splits on the FIRST backslash only (modelId may contain none)", () => {
    const parsed = parseModelValue("pid\\model-a");
    expect(parsed).toEqual({ providerId: "pid", modelId: "model-a" });
  });
});

describe("buildRuntimeModel", () => {
  it("inlines apiKey as {source:'inline', value} for third-party providers", () => {
    // The backend resolves model-call auth from the runtimeModel itself — a
    // third-party overlay WITHOUT apiKey yields HTTP 401 "Missing API key".
    // apiKey is the inline union, never a bare string (the strict schema rejects it).
    const rm = buildRuntimeModel({
      providerId: "custom-provider-alpha",
      providerName: "Alpha",
      modelId: "alpha-1",
    }) as {
      provider: {
        apiKey?: { source: string; value: string };
        baseURL?: string;
        kind?: string;
        apiFormat?: string;
      };
    };

    expect(rm.provider.apiKey).toEqual({ source: "inline", value: "test-key-alpha" });
    expect(rm.provider.baseURL).toBe("http://127.0.0.1:8000/v1");
    expect(rm.provider.kind).toBe("openai-compatible");
    expect(rm.provider.apiFormat).toBe("openai-chat-completions");
  });

  it("omits apiKey for builtin OAuth providers (auth resolved from config/OAuth)", () => {
    const rm = buildRuntimeModel({
      providerId: "builtin:primary",
      providerName: "Primary",
      modelId: "model-a",
    }) as { provider: { apiKey?: string; apiFormat?: string } };

    expect(rm.provider.apiKey).toBeUndefined();
    expect(rm.provider.apiFormat).toBe("anthropic-messages");
  });

  it("returns null for an unknown provider", () => {
    expect(
      buildRuntimeModel({ providerId: "nope", providerName: "nope", modelId: "x" }),
    ).toBeNull();
  });

  it("includes all the provider's models in the overlay", () => {
    const rm = buildRuntimeModel({
      providerId: "builtin:primary",
      providerName: "Primary",
      modelId: "model-a",
    }) as { provider: { models: Array<{ modelId: string }> } };

    const modelIds = rm.provider.models.map((m) => m.modelId);
    expect(modelIds).toEqual(["model-a", "model-b"]);
  });
});
