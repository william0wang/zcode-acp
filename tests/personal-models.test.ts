/**
 * provider_config.json merge into the model dropdown.
 *
 * The desktop app (3.12+) writes user-added providers/models to its personal
 * provider_config.json and has stopped syncing legacy config.json — a dropdown
 * built from config.json alone never showed them (observed 2026-09: a model
 * added in the app was invisible in the editor). For CUSTOM providers the
 * personal model list is authoritative (replaces, not unions): deletions also
 * land only there, so a config.json-only entry is a deleted-model ghost
 * (observed 2026-09-28). config.json stays authoritative for
 * enablement/credentials and for builtin providers' catalogs, where a personal
 * rule is an override rather than a complete list.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH, zcodePersonalProviderPath } from "../src/utils.js";

const FAKE_CONFIG = {
  provider: {
    "builtin:bigmodel-coding-plan": {
      name: "BigModel",
      kind: "anthropic",
      enabled: true,
      options: { apiKey: "k-bigmodel" },
      models: { "GLM-5.3": { limit: { context: 200000 } } },
    },
    "uuid-provider": {
      name: "OcGo",
      kind: "openai-compatible",
      options: { apiKey: "k-ocgo" },
      models: {
        "deepseek-v4.1-flash": { limit: { context: 128000 } },
        "gemini-3.8-flash": { limit: { context: 1000000 } },
      },
    },
  },
};

const FAKE_PERSONAL = {
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "uuid-provider",
          providerName: "OcGo",
          enabled: true,
          config: {
            access: { type: "api-key", apiKey: "k-ocgo-personal" },
            api: { type: "openai-responses", baseUrl: "http://localhost:18586/openai/v1" },
          },
        },
        {
          providerId: "uuid-brand-new",
          providerName: "Fresh",
          enabled: true,
          config: {
            access: { type: "api-key", apiKey: "k-fresh" },
            api: { type: "openai-chat-completions", baseUrl: "http://localhost:9/v1" },
          },
        },
        {
          providerId: "uuid-disabled",
          providerName: "DisabledP",
          enabled: false,
          config: {
            access: { type: "api-key", apiKey: "k-disabled" },
            api: { type: "openai-chat-completions", baseUrl: "http://localhost:10/v1" },
          },
        },
        {
          providerId: "uuid-keyless-remote",
          providerName: "KeylessRemote",
          enabled: true,
          config: {
            api: { type: "openai-chat-completions", baseUrl: "https://api.example.test/v1" },
          },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        {
          providerId: "uuid-provider",
          modelId: "step-5-preview",
          config: {
            enabled: true,
            properties: { contextWindow: 500000 },
            optionSpecs: { reasoningLevel: { values: ["high", "max"] } },
          },
        },
        {
          providerId: "uuid-provider",
          modelId: "hidden-model",
          config: { enabled: false, properties: { contextWindow: 1000 } },
        },
        {
          providerId: "uuid-brand-new",
          modelId: "fresh-1",
          config: { enabled: true, properties: { contextWindow: 64000 } },
        },
        { providerId: "uuid-disabled", modelId: "dis-1", config: { enabled: true } },
        {
          // Registry spelling — must merge onto config.json's builtin: entry.
          providerId: "account:bigmodel-individual-coding-plan",
          modelId: "GLM-5.3-Flash",
          config: { enabled: true, properties: { contextWindow: 131072 } },
        },
      ],
      manualProviderModelRules: [],
    },
  },
};

/** Swapped by tests that need a missing personal config. */
let fakePersonal: unknown = FAKE_PERSONAL;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(FAKE_CONFIG);
      if (p === zcodePersonalProviderPath()) {
        if (fakePersonal === null) return actual.readFileSync(p);
        return JSON.stringify(fakePersonal);
      }
      return actual.readFileSync(p);
    },
  };
});

// Import AFTER vi.mock is set up.
const { loadAllModels, modelContextWindow, personalModelSpec } =
  await import("../src/config/options.js");

beforeEach(() => {
  fakePersonal = FAKE_PERSONAL;
});

describe("loadAllModels with provider_config.json", () => {
  it("treats the personal model list as authoritative for custom providers", () => {
    const models = loadAllModels();
    expect(models).toContainEqual({
      providerId: "uuid-provider",
      providerName: "OcGo",
      modelId: "step-5-preview",
    });
    // Models that survive only in legacy config.json were deleted in the
    // desktop app (deletions write provider_config.json only) — they must not
    // come back through the merge, and the registry would reject them anyway.
    const uuidModels = models.filter((m) => m.providerId === "uuid-provider").map((m) => m.modelId);
    expect(uuidModels).toEqual(["step-5-preview"]);
  });

  it("keeps the union for builtin providers (personal rules are overrides)", () => {
    const models = loadAllModels();
    // GLM-5.3 lives only in config.json while the personal account: rule adds
    // GLM-5.3-Flash — both stay: the builtin catalog is not tracked by the
    // personal model list.
    expect(models).toContainEqual({
      providerId: "builtin:bigmodel-coding-plan",
      providerName: "BigModel",
      modelId: "GLM-5.3",
    });
    expect(models).toContainEqual({
      providerId: "builtin:bigmodel-coding-plan",
      providerName: "BigModel",
      modelId: "GLM-5.3-Flash",
    });
  });

  it("keeps personal model rules with enabled:false hidden", () => {
    expect(loadAllModels().map((m) => m.modelId)).not.toContain("hidden-model");
  });

  it("advertises a provider only the personal config describes", () => {
    expect(loadAllModels()).toContainEqual({
      providerId: "uuid-brand-new",
      providerName: "Fresh",
      modelId: "fresh-1",
    });
  });

  it("keeps desktop-disabled and keyless-remote personal providers out (#156)", () => {
    const pids = loadAllModels().map((m) => m.providerId);
    expect(pids).not.toContain("uuid-disabled");
    expect(pids).not.toContain("uuid-keyless-remote");
  });

  it("excludes a custom provider present in legacy config.json when provider_config.json disables it", () => {
    fakePersonal = {
      ...FAKE_PERSONAL,
      config: {
        ...FAKE_PERSONAL.config,
        providerConfigRules: {
          providerRules: [
            {
              providerId: "uuid-provider",
              providerName: "OcGo",
              enabled: false,
              config: {
                access: { type: "api-key", apiKey: "k-ocgo-personal" },
                api: { type: "openai-responses", baseUrl: "http://localhost:18586/openai/v1" },
              },
            },
          ],
        },
      },
    };
    const pids = loadAllModels().map((m) => m.providerId);
    expect(pids).not.toContain("uuid-provider");
  });

  it("normalizes account: spelling onto the builtin config.json provider", () => {
    const models = loadAllModels();
    expect(models).toContainEqual({
      providerId: "builtin:bigmodel-coding-plan",
      providerName: "BigModel",
      modelId: "GLM-5.3-Flash",
    });
    // The raw registry spelling must not leak in as its own provider.
    expect(models.map((m) => m.providerId)).not.toContain(
      "account:bigmodel-individual-coding-plan",
    );
  });

  it("leaves the dropdown config.json-only when the personal config is absent", () => {
    fakePersonal = null;
    const models = loadAllModels();
    expect(models.map((m) => m.modelId)).not.toContain("step-5-preview");
    expect(models.map((m) => m.modelId)).toContain("deepseek-v4.1-flash");
  });
});

describe("modelContextWindow with the personal fallback", () => {
  it("prefers config.json's declaration when both exist", () => {
    expect(modelContextWindow("uuid-provider", "deepseek-v4.1-flash")).toBe(128000);
  });

  it("falls back to the personal rule's contextWindow", () => {
    expect(modelContextWindow("uuid-provider", "step-5-preview")).toBe(500000);
  });

  it("resolves through the account: spelling", () => {
    expect(modelContextWindow("account:bigmodel-individual-coding-plan", "GLM-5.3-Flash")).toBe(
      131072,
    );
  });
});

describe("personalModelSpec", () => {
  it("exposes the reasoning vocabulary for level resolution", () => {
    expect(personalModelSpec("uuid-provider", "step-5-preview")?.reasoningValues).toEqual([
      "high",
      "max",
    ]);
  });

  it("returns null for models the personal config does not declare", () => {
    expect(personalModelSpec("uuid-provider", "deepseek-v4.1-flash")).toBeNull();
    expect(personalModelSpec("uuid-provider", "no-such-model")).toBeNull();
  });
});
