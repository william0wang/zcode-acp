import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const taskInserts: unknown[][] = [];
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    prepare() {
      return { run: (...args: unknown[]) => taskInserts.push(args) };
    }
    close() {}
  },
}));

import { readHiddenApiKey, runAccountSetup } from "../src/account-setup.js";
import {} from "../src/backend/credentials.js";
import {
  buildAccountProviderConfig,
  codingPlanRequestAuthFor,
} from "../src/config/account-provider.js";
import {
  bridgeAccountsPath,
  readBridgeAccounts,
  readCredentialConfig,
  saveBridgeAccount,
} from "../src/config/bridge-accounts.js";
import {} from "../src/config/options.js";
import {} from "../src/quota/client.js";
import {} from "../src/tasks-index.js";
import { ZCODE_CREDS_PATH } from "../src/utils.js";

let root: string;
beforeEach(() => {
  root = path.dirname(ZCODE_CREDS_PATH);
  mkdirSync(root, { recursive: true });
  const resources = path.join(root, "resources");
  mkdirSync(path.join(resources, "config/provider"), { recursive: true });
  mkdirSync(path.join(resources, "glm"), { recursive: true });
  const entry = path.join(resources, "glm/zcode.cjs");
  writeFileSync(entry, "// synthetic");
  writeFileSync(
    path.join(resources, "config/provider/zcode-builtin.json"),
    JSON.stringify({
      revision: 1,
      config: {
        providerConfigRules: {
          providerRules: ["zai", "bigmodel"].map((family) => ({
            providerId: `account:${family}-individual-coding-plan`,
            config: {
              builtinModelIds: ["SYNTHETIC-MODEL"],
              access: {
                type: "zhipu-account",
                mode: "individual-coding-plan",
                accountType: family,
              },
            },
          })),
        },
      },
    }),
  );
  vi.stubEnv("ZCODE_BIN", entry);
  vi.stubEnv("ZCODE_PROVIDER", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const KEY = "synthetic-key-for-tests";
describe("private account storage", () => {
  it("saves both families atomically with private permissions, leaving Desktop bytes unchanged", async () => {
    const desktop = '{"provider":{"untouched":{"enabled":false}}}';
    writeFileSync(ZCODE_CREDS_PATH, desktop);
    await saveBridgeAccount("zai", KEY);
    await saveBridgeAccount("bigmodel", "second-synthetic-key");
    expect(readBridgeAccounts()).toEqual({
      zai: { apiKey: KEY },
      bigmodel: { apiKey: "second-synthetic-key" },
    });
    if (process.platform !== "win32")
      expect(statSync(bridgeAccountsPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(ZCODE_CREDS_PATH, "utf8")).toBe(desktop);
    expect(existsSync(bridgeAccountsPath() + ".lock")).toBe(false);
  });
  it("rejects insecure permissions, symlinks and hardlinks", async () => {
    const file = bridgeAccountsPath();
    await saveBridgeAccount("zai", KEY);
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      expect(() => readBridgeAccounts()).toThrow();
      chmodSync(file, 0o600);
    }
    const linked = file + ".linked";
    linkSync(file, linked);
    expect(() => readBridgeAccounts()).toThrow();
    rmSync(linked);
    symlinkSync(file, linked);
    expect(() => readBridgeAccounts(linked)).toThrow();
    await expect(saveBridgeAccount("bigmodel", KEY, linked)).rejects.toThrow();
    expect(readBridgeAccounts()).toEqual({ zai: { apiKey: KEY } });
  });
  it("does not lose accounts during concurrent updates", async () => {
    const results = await Promise.allSettled([
      saveBridgeAccount("zai", KEY),
      saveBridgeAccount("bigmodel", KEY),
    ]);
    const accounts = readBridgeAccounts();
    const successes = results.filter((result) => result.status === "fulfilled").length;
    expect(Object.keys(accounts)).toHaveLength(successes);
    expect(successes).toBeGreaterThan(0);
    for (const result of results)
      if (result.status === "rejected") expect(result.reason.message).not.toContain(KEY);
  });
});

/** Simulate an installed table that lacks the zai individual plan. */
function dropZaiRule(): void {
  const table = path.join(root, "resources/config/provider/zcode-builtin.json");
  const parsed = JSON.parse(readFileSync(table, "utf8"));
  parsed.config.providerConfigRules.providerRules =
    parsed.config.providerConfigRules.providerRules.filter(
      (rule: { providerId: string }) => !rule.providerId.startsWith("account:zai-"),
    );
  writeFileSync(table, JSON.stringify(parsed));
}

const DESKTOP_KEY = "synthetic-desktop-key";
function writeDesktopConfig(): void {
  writeFileSync(
    ZCODE_CREDS_PATH,
    JSON.stringify({
      provider: {
        "builtin:bigmodel-coding-plan": {
          name: "Desktop BigModel",
          kind: "anthropic",
          enabled: true,
          options: { apiKey: DESKTOP_KEY, baseURL: "https://open.bigmodel.cn/api/anthropic" },
          models: { "SYNTHETIC-MODEL": {} },
        },
      },
    }),
  );
}

describe("overlay failures keep Desktop credentials", () => {
  it("skips only the family the installed catalog lacks", async () => {
    writeDesktopConfig();
    await saveBridgeAccount("zai", KEY);
    await saveBridgeAccount("bigmodel", "bridge-bigmodel-key");
    dropZaiRule();
    const providers = readCredentialConfig(ZCODE_CREDS_PATH).provider ?? {};
    expect(Object.keys(providers)).toEqual(["builtin:bigmodel-coding-plan"]);
    expect(providers["builtin:bigmodel-coding-plan"]?.options?.apiKey).toBe("bridge-bigmodel-key");
  });
  it("does not entitle a family whose overlay was skipped", async () => {
    const table = path.join(root, "resources/config/provider/zcode-builtin.json");
    const parsed = JSON.parse(readFileSync(table, "utf8"));
    parsed.config.providerConfigRules.providerRules[0].config.builtinModelIds = [];
    writeFileSync(table, JSON.stringify(parsed));
    writeFileSync(
      ZCODE_CREDS_PATH,
      JSON.stringify({
        provider: {
          "builtin:zai-coding-plan": { enabled: false, options: { apiKey: "stale-desktop-key" } },
        },
      }),
    );
    await saveBridgeAccount("zai", KEY);
    expect(codingPlanRequestAuthFor("account:zai-individual-coding-plan")).toBeNull();
    expect(
      buildAccountProviderConfig()?.providers["account:zai-individual-coding-plan"].access.entitled,
    ).toBe(false);
  });
});

function terminal() {
  const stream = new PassThrough();
  const state = { raw: false, output: "" };
  const input = Object.assign(stream, {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      state.raw = value;
      this.isRaw = value;
      return this;
    },
  }) as unknown as ReadStream;
  const output = {
    write(value: string) {
      state.output += value;
      return true;
    },
  };
  return { input, output, state };
}
describe("hidden terminal input", () => {
  it("does not echo the key, accepts backspace, restores raw mode and listeners", async () => {
    const { input, output, state } = terminal();
    const answer = readHiddenApiKey(input, output);
    input.emit("keypress", "a", {});
    input.emit("keypress", "b", {});
    input.emit("keypress", undefined, { name: "backspace" });
    input.emit("keypress", "c", {});
    input.emit("keypress", "\r", { name: "return" });
    expect(await answer).toBe("ac");
    expect(state.output).not.toContain("ac");
    expect(state.raw).toBe(false);
    expect(input.listenerCount("keypress")).toBe(0);
  });
  it("refuses secret command arguments and nonterminal setup", async () => {
    await expect(runAccountSetup(["--provider", "zai", "--api-key", KEY])).rejects.toThrow(
      "Usage:",
    );
    await expect(runAccountSetup(["--provider", "zai"])).rejects.toThrow("interactive terminal");
    expect(existsSync(bridgeAccountsPath())).toBe(false);
  });
});
