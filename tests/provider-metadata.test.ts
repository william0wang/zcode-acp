/**
 * Provider metadata over ACP (`_meta.zcode`, #400).
 *
 * ACP clients asked for the provider list the bridge's own dropdown builder
 * sees — `{id, name, selectable}` plus the resolved provider — so they stop
 * mirroring `providerSelectable` and the config scan in their own code
 * (the Rust mirror in #400's report was the duplication pain).
 *
 * Covered: the unselectable-reason taxonomy, the metadata list derived from
 * the SAME loadAllModels() output the dropdown offers (never disagreeing,
 * including the ZCODE_PROVIDER pin and personal-only providers), the
 * `_meta.zcode` attachment on the model configOption (refresh vehicle) and on
 * the session/new response (boot snapshot), and the inbound model-value
 * spellings `parseModelValue` accepts (documented in docs/CONFIG-OPTIONS.md).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH, zcodePersonalProviderPath } from "../src/utils.js";

let fakeConfig: unknown = null;
let fakePersonal: unknown = null;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string, ...rest: unknown[]) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(fakeConfig);
      if (p === zcodePersonalProviderPath() && fakePersonal !== null) {
        return JSON.stringify(fakePersonal);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readFileSync as any)(p, ...rest);
    },
  };
});

vi.mock("../src/config/initial-model-catalog.js", () => ({
  probeInitialModelCatalog: async () => null,
}));

vi.mock("../src/tasks-index.js", () => ({
  reviveTombstonesOnActivity: async () => 0,
  upsertSessionTask: async () => true,
}));

const {
  buildConfigOptions,
  buildProviderMeta,
  loadAllModels,
  parseModelValue,
  providerMetadataList,
  providerSelectable,
  providerUnselectableReason,
} = await import("../src/config/options.js");
const { newSession } = await import("../src/handlers/session.js");
const { ZcodeAcpServer } = await import("../src/server.js");

function selectableBuiltin(name: string, models: Record<string, unknown> = {}) {
  return {
    name,
    kind: "anthropic",
    enabled: true,
    options: {
      apiKey: "plan-token",
      apiKeyRequired: true,
      baseURL: "https://api.z.ai/api/anthropic",
    },
    models,
  };
}

afterEach(() => {
  fakeConfig = null;
  fakePersonal = null;
  vi.unstubAllEnvs();
});

describe("providerUnselectableReason", () => {
  it("classifies builtin providers", () => {
    expect(
      providerUnselectableReason("builtin:zai-coding-plan", selectableBuiltin("Z.ai")),
    ).toBeNull();
    expect(
      providerUnselectableReason("builtin:zai-coding-plan", selectableBuiltin("Z.ai")),
    ).toBeNull();
    // enabled but keyless — API-key mode picked, no key entered (#156)
    expect(
      providerUnselectableReason("builtin:zai-start-plan", {
        ...selectableBuiltin("Z.ai - Start"),
        options: { apiKey: "", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
      }),
    ).toBe("keyless-builtin");
    expect(providerUnselectableReason("builtin:zai-coding-plan", { enabled: false })).toBe(
      "disabled",
    );
    // enabled:undefined is NOT === true — the desktop writes explicit booleans
    expect(
      providerUnselectableReason("builtin:zai-coding-plan", { options: { apiKey: "k" } }),
    ).toBe("disabled");
  });

  it("classifies custom providers", () => {
    expect(
      providerUnselectableReason("custom:relay", { enabled: true, options: { apiKey: "k" } }),
    ).toBeNull();
    expect(
      providerUnselectableReason("custom:local", {
        enabled: true,
        options: { baseURL: "http://localhost:11434/v1" },
      }),
    ).toBeNull();
    expect(
      providerUnselectableReason("custom:open", {
        enabled: true,
        options: { apiKeyRequired: false },
      }),
    ).toBeNull();
    // keyless remote endpoint — cannot authenticate
    expect(
      providerUnselectableReason("custom:relay", {
        enabled: true,
        options: { baseURL: "https://relay.example/v1" },
      }),
    ).toBe("non-local-keyless");
    expect(providerUnselectableReason("custom:relay", { enabled: false })).toBe("disabled");
    expect(providerUnselectableReason("custom:relay", undefined)).toBe("disabled");
  });

  it("keeps providerSelectable consistent with the reason", () => {
    const cases: Array<Parameters<typeof providerUnselectableReason>> = [
      ["builtin:zai-coding-plan", selectableBuiltin("Z.ai")],
      ["builtin:zai-start-plan", { enabled: true }],
      ["custom:relay", { enabled: true }],
      ["custom:relay", { enabled: true, options: { baseURL: "http://127.0.0.1:8080/v1" } }],
    ];
    for (const [pid, entry] of cases) {
      expect(providerSelectable(pid, entry)).toBe(providerUnselectableReason(pid, entry) === null);
    }
  });
});

describe("providerMetadataList", () => {
  function mixedConfig(): unknown {
    return {
      provider: {
        "builtin:zai-coding-plan": selectableBuiltin("Z.ai - Coding Plan", {
          "GLM-5.3": { limit: { context: 200000 } },
          "GLM-5.3-Flash": { limit: { context: 200000 } },
        }),
        // keyless builtin — the #400 reporter's Start Plan case: present in
        // config, skipped by the dropdown, but visible WITH a reason now.
        "builtin:zai-start-plan": {
          name: "Z.ai - Start Plan",
          kind: "anthropic",
          enabled: true,
          options: { apiKey: "", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
          models: { "GLM-5.2": {} },
        },
        // keyless remote custom — same treatment
        "custom:relay": {
          name: "Relay",
          enabled: true,
          options: { baseURL: "https://relay.example/v1" },
          models: { "gpt-x": {} },
        },
      },
    };
  }

  it("derives selectable providers from the dropdown's own output, then unselectable entries with reasons", () => {
    fakeConfig = mixedConfig();
    const meta = providerMetadataList();
    expect(meta).toEqual([
      {
        id: "builtin:zai-coding-plan",
        name: "Z.ai - Coding Plan",
        selectable: true,
        defaultModel: "GLM-5.3",
      },
      {
        id: "builtin:zai-start-plan",
        name: "Z.ai - Start Plan",
        selectable: false,
        unselectableReason: "keyless-builtin",
      },
      {
        id: "custom:relay",
        name: "Relay",
        selectable: false,
        unselectableReason: "non-local-keyless",
      },
    ]);
    // Never disagrees with the dropdown: every selectable entry's id leads
    // loadAllModels, and no unselectable id appears there.
    const offered = new Set(loadAllModels().map((m) => m.providerId));
    for (const entry of meta) {
      expect(offered.has(entry.id)).toBe(entry.selectable);
    }
  });

  it("includes personal-only providers (provider_config.json) as selectable", () => {
    fakeConfig = { provider: {} };
    fakePersonal = {
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "custom:ollama",
              providerName: "Ollama",
              enabled: true,
              config: { api: { baseUrl: "http://localhost:11434/v1" } },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [{ providerId: "custom:ollama", modelId: "llama-local" }],
        },
      },
    };
    expect(providerMetadataList()).toEqual([
      { id: "custom:ollama", name: "Ollama", selectable: true, defaultModel: "llama-local" },
    ]);
  });

  it("overlays the personal rule before judging a config.json provider (3.12+ toggle)", () => {
    fakeConfig = {
      provider: {
        "custom:relay": {
          name: "Relay",
          enabled: true,
          options: { apiKey: "old" },
          models: { "gpt-x": {} },
        },
      },
    };
    // The desktop disabled it — the rule wins over the stale config.json flag.
    fakePersonal = {
      config: {
        providerConfigRules: { providerRules: [{ providerId: "custom:relay", enabled: false }] },
        modelConfigRules: {},
      },
    };
    expect(providerMetadataList()).toEqual([
      { id: "custom:relay", name: "Relay", selectable: false, unselectableReason: "disabled" },
    ]);
  });

  it("filters to the ZCODE_PROVIDER pin like the dropdown does", () => {
    fakeConfig = mixedConfig();
    vi.stubEnv("ZCODE_PROVIDER", "custom:relay");
    expect(providerMetadataList()).toEqual([
      {
        id: "custom:relay",
        name: "Relay",
        selectable: false,
        unselectableReason: "non-local-keyless",
      },
    ]);
  });
});

describe("_meta.zcode attachment", () => {
  it("rides the model configOption with the current provider in the config dialect", async () => {
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": selectableBuiltin("Z.ai - Coding Plan", {
          "GLM-5.3": { limit: { context: 200000 } },
        }),
      },
    };
    const options = await buildConfigOptions(new ZcodeAcpServer(), null);
    const model = options.find((option) => option.id === "model");
    const meta = model?._meta?.["zcode"] as { providers: unknown[]; currentProviderId: string };
    expect(meta.currentProviderId).toBe("builtin:zai-coding-plan");
    expect(meta.providers[0]).toMatchObject({ id: "builtin:zai-coding-plan", selectable: true });
    // The mode/thought options stay spec-clean — no _meta of their own.
    expect(options.find((option) => option.id === "mode")?._meta).toBeUndefined();
  });

  it("folds a registry account: identity onto the config dialect", () => {
    fakeConfig = { provider: {} };
    // No builtin table needed — configProviderIdFor's table-absent regex folds
    // the well-known plan spellings.
    const meta = buildProviderMeta("account:bigmodel-individual-coding-plan");
    expect(meta.currentProviderId).toBe("builtin:bigmodel-coding-plan");
  });

  it("mirrors the model option's _meta on the session/new response", async () => {
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": selectableBuiltin("Z.ai - Coding Plan", {
          "GLM-5.3": { limit: { context: 200000 } },
        }),
      },
    };
    const resp = await newSession(new ZcodeAcpServer(), { cwd: "/tmp/ws" } as never);
    const model = resp.configOptions?.find((option) => option.id === "model");
    expect(resp._meta?.["zcode"]).toEqual(model?._meta?.["zcode"]);
    expect(resp._meta?.["zcode"]).toMatchObject({
      currentProviderId: "builtin:zai-coding-plan",
    });
  });
});

describe("model value spellings (docs/CONFIG-OPTIONS.md)", () => {
  it("accepts the canonical providerId\\modelId form", () => {
    expect(parseModelValue("custom:relay\\gpt-x")).toEqual({
      providerId: "custom:relay",
      modelId: "gpt-x",
    });
  });

  it("accepts the legacy bare modelId (first enabled builtin resolves it)", () => {
    fakeConfig = {
      provider: {
        "builtin:zai-coding-plan": selectableBuiltin("Z.ai", { "GLM-5.3": {} }),
      },
    };
    expect(parseModelValue("GLM-5.3")).toEqual({
      providerId: "builtin:zai-coding-plan",
      modelId: "GLM-5.3",
    });
  });

  it("accepts the 3.12+ agent-definition custom:<urlencoded> form", () => {
    expect(parseModelValue("custom:account%3Abigmodel-individual-coding-plan:GLM-5.3")).toEqual({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3",
    });
  });
});
