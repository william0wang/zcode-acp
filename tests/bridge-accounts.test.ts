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

import { readHiddenApiKey, runAccountSetup } from "../src/account-setup.js";
import { loadZcodeCredentials } from "../src/backend/credentials.js";
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
import { loadAllModels } from "../src/config/options.js";
import { fetchQuotaResponse } from "../src/quota/client.js";
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
  it("rejects malformed stores without including their contents or overwriting them", async () => {
    const malformed = `{"secret":"${KEY}",broken`;
    writeFileSync(bridgeAccountsPath(), malformed, { mode: 0o600 });
    expect(() => readBridgeAccounts()).toThrow("Invalid or insecure bridge account configuration");
    await expect(saveBridgeAccount("zai", KEY)).rejects.toThrow("existing accounts were preserved");
    expect(readFileSync(bridgeAccountsPath(), "utf8")).toBe(malformed);
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
  it("rejects a dangling account symlink without replacing it", async () => {
    const file = bridgeAccountsPath();
    symlinkSync(file + ".missing-target", file);
    expect(() => readBridgeAccounts()).toThrow("Cannot read bridge account configuration");
    await expect(saveBridgeAccount("zai", KEY)).rejects.toThrow("existing accounts were preserved");
    expect(() => readBridgeAccounts()).toThrow("Cannot read bridge account configuration");
  });
  it("sanitizes malformed Desktop configuration errors", async () => {
    writeFileSync(ZCODE_CREDS_PATH, `{"secret":"${KEY}",broken`);
    expect(() => readCredentialConfig(ZCODE_CREDS_PATH)).toThrow(
      "Cannot read Desktop credential configuration",
    );
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
  it.each(["", "has space", "has\nnewline", "x".repeat(4097)])(
    "rejects invalid keys without saving",
    async (key) => {
      await expect(saveBridgeAccount("zai", key)).rejects.toThrow("Invalid Coding Plan account");
      expect(existsSync(bridgeAccountsPath())).toBe(false);
    },
  );
});

describe("standalone plan integration", () => {
  it("resolves discovery, entitlement, runtime auth and quota from a bridge-only home", async () => {
    await saveBridgeAccount("zai", KEY);
    expect(existsSync(ZCODE_CREDS_PATH)).toBe(false);
    expect(loadAllModels()).toEqual([
      {
        providerId: "builtin:zai-coding-plan",
        providerName: "Z.ai Coding Plan",
        modelId: "SYNTHETIC-MODEL",
      },
    ]);
    expect(
      buildAccountProviderConfig()?.providers["account:zai-individual-coding-plan"].access.entitled,
    ).toBe(true);
    expect(codingPlanRequestAuthFor("account:zai-individual-coding-plan")).toEqual({ apiKey: KEY });
    expect(loadZcodeCredentials().ANTHROPIC_API_KEY).toBe(KEY);
    let authorized = false;
    const fetch = vi.fn(async (url, init) => {
      authorized =
        url === "https://api.z.ai/api/monitor/usage/quota/limit" &&
        init.headers.Authorization === `Bearer ${KEY}`;
      return { status: 200, text: async () => "{}" };
    }) as unknown as typeof globalThis.fetch;
    await fetchQuotaResponse(fetch);
    expect(authorized).toBe(true);
    expect(existsSync(ZCODE_CREDS_PATH)).toBe(false);
  });
  it("overlays only the explicitly configured family and preserves other Desktop entries", async () => {
    writeFileSync(
      ZCODE_CREDS_PATH,
      JSON.stringify({
        provider: { "builtin:zai-coding-plan": { enabled: false }, other: { enabled: false } },
      }),
    );
    await saveBridgeAccount("zai", KEY);
    const merged = readCredentialConfig(ZCODE_CREDS_PATH);
    expect(merged.provider?.["builtin:zai-coding-plan"].enabled).toBe(true);
    expect(merged.provider?.other).toEqual({ enabled: false });
    expect(
      JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8")).provider["builtin:zai-coding-plan"]
        .enabled,
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
  it.each(["interrupt", "eof", "error"])("restores input on %s", async (event) => {
    const { input, output, state } = terminal();
    const answer = readHiddenApiKey(input, output);
    if (event === "interrupt") input.emit("keypress", undefined, { name: "c", ctrl: true });
    else input.emit(event === "eof" ? "end" : "error", new Error(KEY));
    await expect(answer).rejects.not.toThrow(KEY);
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
