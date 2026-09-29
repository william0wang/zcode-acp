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

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { zcodeCfgPath, dataRoot } = vi.hoisted(() => {
  // utils.js computes ZCODE_CREDS_PATH at import time, so the fixture dir is
  // created in the hoisted block and the env-less path is patched via the
  // module mock below.
  return { zcodeCfgPath: { value: "" }, dataRoot: { value: "" } };
});

vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...actual,
    get ZCODE_CREDS_PATH() {
      return zcodeCfgPath.value;
    },
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
  configProviderIdFor,
} from "../src/config/account-provider.js";

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
      ],
    },
  },
};

let root: string;
let tablePath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "acct-provider-"));
  const v2 = path.join(root, ".zcode", "v2");
  mkdirSync(v2, { recursive: true });
  zcodeCfgPath.value = path.join(v2, "config.json");
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
