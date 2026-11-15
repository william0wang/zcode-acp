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
 * Every model encodes as providerId\modelId. A legacy bare modelId still
 * parses as the first enabled builtin.
 */

import { describe, expect, it, vi } from "vitest";

import { ZcodeAcpServer } from "../src/server.js";
import { ZCODE_CREDS_PATH, zcodePersonalProviderPath } from "../src/utils.js";

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

/** Swapped by tests that need a personal provider_config.json; null = absent. */
let fakePersonal: unknown = null;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(fakeConfig);
      if (p === zcodePersonalProviderPath() && fakePersonal !== null) {
        return JSON.stringify(fakePersonal);
      }
      return actual.readFileSync(p);
    },
  };
});

// Import AFTER vi.mock is set up.
const { loadAllModels, parseModelValue, buildRuntimeModel, applyModelSwitch } =
  await import("../src/config/options.js").then(async () => {
    const opts = await import("../src/config/options.js");
    const rm = await import("../src/config/runtime-model.js");
    return {
      ...opts,
      buildRuntimeModel: rm.buildRuntimeModel,
      applyModelSwitch: rm.applyModelSwitch,
    };
  });

describe("loadAllModels", () => {
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
});

describe("parseModelValue / formatModelValue", () => {
  it("a plain modelId (no backslash) resolves to the first enabled builtin provider", () => {
    const parsed = parseModelValue("model-a");
    expect(parsed.modelId).toBe("model-a");
    expect(parsed.providerId).toBe("builtin:primary");
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
});

describe("applyModelSwitch level candidates (file sources)", () => {
  const VALUE = "custom-provider-alpha\\alpha-1";
  const SID = "zc-alpha-1";

  /** Fake backend answering session/setModel from a scripted sequence. */
  function bootScripted(responses: Array<Record<string, unknown>>) {
    let attempt = 0;
    const server = new ZcodeAcpServer();
    const calls: Array<Record<string, unknown>> = [];
    server.backend = {
      isDead: false,
      request: async (_id: number, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method !== "session/setModel") return { result: {} };
        return attempt < responses.length
          ? (responses[attempt++] ?? { result: {} })
          : { result: {} };
      },
    } as unknown as NonNullable<ZcodeAcpServer["backend"]>;
    return { server, calls };
  }
  const levelOf = (params: Record<string, unknown>): string | undefined =>
    ((params["model"] as { options?: { reasoningLevel?: string } })?.options ?? {}).reasoningLevel;
  const personalWith = (values: string[]) => ({
    config: {
      modelConfigRules: {
        providerModelRules: [
          {
            providerId: "custom-provider-alpha",
            modelId: "alpha-1",
            config: { optionSpecs: { reasoningLevel: { values } } },
          },
        ],
      },
    },
  });

  it("prefers the personal config's default (LAST value) over legacy config.json", async () => {
    // config.json is legacy-stale by design (3.12+ stopped syncing it); the
    // personal file is the registry's input. Default = values.at(-1), the
    // upstream rule (model-catalog-port.ts).
    fakeConfig = {
      provider: {
        "custom-provider-alpha": {
          ...FAKE_CONFIG.provider["custom-provider-alpha"]!,
          models: {
            "alpha-1": {
              reasoning: {
                enabled: true,
                variants: ["stale-level", "high"],
                defaultVariant: "stale-level",
              },
            },
          },
        },
      },
    };
    fakePersonal = personalWith(["high", "max", "low"]);
    try {
      const { server, calls } = bootScripted([{ result: {} }]);
      await expect(applyModelSwitch(server, SID, VALUE)).resolves.toBe(true);
      const first = calls.find((c) => c.method === "session/setModel")!;
      expect(levelOf(first.params)).toBe("low");
    } finally {
      fakeConfig = FAKE_CONFIG;
      fakePersonal = null;
    }
  });

  it("recovers when a stale config.json default is rejected by the registry", async () => {
    // The observed 2026-09-28 failure shape: config.json says defaultVariant
    // "max", the live registry def has no such level. Ladder: max → rejected,
    // omission → level-required, remaining variant "high" → accepted.
    fakeConfig = {
      provider: {
        "custom-provider-alpha": {
          ...FAKE_CONFIG.provider["custom-provider-alpha"]!,
          models: {
            "alpha-1": {
              reasoning: { enabled: true, variants: ["high"], defaultVariant: "max" },
            },
          },
        },
      },
    };
    try {
      const { server, calls } = bootScripted([
        {
          error: {
            message: 'Reasoning effort "max" is not supported by custom-provider-alpha/alpha-1',
          },
        },
        { error: { message: "Reasoning level is required for custom-provider-alpha/alpha-1" } },
        { result: {} },
      ]);
      await expect(applyModelSwitch(server, SID, VALUE)).resolves.toBe(true);
      const setModels = calls.filter((c) => c.method === "session/setModel");
      expect(setModels).toHaveLength(3);
      expect(levelOf(setModels[0]!.params)).toBe("max");
      expect(levelOf(setModels[1]!.params)).toBeUndefined();
      expect(levelOf(setModels[2]!.params)).toBe("high");
    } finally {
      fakeConfig = FAKE_CONFIG;
      fakePersonal = null;
    }
  });
});
