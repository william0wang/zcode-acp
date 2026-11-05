/**
 * account-provider tests — the `provider/updateAccountConfig` push that
 * restores desktop parity for coding-plan (GLM) models on 3.12+ backends.
 *
 * Background: 3.12+ app-servers build their provider registry from the bundled
 * `zcode-builtin.json` table, the personal `provider_config.json`, and an
 * ACCOUNT snapshot the desktop host pushes. Headless launches have no host, so
 * every `account:*` provider stays entitled:false and the GLM models the
 * user's config selects never appear in `settings.model.available`
 * (verified 2026-09: switch failed with "Provider Registry 中不存在 Model").
 *
 * The revision the runtime verifies against hashes the provider-table PATH, not
 * its bytes (`zcode-builtin:<revision>:<sha256(path)>`) — a mismatch makes the
 * backend accept the push but silently ignore it, so that invariant is locked
 * here too.
 *
 * All fixtures are hermetic temp files; nothing touches the real ~/.zcode.
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RequestError } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCredentialSecret } from "../src/backend/credential-store.js";

const { zcodeCfgPath, zcodeStorePath, dataRoot } = vi.hoisted(() => {
  // utils.js computes ZCODE_CREDS_PATH at import time, so the fixture dir is
  // created in the hoisted block and the env-less path is patched via the
  // module mock below.
  return {
    zcodeCfgPath: { value: "" },
    zcodeStorePath: { value: "" },
    dataRoot: { value: "" },
  };
});

vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...actual,
    get ZCODE_CREDS_PATH() {
      return zcodeCfgPath.value;
    },
    zcodeCredentialsPath: () => zcodeStorePath.value,
    zcodePersonalProviderPath: () => path.join(dataRoot.value, "provider_config.json"),
  };
});

const { builtinProviderEnv } = vi.hoisted(() => ({ builtinProviderEnv: vi.fn() }));
vi.mock("../src/backend/resolve.js", () => ({
  builtinProviderEnv,
  BUILTIN_PROVIDER_ENV: "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
}));

import {
  accountProviderIdFor,
  buildAccountProviderConfig,
  codingPlanRequestAuthFor,
  configProviderIdFor,
  entitledCodingPlanModels,
  oauthProjectTokenFamilyFor,
  readBuiltinTable,
  zcodeCredentialsPresent,
} from "../src/config/account-provider.js";
import { saveBridgeAccount } from "../src/config/bridge-accounts.js";
import { loadAllModels } from "../src/config/options.js";
import { authenticate } from "../src/handlers/authenticate.js";
import { messages } from "../src/i18n.js";

/** Minimal bundled table with two coding-plan providers (one zai, one bigmodel). */
const TABLE = {
  schemaVersion: 1,
  revision: 28,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "account:zai-individual-coding-plan",
          config: {
            access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "zai" },
            builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"],
          },
        },
        {
          providerId: "account:bigmodel-individual-coding-plan",
          config: {
            access: {
              type: "zhipu-account",
              mode: "individual-coding-plan",
              accountType: "bigmodel",
            },
            builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"],
          },
        },
        {
          providerId: "account:bigmodel-team-coding-plan",
          config: {
            access: { type: "zhipu-account", mode: "team-coding-plan", accountType: "bigmodel" },
            builtinModelIds: ["GLM-5.3"],
          },
        },
      ],
    },
  },
};

let root: string;
let tablePath: string;

/** Write provider_config.json's provider rules into the fixture v2 dir. */
function writePersonalRules(rules: unknown[]): void {
  writeFileSync(
    path.join(dataRoot.value, "provider_config.json"),
    JSON.stringify({ config: { providerConfigRules: { providerRules: rules } } }),
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "acct-provider-"));
  const v2 = path.join(root, ".zcode", "v2");
  mkdirSync(v2, { recursive: true });
  zcodeCfgPath.value = path.join(v2, "config.json");
  zcodeStorePath.value = path.join(v2, "credentials.json");
  dataRoot.value = v2;
  tablePath = path.join(root, "config", "provider", "zcode-builtin.json");
  mkdirSync(path.dirname(tablePath), { recursive: true });
  writeFileSync(tablePath, JSON.stringify(TABLE));
  builtinProviderEnv.mockReturnValue({
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: tablePath,
  });
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = tablePath;
});

afterEach(() => {
  delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("provider id mapping", () => {
  it("maps config.json's <family>-coding-plan to the registry's individual-plan id", () => {
    expect(accountProviderIdFor("builtin:bigmodel-coding-plan")).toBe(
      "account:bigmodel-individual-coding-plan",
    );
    expect(accountProviderIdFor("builtin:zai-coding-plan")).toBe(
      "account:zai-individual-coding-plan",
    );
  });

  it("round-trips back to the config.json spelling", () => {
    expect(configProviderIdFor("account:bigmodel-individual-coding-plan")).toBe(
      "builtin:bigmodel-coding-plan",
    );
  });

  it("falls back to the id convention when the bundled table is absent (headless Linux)", () => {
    // Point the resolver at a path that does not exist — a Linux runner (or
    // any machine without the desktop app bundle) has no table to read.
    const missing = path.join(root, "config", "provider", "missing.json");
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = missing;
    builtinProviderEnv.mockReturnValue({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: missing });
    expect(configProviderIdFor("account:bigmodel-individual-coding-plan")).toBe(
      "builtin:bigmodel-coding-plan",
    );
    expect(configProviderIdFor("account:zai-team-coding-plan")).toBe("builtin:zai-coding-plan");
    // start-plan keeps its own legacy spelling (frozen upstream, migration
    // 0020: builtin:<f>-start-plan ↔ account:<f>-start-plan).
    expect(configProviderIdFor("account:zai-start-plan")).toBe("builtin:zai-start-plan");
    // Unknown account shapes still pass through unchanged.
    expect(configProviderIdFor("account:mystery-plan")).toBe("account:mystery-plan");
    // off-peak has no legacy builtin spelling — pass through, never invent one.
    expect(configProviderIdFor("account:zai-offpeak-idle-plan")).toBe(
      "account:zai-offpeak-idle-plan",
    );
  });

  it("passes unknown / third-party ids through unchanged", () => {
    expect(accountProviderIdFor("3acc4047-9ddf-43bd-9ed3-a7745f5022ad")).toBe(
      "3acc4047-9ddf-43bd-9ed3-a7745f5022ad",
    );
    expect(configProviderIdFor("3acc4047-9ddf-43bd-9ed3-a7745f5022ad")).toBe(
      "3acc4047-9ddf-43bd-9ed3-a7745f5022ad",
    );
  });
});

describe("readBuiltinTable memo", () => {
  it("re-parses a same-size rewrite or replacement that keeps the mtime", () => {
    const at = 1_700_000_000;
    const write = (file: string, revision: number) => {
      writeFileSync(file, JSON.stringify({ ...TABLE, revision }));
      utimesSync(file, at, at);
    };
    write(tablePath, 10);
    expect(readBuiltinTable()?.table.revision).toBe(10);
    write(tablePath, 11);
    expect(readBuiltinTable()?.table.revision).toBe(11);
    write(tablePath + ".new", 12);
    renameSync(tablePath + ".new", tablePath);
    expect(readBuiltinTable()?.table.revision).toBe(12);
  });
});

describe("buildAccountProviderConfig", () => {
  it("entitles only the plans the desktop availability cache marks available", () => {
    writeFileSync(
      path.join(root, ".zcode", "v2", "coding-plan-cache.json"),
      JSON.stringify({
        entryStatus: {
          items: {
            "builtin:bigmodel-coding-plan": { status: "available" },
            "builtin:zai-coding-plan": {
              status: "unavailable",
              reason: "coding_plan_not_entitled",
            },
          },
        },
      }),
    );
    const payload = buildAccountProviderConfig();
    expect(payload).not.toBeNull();
    expect(payload!.providers["account:bigmodel-individual-coding-plan"]).toMatchObject({
      access: { type: "zhipu-account", entitled: true },
      builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"],
    });
    expect(payload!.providers["account:zai-individual-coding-plan"]).toMatchObject({
      access: { entitled: false },
    });
    expect(payload!.states["account:bigmodel-individual-coding-plan"]).toMatchObject({
      availability: "available",
      entitled: true,
    });
  });

  it("bases the revision on the provider-table PATH (sha256 of the path, not the bytes)", () => {
    const payload = buildAccountProviderConfig();
    const expected = `zcode-builtin:28:${createHash("sha256")
      .update(path.resolve(tablePath))
      .digest("hex")}`;
    expect(payload!.basedOnZCodeBuiltinRevision).toBe(expected);
  });

  it("prefers the derived injection path over an inherited ambient value", () => {
    // The ambient var points at a version-keyed runtime copy; hashing THAT path
    // would produce a revision the backend rejects (verified 2026-09).
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = path.join(
      root,
      "runtime",
      "provider",
      "3.12.3",
      "endpoint-x",
      "zcode-builtin.json",
    );
    // builtinProviderEnv() (the derived value) still wins.
    const payload = buildAccountProviderConfig();
    const expected = `zcode-builtin:28:${createHash("sha256")
      .update(path.resolve(tablePath))
      .digest("hex")}`;
    expect(payload!.basedOnZCodeBuiltinRevision).toBe(expected);
  });

  it("falls back to config.json enablement when the availability cache is absent", () => {
    writeFileSync(
      zcodeCfgPath.value,
      JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": {
            enabled: true,
            options: { apiKey: "k" },
            models: { "GLM-5.3": {} },
          },
        },
      }),
    );
    const payload = buildAccountProviderConfig();
    expect(payload!.providers["account:bigmodel-individual-coding-plan"]!.access.entitled).toBe(
      true,
    );
    expect(payload!.providers["account:zai-individual-coding-plan"]!.access.entitled).toBe(false);
  });

  it("returns null when the table declares no account (zhipu) providers", () => {
    writeFileSync(
      tablePath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 28,
        config: {
          providerConfigRules: {
            providerRules: [
              { providerId: "builtin:zapi", config: { access: { type: "api-key" } } },
            ],
          },
        },
      }),
    );
    expect(buildAccountProviderConfig()).toBeNull();
  });
});

/** Encrypt a value the way ZCode's credential store does (enc:v1: wire form). */
function encryptCredential(plain: string): string {
  const key = createHash("sha256").update(resolveCredentialSecret()).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const cipherText = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher
    .getAuthTag()
    .toString("base64url")}.${cipherText.toString("base64url")}`;
}

/** Seed the encrypted credential store (issue #320's fresh desktop-only layout). */
function writeCredentialStore(entries: Record<string, string>): void {
  const encrypted = Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [key, encryptCredential(value)]),
  );
  writeFileSync(zcodeStorePath.value, JSON.stringify(encrypted));
}

describe("fresh desktop-only layout — encrypted store entitlement (#320)", () => {
  const INDIVIDUAL_KEY =
    "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:108:api-key";
  const TEAM_KEY =
    "account-provider:coding-plan:account:bigmodel-team-coding-plan:account:108:api-key";

  it("entitles the individual plan from the stored api-key when cache and config.json are absent", () => {
    writeCredentialStore({
      [INDIVIDUAL_KEY]: "stored-individual-key",
      [TEAM_KEY]: "stored-team-key",
    });
    const payload = buildAccountProviderConfig();
    expect(payload!.providers["account:bigmodel-individual-coding-plan"]!.access.entitled).toBe(
      true,
    );
    // Key presence is not entitlement: the desktop keeps a team key even when
    // the plan is not held (observed 2026-10 against a real store).
    expect(payload!.providers["account:bigmodel-team-coding-plan"]!.access.entitled).toBe(false);
    expect(payload!.providers["account:zai-individual-coding-plan"]!.access.entitled).toBe(false);
  });

  it("never lets the store override an explicit desktop verdict", () => {
    writeCredentialStore({ [INDIVIDUAL_KEY]: "stored-individual-key" });
    writeFileSync(
      path.join(root, ".zcode", "v2", "coding-plan-cache.json"),
      JSON.stringify({
        entryStatus: {
          items: { "builtin:bigmodel-coding-plan": { status: "unavailable" } },
        },
      }),
    );
    expect(
      buildAccountProviderConfig()!.providers["account:bigmodel-individual-coding-plan"]!.access
        .entitled,
    ).toBe(false);
  });

  it("never lets the store override config.json's builtin enablement signal", () => {
    writeCredentialStore({ [INDIVIDUAL_KEY]: "stored-individual-key" });
    // A builtin entry that is present but disabled is still a verdict-bearing
    // signal — the store must not resurrect it.
    writeFileSync(
      zcodeCfgPath.value,
      JSON.stringify({
        provider: { "builtin:bigmodel-coding-plan": { enabled: false } },
      }),
    );
    expect(
      buildAccountProviderConfig()!.providers["account:bigmodel-individual-coding-plan"]!.access
        .entitled,
    ).toBe(false);
  });

  it("treats an undecryptable store as empty", () => {
    writeFileSync(
      zcodeStorePath.value,
      JSON.stringify({ [INDIVIDUAL_KEY]: "enc:v1:garbage.not-encrypted-at-all" }),
    );
    expect(
      buildAccountProviderConfig()!.providers["account:bigmodel-individual-coding-plan"]!.access
        .entitled,
    ).toBe(false);
  });

  it("serves the stored api-key when config.json never existed", () => {
    writeCredentialStore({ [INDIVIDUAL_KEY]: "stored-individual-key" });
    expect(codingPlanRequestAuthFor("account:bigmodel-individual-coding-plan")).toEqual({
      apiKey: "stored-individual-key",
    });
  });

  it("prefers config.json's key over the stored one", () => {
    writeCredentialStore({ [INDIVIDUAL_KEY]: "stored-individual-key" });
    writeFileSync(
      zcodeCfgPath.value,
      JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": { enabled: true, options: { apiKey: "legacy-key" } },
        },
      }),
    );
    expect(codingPlanRequestAuthFor("account:bigmodel-individual-coding-plan")).toEqual({
      apiKey: "legacy-key",
    });
  });

  it("keeps one family's store fallback when a bridge account names the other family", async () => {
    vi.stubEnv("ZCODE_HOME", path.join(root, ".zcode"));
    writeCredentialStore({ [INDIVIDUAL_KEY]: "stored-individual-key" });
    await saveBridgeAccount("zai", "bridge-zai-key");
    const { providers } = buildAccountProviderConfig()!;
    expect(providers["account:bigmodel-individual-coding-plan"]!.access.entitled).toBe(true);
    expect(providers["account:zai-individual-coding-plan"]!.access.entitled).toBe(true);
    expect(codingPlanRequestAuthFor("account:bigmodel-individual-coding-plan")).toEqual({
      apiKey: "stored-individual-key",
    });
    expect(codingPlanRequestAuthFor("account:zai-individual-coding-plan")).toEqual({
      apiKey: "bridge-zai-key",
    });
  });

  it("lets a bridge account override an unavailable desktop verdict for its own plan only", async () => {
    vi.stubEnv("ZCODE_HOME", path.join(root, ".zcode"));
    writeFileSync(
      path.join(root, ".zcode", "v2", "coding-plan-cache.json"),
      JSON.stringify({
        entryStatus: {
          items: {
            "builtin:zai-coding-plan": { status: "unavailable" },
            "builtin:bigmodel-coding-plan": { status: "unavailable" },
          },
        },
      }),
    );
    await saveBridgeAccount("zai", "bridge-zai-key");
    const { providers } = buildAccountProviderConfig()!;
    expect(providers["account:zai-individual-coding-plan"]!.access.entitled).toBe(true);
    expect(providers["account:bigmodel-individual-coding-plan"]!.access.entitled).toBe(false);
  });

  it("never serves a team plan key from the store", () => {
    writeCredentialStore({ [TEAM_KEY]: "stored-team-key" });
    expect(codingPlanRequestAuthFor("account:bigmodel-team-coding-plan")).toBeNull();
  });
});

describe("manual coding-plan keys from provider_config.json (#344)", () => {
  // The desktop's Settings → "Use API key" flow writes the plan key as a
  // personal rule with access type zhipu-coding-plan-api-key while OAuth
  // login writes no config.json key at all — without this rung, a 3.12+
  // desktop-only machine had no entitlement source and every account switch
  // failed with "Provider Registry 中不存在 Model".
  const zaiRule = (overrides: Record<string, unknown> = {}) => ({
    providerId: "zai-api",
    providerName: "Z.AI",
    config: {
      access: { type: "zhipu-coding-plan-api-key", apiKey: "manual-zai-key" },
      api: { type: "anthropic-messages", baseUrl: "https://api.z.ai/api/anthropic" },
    },
    ...overrides,
  });

  it("entitles the family and serves the manual key without any config.json", () => {
    writePersonalRules([zaiRule()]);
    const { providers } = buildAccountProviderConfig()!;
    expect(providers["account:zai-individual-coding-plan"]!.access.entitled).toBe(true);
    expect(providers["account:bigmodel-individual-coding-plan"]!.access.entitled).toBe(false);
    expect(codingPlanRequestAuthFor("account:zai-individual-coding-plan")).toEqual({
      apiKey: "manual-zai-key",
    });
  });

  it("ranks the manual key above the encrypted store and below config.json", () => {
    writeCredentialStore({
      "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:108:api-key":
        "stored-individual-key",
    });
    // Trailing slash on purpose: the endpoint match normalizes it away.
    writePersonalRules([
      {
        providerId: "bigmodel-api",
        config: {
          access: { type: "zhipu-coding-plan-api-key", apiKey: "manual-bigmodel-key" },
          api: { baseUrl: "https://open.bigmodel.cn/api/anthropic/" },
        },
      },
    ]);
    expect(codingPlanRequestAuthFor("account:bigmodel-individual-coding-plan")).toEqual({
      apiKey: "manual-bigmodel-key",
    });
    writeFileSync(
      zcodeCfgPath.value,
      JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": { enabled: true, options: { apiKey: "legacy-key" } },
        },
      }),
    );
    expect(codingPlanRequestAuthFor("account:bigmodel-individual-coding-plan")).toEqual({
      apiKey: "legacy-key",
    });
  });

  it("ignores disabled rules, plain api-key rules, and unrecognized baseUrls", () => {
    writePersonalRules([
      zaiRule({ enabled: false }),
      {
        providerId: "plain",
        config: {
          access: { type: "api-key", apiKey: "k" },
          api: { baseUrl: "https://api.z.ai/api/anthropic" },
        },
      },
      {
        providerId: "proxy",
        config: {
          access: { type: "zhipu-coding-plan-api-key", apiKey: "k" },
          api: { baseUrl: "https://proxy.example/api/anthropic" },
        },
      },
    ]);
    expect(
      buildAccountProviderConfig()!.providers["account:zai-individual-coding-plan"]!.access
        .entitled,
    ).toBe(false);
    expect(codingPlanRequestAuthFor("account:zai-individual-coding-plan")).toBeNull();
  });

  it("falls back to the frozen official endpoints when the table is absent", () => {
    // Headless Linux has no desktop bundle to read — the endpoint → family
    // mapping must still resolve (frozen pair), and the individual-plan
    // detection falls back to the id-shape check.
    builtinProviderEnv.mockReturnValue({
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(root, "absent-table.json"),
    });
    delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    writePersonalRules([zaiRule()]);
    expect(codingPlanRequestAuthFor("account:zai-individual-coding-plan")).toEqual({
      apiKey: "manual-zai-key",
    });
  });
});

describe("authenticate (#344)", () => {
  it("answers {} when any credential source exists", () => {
    writePersonalRules([
      {
        providerId: "zai-api",
        config: {
          access: { type: "zhipu-coding-plan-api-key", apiKey: "manual-zai-key" },
          api: { baseUrl: "https://api.z.ai/api/anthropic" },
        },
      },
    ]);
    expect(zcodeCredentialsPresent()).toBe(true);
    expect(authenticate({ methodId: "zcode-credentials" })).toEqual({});
  });

  it("errors with sign-in guidance when no credential source exists", () => {
    expect(zcodeCredentialsPresent()).toBe(false);
    expect(() => authenticate({ methodId: "zcode-credentials" })).toThrowError(
      messages().authErrNoCredentials,
    );
  });

  it("rejects an unknown auth method id with -32602", () => {
    let code: number | undefined;
    try {
      authenticate({ methodId: "someone-elses-method" });
    } catch (e) {
      code = (e as RequestError).code;
    }
    expect(code).toBe(-32602);
  });
});

describe("3.15+ desktop layout — OAuth sign-in + providerFamilyConnectionSelections", () => {
  function writeSetting(selections: Record<string, unknown>): void {
    writeFileSync(
      path.join(dataRoot.value, "setting.json"),
      JSON.stringify({ providerFamilyConnectionSelections: selections }),
    );
  }

  it("entitles the selected family's individual plan when the store holds its OAuth sign-in", () => {
    writeCredentialStore({ "oauth:zai:access_token": "login-jwt" });
    writeSetting({ zai: { kind: "individual-coding-plan" } });
    const payload = buildAccountProviderConfig();
    expect(payload!.providers["account:zai-individual-coding-plan"]!.access.entitled).toBe(true);
    // The table's default (bigmodel) must not win over the user's selection.
    expect(payload!.providers["account:bigmodel-individual-coding-plan"]!.access.entitled).toBe(
      false,
    );
    expect(oauthProjectTokenFamilyFor("account:zai-individual-coding-plan")).toBe("zai");
    expect(zcodeCredentialsPresent()).toBe(true);
    // The dropdown offers the entitled plan's models, not the BigModel default.
    expect(entitledCodingPlanModels()).toEqual([
      {
        providerId: "builtin:zai-coding-plan",
        providerName: "builtin:zai-coding-plan",
        modelId: "GLM-5.3",
      },
      {
        providerId: "builtin:zai-coding-plan",
        providerName: "builtin:zai-coding-plan",
        modelId: "GLM-5.3-Flash",
      },
    ]);
  });

  it("ignores the selection without an OAuth sign-in for that family", () => {
    writeCredentialStore({ "oauth:bigmodel:access_token": "login-jwt" });
    writeSetting({ zai: { kind: "individual-coding-plan" } });
    const payload = buildAccountProviderConfig();
    expect(payload!.providers["account:zai-individual-coding-plan"]!.access.entitled).toBe(false);
    expect(oauthProjectTokenFamilyFor("account:zai-individual-coding-plan")).toBeNull();
  });

  it("counts only individual coding-plan selections", () => {
    writeCredentialStore({ "oauth:bigmodel:access_token": "login-jwt" });
    writeSetting({ bigmodel: { kind: "team-coding-plan" } });
    const payload = buildAccountProviderConfig();
    expect(payload!.providers["account:bigmodel-individual-coding-plan"]!.access.entitled).toBe(
      false,
    );
    expect(oauthProjectTokenFamilyFor("account:bigmodel-team-coding-plan")).toBeNull();
  });

  it("never lets the selection override an explicit desktop verdict", () => {
    writeCredentialStore({ "oauth:zai:access_token": "login-jwt" });
    writeSetting({ zai: { kind: "individual-coding-plan" } });
    writeFileSync(
      path.join(dataRoot.value, "coding-plan-cache.json"),
      JSON.stringify({
        entryStatus: { items: { "builtin:bigmodel-coding-plan": { status: "available" } } },
      }),
    );
    const payload = buildAccountProviderConfig();
    expect(payload!.providers["account:zai-individual-coding-plan"]!.access.entitled).toBe(false);
    expect(oauthProjectTokenFamilyFor("account:zai-individual-coding-plan")).toBeNull();
  });

  it("does not let a leftover pre-3.12 config.json static key shadow 3.15+ OAuth, while keeping bridge and manual overrides", async () => {
    vi.stubEnv("ZCODE_HOME", path.join(root, ".zcode"));
    writeCredentialStore({
      "oauth:zai:access_token": "login-jwt",
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:108:api-key":
        "stale-pre-3.15-store-key",
    });
    writeFileSync(
      path.join(dataRoot.value, "setting.json"),
      JSON.stringify({
        modelProviderFamilyModes: { zai: "oauth" },
        providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
      }),
    );
    // Leftover pre-3.12 config.json with an expired static key on zai.
    writeFileSync(
      zcodeCfgPath.value,
      JSON.stringify({
        provider: {
          "builtin:zai-coding-plan": {
            enabled: true,
            options: { apiKey: "stale-pre-3.12-key" },
            models: { "GLM-5.3": {}, "GLM-5.3-Flash": {} },
          },
        },
      }),
    );
    // Static request-auth returns null so answerProviderRuntimeHeaders proceeds
    // to oauthProjectTokenFamilyFor -> resolveOAuthProjectToken("zai").
    expect(codingPlanRequestAuthFor("account:zai-individual-coding-plan")).toBeNull();
    expect(oauthProjectTokenFamilyFor("account:zai-individual-coding-plan")).toBe("zai");

    // A manual coding-plan key in 3.12+ provider_config.json still wins.
    writePersonalRules([
      {
        providerId: "zai-api",
        config: {
          access: { type: "zhipu-coding-plan-api-key", apiKey: "manual-zai-key" },
          api: { baseUrl: "https://api.z.ai/api/anthropic" },
        },
      },
    ]);
    expect(codingPlanRequestAuthFor("account:zai-individual-coding-plan")).toEqual({
      apiKey: "manual-zai-key",
    });

    // An explicit `zcode-acp setup` bridge account wins above everything.
    await saveBridgeAccount("zai", "bridge-zai-key");
    expect(codingPlanRequestAuthFor("account:zai-individual-coding-plan")).toEqual({
      apiKey: "bridge-zai-key",
    });
  });

  it("advertises entitled OAuth coding-plan models alongside personal custom providers and leftover config.json entries", () => {
    writeCredentialStore({ "oauth:zai:access_token": "login-jwt" });
    writeSetting({ zai: { kind: "individual-coding-plan" } });
    // Leftover pre-3.12 config.json where builtin:zai-coding-plan was disabled
    // and a custom provider was later disabled in 3.12+ provider_config.json,
    // while another personal custom provider is enabled.
    writeFileSync(
      zcodeCfgPath.value,
      JSON.stringify({
        provider: {
          "custom:cliproxyapi": {
            name: "CLIProxyAPI",
            enabled: true,
            options: { apiKey: "old-proxy-key", baseURL: "http://127.0.0.1:8317/v1" },
            models: { "claude-opus-4-6-thinking": {} },
          },
          "builtin:zai-coding-plan": {
            enabled: false,
            models: { "GLM-5.3": {}, "GLM-5.3-Flash": {} },
          },
        },
      }),
    );
    writeFileSync(
      path.join(dataRoot.value, "provider_config.json"),
      JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "custom:cliproxyapi",
                providerName: "CLIProxyAPI",
                enabled: false,
                config: { access: { type: "api-key", apiKey: "old-proxy-key" } },
              },
              {
                providerId: "custom:active",
                providerName: "ActiveCustom",
                enabled: true,
                config: {
                  access: { type: "api-key", apiKey: "active-key" },
                  api: { baseUrl: "https://api.example.test/v1" },
                },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              {
                providerId: "custom:active",
                modelId: "custom-model-1",
                config: { enabled: true },
              },
            ],
          },
        },
      }),
    );

    const models = loadAllModels();
    expect(models).toEqual([
      {
        providerId: "builtin:zai-coding-plan",
        providerName: "builtin:zai-coding-plan",
        modelId: "GLM-5.3",
      },
      {
        providerId: "builtin:zai-coding-plan",
        providerName: "builtin:zai-coding-plan",
        modelId: "GLM-5.3-Flash",
      },
      {
        providerId: "custom:active",
        providerName: "ActiveCustom",
        modelId: "custom-model-1",
      },
    ]);
  });
});
