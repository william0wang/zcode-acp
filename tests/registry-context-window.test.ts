/**
 * The registry's context-window answer (`registryContextWindow`) and the
 * gauge ladder built on it (`modelContextWindow`).
 *
 * The backend reports a model's context window only through turn-time usage
 * events, so the bridge resolves it locally: config.json `limit.context`, the
 * personal rule, then — since 2026-11-23 — the provider table's own rule walk.
 * Before that third rung a model that arrives through the table alone
 * (GLM-5.4 at revision 47) had no local window: the mobile models list showed
 * no context suffix and the gauge got a 0 denominator after a model switch,
 * while the desktop app showed 1M.
 *
 * The walk mirrors upstream `ModelConfigRules.resolve`
 * (packages/provider/src/config/model-config.ts): five groups in a fixed
 * order, later rules overlaying earlier ones. The fixture table below is a
 * miniature of the real one's shape — one rule per behavior under test — so
 * nothing here reads the machine's own table.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ config: "", personal: "", table: "" }));
const warn = vi.hoisted(() => vi.fn());

vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...actual,
    get ZCODE_CREDS_PATH() {
      return paths.config;
    },
    warn,
    zcodePersonalProviderPath: () => paths.personal,
  };
});

vi.mock("../src/backend/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  builtinProviderEnv: () => ({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: paths.table }),
}));

const { registryContextWindow, resetRegistryContextWindowForTests } =
  await import("../src/config/registry-context-window.js");
const { modelContextWindow } = await import("../src/config/options.js");

const window = (contextWindow: number) => ({ properties: { contextWindow } });

const BIGMODEL = "account:bigmodel-individual-coding-plan";
const ZAI = "account:zai-individual-coding-plan";

const TABLE = {
  schemaVersion: 1,
  revision: 47,
  config: {
    providerConfigRules: {
      templateRules: [
        {
          templateId: "relay",
          config: { api: { type: "openai-responses", baseUrl: "https://relay.example/v1" } },
        },
      ],
      providerRules: [
        {
          providerId: BIGMODEL,
          config: {
            access: {
              type: "zhipu-account",
              mode: "individual-coding-plan",
              accountType: "bigmodel",
            },
            api: { type: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
            builtinModelIds: ["GLM-5.4", "GLM-5.3"],
          },
        },
        {
          providerId: ZAI,
          config: {
            access: {
              type: "zhipu-account",
              mode: "individual-coding-plan",
              accountType: "zai",
            },
            api: { type: "anthropic-messages", baseUrl: "https://api.z.ai/api/anthropic" },
            builtinModelIds: ["GLM-5.4"],
          },
        },
        // A table provider built from a template: its api TYPE comes from the
        // template, its base URL from its own rule.
        {
          providerId: "table-relay",
          templateId: "relay",
          config: { api: { baseUrl: "https://table-relay.example/v1" } },
        },
      ],
    },
    modelConfigRules: {
      modelRules: [
        { modelMatch: ".*", config: window(1_000_000) },
        { modelMatch: ".*glm-5\\.3.*", config: window(512_000) },
        { modelMatch: ".*glm-4\\.6.*", config: window(131_072) },
        // States another property but no window: keeps whatever came before.
        { modelMatch: ".*mystery.*", config: { properties: { supportsToolCall: false } } },
      ],
      modelApiRules: [
        {
          modelMatch: ".*responses-only.*",
          apiTypeMatch: "openai-responses",
          config: window(256_000),
        },
        // apiTypeMatch is case-SENSITIVE: this rule never fires.
        {
          modelMatch: ".*responses-only.*",
          apiTypeMatch: "OpenAI-Responses",
          config: window(999_999),
        },
      ],
      providerSiteRules: [
        {
          modelMatch: "glm-5\\.4",
          apiTypeMatch: "anthropic-messages",
          baseUrlMatch: "https://open\\.bigmodel\\.cn/api/anthropic/?",
          config: window(1_048_576),
        },
        // Everything served from the relay site has its window reset.
        {
          modelMatch: ".*",
          baseUrlMatch: "https://relay\\.example/v1/?",
          config: { properties: null },
        },
      ],
      templateModelRules: [
        { templateId: "relay", modelId: "relay-only-model", config: window(64_000) },
      ],
      builtinProviderModelRules: [
        // The account models' enablement; states no window.
        { providerId: BIGMODEL, modelId: "GLM-5.4", config: { enabled: true } },
      ],
    },
  },
};

const key = { type: "api-key", apiKey: "k" };
const PERSONAL_PROVIDERS = [
  {
    providerId: "plain",
    providerName: "Plain",
    config: { access: key, api: { type: "openai-responses", baseUrl: "http://127.0.0.1:3425/v1" } },
  },
  // Created from the relay template and stating no api of its own.
  {
    providerId: "from-template",
    providerName: "From template",
    templateId: "relay",
    config: { access: key },
  },
  // No api block at all: the api-type-guarded rules are skipped for it.
  { providerId: "no-api", providerName: "No api", config: { access: key } },
  // Host case and a trailing slash must not matter to the site guard.
  {
    providerId: "shouty",
    providerName: "Shouty",
    config: {
      access: key,
      api: { type: "anthropic-messages", baseUrl: "HTTPS://OPEN.BIGMODEL.CN/api/anthropic/" },
    },
  },
  // A base URL that does not parse: no site rule can apply.
  {
    providerId: "bad-url",
    providerName: "Bad url",
    config: { access: key, api: { type: "anthropic-messages", baseUrl: "http://[" } },
  },
];

function personalConfig(providerRules: unknown[], modelRules: unknown[] = []): unknown {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules },
      modelConfigRules: { providerModelRules: modelRules, manualProviderModelRules: [] },
    },
  };
}

let root: string;

function writeTable(table: unknown = TABLE): void {
  writeFileSync(paths.table, JSON.stringify(table));
}

function writePersonal(doc: unknown): void {
  writeFileSync(paths.personal, JSON.stringify(doc));
}

/** The fixture table with its model-rule groups edited in place. */
function tableWith(edit: (groups: Record<string, unknown>) => void): unknown {
  const groups = { ...TABLE.config.modelConfigRules } as Record<string, unknown>;
  edit(groups);
  return { ...TABLE, config: { ...TABLE.config, modelConfigRules: groups } };
}

beforeEach(() => {
  resetRegistryContextWindowForTests();
  warn.mockClear();
  root = mkdtempSync(path.join(tmpdir(), "registry-context-window-"));
  paths.config = path.join(root, "missing", "config.json");
  paths.personal = path.join(root, "provider_config.json");
  paths.table = path.join(root, "zcode-builtin.json");
  writeTable();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("registryContextWindow: the rule walk", () => {
  it("walks the five groups in upstream order, a later rule winning", () => {
    // model `.*` → the bigmodel provider-site rule (a later group) wins.
    expect(registryContextWindow(BIGMODEL, "GLM-5.4")).toBe(1_048_576);
    // Within one group the later pattern wins too.
    expect(registryContextWindow(BIGMODEL, "GLM-5.3")).toBe(512_000);
    // A rule that states no window keeps the earlier value.
    expect(registryContextWindow(BIGMODEL, "mystery-model")).toBe(1_000_000);
  });

  it("matches the model id anchored and case-insensitively", () => {
    expect(registryContextWindow(BIGMODEL, "glm-5.3")).toBe(512_000);
    // `glm-5\.4` is anchored: it does not reach a longer id (the `.*`
    // baseline still does).
    expect(registryContextWindow(BIGMODEL, "GLM-5.4-preview")).toBe(1_000_000);
  });

  it("applies to a model the provider does not declare", () => {
    // The walk is by rule, not by the provider's model list.
    expect(registryContextWindow(BIGMODEL, "GLM-4.6")).toBe(131_072);
  });

  it("tests apiTypeMatch case-sensitively, and skips guarded rules without an api type", () => {
    writePersonal(personalConfig(PERSONAL_PROVIDERS));
    expect(registryContextWindow("plain", "responses-only-model")).toBe(256_000);
    expect(registryContextWindow("no-api", "responses-only-model")).toBe(1_000_000);
  });

  it("tests baseUrlMatch against the normalized base URL", () => {
    writePersonal(personalConfig(PERSONAL_PROVIDERS));
    // Same model, same api type — another site: the rule does not apply.
    expect(registryContextWindow(ZAI, "GLM-5.4")).toBe(1_000_000);
    // Host case and the trailing slash are normalized away.
    expect(registryContextWindow("shouty", "GLM-5.4")).toBe(1_048_576);
  });

  it("never applies a provider-site rule to a provider without a parseable base URL", () => {
    writePersonal(personalConfig(PERSONAL_PROVIDERS));
    expect(registryContextWindow("bad-url", "GLM-5.4")).toBe(1_000_000);
  });

  it("applies a template-model rule only to a provider created from that template", () => {
    writePersonal(personalConfig(PERSONAL_PROVIDERS));
    expect(registryContextWindow("plain", "relay-only-model")).toBe(1_000_000);
    expect(registryContextWindow("from-template", "relay-only-model")).toBe(64_000);
  });

  it("lays a rule's api block over its template's, leaf by leaf", () => {
    // `table-relay` states only a base URL: its api type is the template's.
    expect(registryContextWindow("table-relay", "responses-only-model")).toBe(256_000);
    expect(registryContextWindow("table-relay", "relay-only-model")).toBe(64_000);
  });

  it("resets the window on a `properties: null` rule", () => {
    writePersonal(personalConfig(PERSONAL_PROVIDERS));
    // The relay site rule resets the baseline and no later rule restores it.
    expect(registryContextWindow("from-template", "other-model")).toBeNull();
  });

  it("answers the same for either provider dialect", () => {
    expect(registryContextWindow("builtin:bigmodel-coding-plan", "GLM-5.4")).toBe(1_048_576);
    expect(registryContextWindow("builtin:zai-coding-plan", "GLM-5.4")).toBe(1_000_000);
  });

  it("notices a provider_config.json written after the first answer", () => {
    expect(registryContextWindow("from-template", "relay-only-model")).toBeNull();
    writePersonal(personalConfig(PERSONAL_PROVIDERS));
    expect(registryContextWindow("from-template", "relay-only-model")).toBe(64_000);
  });
});

describe("registryContextWindow: scope", () => {
  it("answers nothing for a provider the registry does not know", () => {
    // The `.*` baseline matches every model id, but a provider with no rule
    // in the table or the personal config is not in the registry at all —
    // the backend enforces its own number there.
    expect(registryContextWindow("custom:other", "mystery-model")).toBeNull();
    expect(registryContextWindow("builtin:bigmodel", "GLM-5.3")).toBeNull();
    // A coding-plan spelling the installed table lacks is unknown too.
    expect(registryContextWindow("builtin:bigmodel-start-plan", "GLM-5.2")).toBeNull();
  });

  it("answers nothing without a table", () => {
    paths.table = path.join(root, "missing", "zcode-builtin.json");
    expect(registryContextWindow(BIGMODEL, "GLM-5.4")).toBeNull();
  });
});

describe("registryContextWindow: robustness", () => {
  it("a malformed pattern makes the whole table unusable — warned once, never thrown", () => {
    writeTable(
      tableWith((groups) => {
        groups.modelRules = [{ modelMatch: "([unclosed", config: window(1) }];
      }),
    );
    expect(() => registryContextWindow("plain", "plain-model")).not.toThrow();
    expect(registryContextWindow(BIGMODEL, "GLM-5.4")).toBeNull();
    expect(registryContextWindow(BIGMODEL, "GLM-5.3")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("modelMatch is missing or malformed");

    // A valid table in its place is picked up again.
    writeTable();
    expect(registryContextWindow(BIGMODEL, "GLM-5.4")).toBe(1_048_576);
  });

  it("a drifted shape is unusable too", () => {
    const drifted: Array<(groups: Record<string, unknown>) => void> = [
      (groups) => {
        groups.modelRules = "not-a-list";
      },
      (groups) => {
        groups.modelRules = ["not-an-object"];
      },
      (groups) => {
        delete groups.providerSiteRules; // upstream's strict schema wants all five
      },
      (groups) => {
        groups.modelApiRules = [{ modelMatch: ".*", config: window(1) }]; // no apiTypeMatch
      },
      (groups) => {
        groups.modelRules = [{ modelMatch: ".*", config: { properties: { contextWindow: 0 } } }];
      },
    ];
    for (const edit of drifted) {
      writeTable(tableWith(edit));
      expect(() => registryContextWindow(BIGMODEL, "GLM-5.4")).not.toThrow();
      expect(registryContextWindow(BIGMODEL, "GLM-5.4")).toBeNull();
    }
    // A rule that carries no config at all is not drift: it changes nothing.
    writeTable(
      tableWith((groups) => {
        groups.modelRules = [{ modelMatch: ".*" }];
      }),
    );
    expect(registryContextWindow(ZAI, "GLM-5.4")).toBeNull(); // the baseline is gone
    expect(registryContextWindow(BIGMODEL, "GLM-5.4")).toBe(1_048_576); // the site rule stands
  });

  it("compiles the table's patterns once per table identity", () => {
    const constructed = vi.spyOn(globalThis, "RegExp");
    try {
      expect(registryContextWindow(BIGMODEL, "GLM-5.4")).toBe(1_048_576);
      const first = constructed.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      expect(registryContextWindow(ZAI, "GLM-5.4")).toBe(1_000_000);
      expect(registryContextWindow(BIGMODEL, "GLM-5.3")).toBe(512_000);
      expect(constructed.mock.calls.length).toBe(first);
    } finally {
      constructed.mockRestore();
    }
  });
});

describe("modelContextWindow: the ladder", () => {
  it("falls to the registry when neither config.json nor a personal rule states a window", () => {
    expect(modelContextWindow(BIGMODEL, "GLM-5.4")).toBe(1_048_576);
    expect(modelContextWindow("builtin:bigmodel-coding-plan", "GLM-5.4")).toBe(1_048_576);
  });

  it("a personal rule's window wins over the registry walk", () => {
    writePersonal(
      personalConfig(PERSONAL_PROVIDERS, [
        { providerId: BIGMODEL, modelId: "GLM-5.4", config: window(333_000) },
        // No window of its own: the registry's answer stands in.
        { providerId: BIGMODEL, modelId: "GLM-5.3", config: { enabled: true } },
      ]),
    );
    expect(modelContextWindow(BIGMODEL, "GLM-5.4")).toBe(333_000);
    expect(modelContextWindow(BIGMODEL, "GLM-5.3")).toBe(512_000);
  });

  it("a config.json limit wins over both", () => {
    writePersonal(
      personalConfig(PERSONAL_PROVIDERS, [
        { providerId: BIGMODEL, modelId: "GLM-5.4", config: window(333_000) },
      ]),
    );
    paths.config = path.join(root, "config.json");
    writeFileSync(
      paths.config,
      JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": {
            name: "BigModel",
            kind: "anthropic",
            enabled: true,
            options: { apiKey: "k" },
            models: { "GLM-5.4": { limit: { context: 111_000 } } },
          },
        },
      }),
    );
    expect(modelContextWindow(BIGMODEL, "GLM-5.4")).toBe(111_000);
  });

  it("still knows no window for a provider the registry does not know", () => {
    expect(modelContextWindow("custom:other", "mystery-model")).toBe(0);
  });
});
