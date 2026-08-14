/**
 * Tests for provider-registry payload construction.
 *
 * The V4 backend requires `workspace/updateProviderRegistry` to recognise
 * third-party providers — without it, switching to a custom model fails with
 * `provider_not_configured`. These tests lock the payload schema derived from
 * the backend's `j7t` converter in zcode.cjs: apiKey is the inline union
 * `{source:"inline", value}`, apiFormat maps from kind, models is an array of
 * `{modelId}`, and every configured provider is included (registry is NOT
 * enabled-filtered like the dropdown).
 *
 * All identifiers below are fictional test fixtures — no real provider names,
 * URLs, model ids, or keys are used.
 */

import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

const FAKE_CONFIG = {
  provider: {
    "builtin:primary": {
      name: "Primary",
      kind: "anthropic",
      enabled: true,
      source: "builtin",
      options: { baseURL: "https://example.test/primary" },
      models: { "model-a": { limit: { context: 128000 } } },
    },
    "custom-openai-kind": {
      name: "Custom One",
      kind: "openai-compatible",
      source: "custom",
      options: {
        apiKey: "test-key-one",
        baseURL: "https://example.test/one",
        apiKeyRequired: true,
      },
      models: {
        "custom-model-1": {
          name: "Custom Model One",
          limit: { context: 128000, output: 4096 },
          reasoning: { enabled: true, variants: ["high", "max"], defaultVariant: "max" },
        },
      },
    },
    "custom-anthropic-kind": {
      name: "Custom Two",
      kind: "anthropic",
      source: "custom",
      options: { apiKey: "test-key-two", baseURL: "https://example.test/two" },
      models: { "custom-model-2": { limit: { context: 128000 } } },
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

const { buildProviderRegistry } = await import("../src/config/provider-registry.js");

function providerById(reg: ReturnType<typeof buildProviderRegistry>, id: string) {
  return reg.providers.find((p) => p.providerId === id);
}

describe("buildProviderRegistry", () => {
  it("includes ALL providers (not enabled-filtered like the dropdown)", () => {
    const reg = buildProviderRegistry();
    const ids = reg.providers.map((p) => p.providerId);
    expect(ids).toContain("builtin:primary");
    expect(ids).toContain("custom-openai-kind");
    expect(ids).toContain("custom-anthropic-kind");
  });

  it("wraps apiKey as the inline union {source:'inline', value}, never a bare string", () => {
    const reg = buildProviderRegistry();
    const p = providerById(reg, "custom-openai-kind");
    expect(p?.apiKey).toEqual({ source: "inline", value: "test-key-one" });
    // A bare string would be rejected by the backend's strict schema.
    expect(typeof p?.apiKey).toBe("object");
  });

  it("omits apiKey when the provider has none (builtin OAuth)", () => {
    const reg = buildProviderRegistry();
    const p = providerById(reg, "builtin:primary");
    expect(p?.apiKey).toBeUndefined();
  });

  it("maps kind openai-compatible → apiFormat openai-chat-completions", () => {
    const reg = buildProviderRegistry();
    const p = providerById(reg, "custom-openai-kind");
    expect(p?.apiFormat).toBe("openai-chat-completions");
    expect(p?.kind).toBe("openai-compatible");
  });

  it("maps kind anthropic → apiFormat anthropic-messages", () => {
    const reg = buildProviderRegistry();
    const p = providerById(reg, "custom-anthropic-kind");
    expect(p?.apiFormat).toBe("anthropic-messages");
  });

  it("carries baseURL, label, models, source, and apiKeyRequired", () => {
    const reg = buildProviderRegistry();
    const p = providerById(reg, "custom-openai-kind");
    expect(p?.baseURL).toBe("https://example.test/one");
    expect(p?.label).toBe("Custom One");
    expect(p?.source).toBe("custom");
    expect(p?.apiKeyRequired).toBe(true);
    expect(p?.models).toEqual([
      {
        modelId: "custom-model-1",
        label: "Custom Model One",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        reasoning: {
          enabled: true,
          levels: [
            { value: "high", label: "high" },
            { value: "max", label: "max" },
          ],
          defaultLevel: "max",
        },
      },
    ]);
  });

  it("maps config.json reasoning variants/defaultVariant to levels/defaultLevel", () => {
    // Without reasoning the backend falls back to the apiFormat's 2-state
    // thought levels (enabled/disabled) — this is the thought-dropdown bug.
    const reg = buildProviderRegistry();
    const p = providerById(reg, "custom-openai-kind");
    const model = (p?.models as Array<Record<string, unknown>>)[0];
    expect(model.reasoning).toEqual({
      enabled: true,
      levels: [
        { value: "high", label: "high" },
        { value: "max", label: "max" },
      ],
      defaultLevel: "max",
    });
  });

  it("omits reasoning for models without one (plain models stay plain)", () => {
    const reg = buildProviderRegistry();
    const p = providerById(reg, "builtin:primary");
    expect(p?.models).toEqual([{ modelId: "model-a", contextWindow: 128000 }]);
  });

  it("serialises models as an array of {modelId}, NOT the config.json object form", () => {
    const reg = buildProviderRegistry();
    const p = providerById(reg, "custom-openai-kind");
    expect(Array.isArray(p?.models)).toBe(true);
    // The object form ({modelId: {...}}) is rejected by the backend's strict schema.
    expect(p?.models).not.toEqual({ "custom-model-1": expect.anything() });
  });

  it("produces a stable revision for the same input", () => {
    const a = buildProviderRegistry();
    const b = buildProviderRegistry();
    expect(a.revision).toBe(b.revision);
    expect(a.revision).toMatch(/^[0-9a-f]+$/);
  });

  it("produces a different revision when providers change", () => {
    const a = buildProviderRegistry();
    const cfg2 = JSON.parse(JSON.stringify(FAKE_CONFIG));
    cfg2.provider["custom-openai-kind"].kind = "anthropic";
    vi.doMock("node:fs", () => ({
      readFileSync: () => JSON.stringify(cfg2),
    }));
    // vi.doMock takes effect on next dynamic import; reset and reimport.
    vi.resetModules();
    return import("../src/config/provider-registry.js").then((m2) => {
      const b = (
        m2 as { buildProviderRegistry: typeof buildProviderRegistry }
      ).buildProviderRegistry();
      expect(b.revision).not.toBe(a.revision);
    });
  });

  it("emits a generatedAt timestamp", () => {
    const reg = buildProviderRegistry();
    expect(typeof reg.generatedAt).toBe("number");
    expect(reg.generatedAt).toBeGreaterThan(0);
  });
});
