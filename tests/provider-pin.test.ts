/**
 * ZCODE_PROVIDER pins which provider in config.json the bridge uses.
 *
 * Without it the historical rule holds: credentials come from the FIRST
 * enabled provider and the model dropdown lists every selectable one. With
 * it, both are restricted to the pinned provider id.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

function plan(name: string, baseURL: string, apiKey: string, modelId: string) {
  return {
    name,
    kind: "anthropic",
    enabled: true,
    options: { apiKey, apiKeyRequired: true, baseURL },
    models: { [modelId]: { limit: { context: 200000 } } },
  };
}

function twoEnabledProviders() {
  return {
    provider: {
      "builtin:first": plan("First", "https://first.example/api", "first-key", "GLM-first"),
      "builtin:second": plan("Second", "https://second.example/api", "second-key", "GLM-second"),
    },
  };
}

let fakeConfig: unknown = twoEnabledProviders();

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

const { loadZcodeCredentials, mergeEnvWithCreds } = await import(
  "../src/backend/credentials.js"
);
const { loadAllModels } = await import("../src/config/options.js");

afterEach(() => {
  fakeConfig = twoEnabledProviders();
  vi.unstubAllEnvs();
});

describe("loadZcodeCredentials provider pinning", () => {
  it("falls back to the first enabled provider when ZCODE_PROVIDER is unset", () => {
    expect(loadZcodeCredentials()).toEqual({
      ZCODE_MODEL: "GLM-first",
      providerBaseURL: "https://first.example/api",
      ANTHROPIC_API_KEY: "first-key",
    });
  });

  it("picks the pinned provider even when it is not first", () => {
    vi.stubEnv("ZCODE_PROVIDER", "builtin:second");

    expect(loadZcodeCredentials()).toEqual({
      ZCODE_MODEL: "GLM-second",
      providerBaseURL: "https://second.example/api",
      ANTHROPIC_API_KEY: "second-key",
    });
  });

  it("returns nothing when the pinned provider is absent or disabled", () => {
    vi.stubEnv("ZCODE_PROVIDER", "builtin:missing");

    expect(loadZcodeCredentials()).toEqual({});
  });

  it("skips enabled providers with an empty apiKey (#183)", () => {
    fakeConfig = {
      provider: {
        // Enabled but keyless — typical state after a plan upgrade.
        "builtin:keyless": plan("Keyless", "https://keyless.example/api", "", "GLM-keyless"),
        "builtin:first": plan("First", "https://first.example/api", "first-key", "GLM-first"),
      },
    };

    expect(loadZcodeCredentials().ANTHROPIC_API_KEY).toBe("first-key");
  });

  it("still picks a custom keyless local provider (ollama/llama.cpp, #156)", () => {
    fakeConfig = {
      provider: {
        "builtin:keyless": plan("Keyless", "https://keyless.example/api", "", "GLM-keyless"),
        "local:ollama": {
          name: "Ollama",
          enabled: true,
          options: { baseURL: "http://localhost:11434/api", apiKey: "" },
          models: { "llama-local": {} },
        },
      },
    };

    const creds = loadZcodeCredentials();
    expect(creds.ANTHROPIC_API_KEY).toBe("");
    expect(creds.providerBaseURL).toBe("http://localhost:11434/api");
  });

  it("honors an explicit pin even when the pinned provider is keyless", () => {
    fakeConfig = {
      provider: {
        "builtin:keyless": plan("Keyless", "https://keyless.example/api", "", "GLM-keyless"),
        "builtin:first": plan("First", "https://first.example/api", "first-key", "GLM-first"),
      },
    };
    vi.stubEnv("ZCODE_PROVIDER", "builtin:keyless");

    expect(loadZcodeCredentials().ANTHROPIC_API_KEY).toBe("");
  });
});

describe("mergeEnvWithCreds keeps ZCODE_BASE_URL out of the child environment", () => {
  // The app-server resolves its service origin (configuration/signing/billing
  // endpoints) as ZCODE_BASE_URL ?? ZCODE_ENDPOINT_ORIGIN ?? built-in default,
  // so a provider model URL in that variable repoints those requests at the
  // provider host. See src/backend/credentials.ts.
  const creds = {
    ZCODE_MODEL: "GLM-first",
    providerBaseURL: "https://first.example/api",
    ANTHROPIC_API_KEY: "first-key",
  };

  it("strips an inherited ZCODE_BASE_URL instead of passing it to the app-server", () => {
    vi.stubEnv("ZCODE_BASE_URL", "https://first.example/api");

    const merged = mergeEnvWithCreds(creds);
    expect(merged.ZCODE_BASE_URL).toBeUndefined();
    expect(merged.ZCODE_MODEL).toBe("GLM-first");
    expect(merged.ANTHROPIC_API_KEY).toBe("first-key");
  });

  it("strips ZCODE_BASE_URL even when ANTHROPIC_API_KEY is explicitly exported", () => {
    vi.stubEnv("ZCODE_BASE_URL", "https://second.example/api");
    vi.stubEnv("ANTHROPIC_API_KEY", "second-key");

    const merged = mergeEnvWithCreds(creds);
    expect(merged.ZCODE_BASE_URL).toBeUndefined();
    expect(merged.ANTHROPIC_API_KEY).toBe("second-key");
  });

  it("still honors explicit ZCODE_MODEL / ANTHROPIC_API_KEY overrides", () => {
    vi.stubEnv("ZCODE_MODEL", "GLM-override");
    vi.stubEnv("ANTHROPIC_API_KEY", "override-key");

    const merged = mergeEnvWithCreds(creds);
    expect(merged.ZCODE_MODEL).toBe("GLM-override");
    expect(merged.ANTHROPIC_API_KEY).toBe("override-key");
  });
});

describe("loadAllModels provider pinning", () => {
  it("lists every enabled provider when ZCODE_PROVIDER is unset", () => {
    expect(loadAllModels().map((m) => m.providerId)).toEqual(["builtin:first", "builtin:second"]);
  });

  it("lists only the pinned provider's models", () => {
    vi.stubEnv("ZCODE_PROVIDER", "builtin:second");

    expect(loadAllModels()).toEqual([
      { providerId: "builtin:second", providerName: "Second", modelId: "GLM-second" },
    ]);
  });
});
