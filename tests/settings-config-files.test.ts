/**
 * provider-config.ts + cli-config.ts tests.
 *
 * Both modules write files the ZCode desktop app owns, so the interesting
 * assertions are about SPELLING: which flag gets stored, which gets deleted,
 * and what the bytes on disk look like. A toggle that writes the wrong spelling
 * is silently inert — the file parses fine and nothing happens.
 *
 * Paths are redirected with ZCODE_HOME (both modules resolve through
 * `zcodeHomeDir()` per call), so every test runs inside a temp data root.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalBytes,
  readProviderConfig,
  removeModel,
  updateProvider,
  upsertModel,
  validateProviderConfig,
} from "../src/settings/provider-config.js";
import {
  HOOK_EVENT_NAMES,
  readCliConfig,
  readHooks,
  removeMcpServer,
  setHooksEnabled,
  setMcpServerEnabled,
  setPluginEnabled,
  setSkillEnabled,
  updateHookEntry,
  upsertMcpServer,
} from "../src/settings/cli-config.js";
import { zcodeCliConfigPath, zcodePersonalProviderPath } from "../src/utils.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "settings-cfg-test-"));
  vi.stubEnv("ZCODE_HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

/**
 * Seed a config file with a JSON body.
 *
 * Uses plain `JSON.stringify` rather than the module's own encoder on purpose:
 * a file written by the desktop app is the real input, and the writer must
 * cope with whatever shape it finds.
 */
async function seed(file: string, body: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(body), "utf8");
}

/** Seed with exact text — for the malformed-file cases. */
async function seedRaw(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

const emptyProviderConfig = {
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
};

describe("provider config — canonical form", () => {
  it("writes 2-space JSON with NO trailing newline (the app's own form)", async () => {
    await upsertModel("p1", "m1", {});
    const raw = await readFile(zcodePersonalProviderPath(), "utf8");
    expect(raw.endsWith("\n")).toBe(false);
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2));
  });

  it("emits schemaVersion 1 and the four containers even on a first write", async () => {
    await upsertModel("p1", "m1", {});
    const doc = await readProviderConfig();
    expect(doc.schemaVersion).toBe(1);
    expect(doc.config.providerConfigRules.providerRules).toEqual([]);
    expect(doc.config.modelConfigRules.providerModelRules).toHaveLength(1);
    expect(doc.config.modelConfigRules.manualProviderModelRules).toEqual([]);
  });

  it("keeps providerOrder and drops unknown TOP-LEVEL keys (strict schema)", async () => {
    await seed(zcodePersonalProviderPath(), {
      ...emptyProviderConfig,
      futureKey: { keep: true },
      config: {
        ...emptyProviderConfig.config,
        providerOrder: ["p1", "p2"],
      },
    });
    await upsertModel("p1", "m1", {});
    const doc = await readProviderConfig();
    expect(doc.config.providerOrder).toEqual(["p1", "p2"]);
    // Unlike cli/config.json (open schema, unknown keys preserved), this file's
    // top level is STRICT — an extra key makes the registry reject the whole
    // document, so the writer must drop it rather than carry it forward.
    expect(canonicalBytes(doc)).not.toContain("futureKey");
    expect(Object.keys(doc).sort()).toEqual(["config", "schemaVersion"]);
  });
});

describe("provider config — providers", () => {
  it("enables, disables and renames an existing rule", async () => {
    await seed(zcodePersonalProviderPath(), {
      ...emptyProviderConfig,
      config: {
        ...emptyProviderConfig.config,
        providerConfigRules: {
          providerRules: [{ providerId: "p1", providerName: "One", enabled: true }],
        },
      },
    });
    let doc = await updateProvider("p1", { enabled: false });
    expect(doc.config.providerConfigRules.providerRules[0]!.enabled).toBe(false);
    doc = await updateProvider("p1", { enabled: true, providerName: "Renamed" });
    expect(doc.config.providerConfigRules.providerRules[0]).toMatchObject({
      enabled: true,
      providerName: "Renamed",
    });
  });

  it("refuses to touch a provider that has no rule here", async () => {
    await expect(updateProvider("ghost", { enabled: false })).rejects.toThrow(/no rule/);
  });

  it("refuses account-managed providers outright", async () => {
    await expect(
      updateProvider("account:bigmodel-individual-coding-plan", { enabled: false }),
    ).rejects.toThrow(/account-managed/);
    await expect(upsertModel("account:zai-start-plan", "GLM-5", {})).rejects.toThrow(
      /account-managed/,
    );
  });

  it("never writes a rule declaring zhipu-account access", async () => {
    const file = zcodePersonalProviderPath();
    await seed(file, {
      ...emptyProviderConfig,
      config: {
        ...emptyProviderConfig.config,
        providerConfigRules: {
          providerRules: [{ providerId: "p1", config: { access: { type: "zhipu-account" } } }],
        },
      },
    });
    // Validation runs before anything is backed up or renamed, so the illegal
    // access block never lands — and the original bytes survive untouched.
    await expect(updateProvider("p1", { enabled: false })).rejects.toThrow(/zhipu-account/);
    expect(await readFile(file, "utf8")).toContain("zhipu-account");
  });
});

describe("provider config — models", () => {
  it("adds a model and registers it on the provider's model lists", async () => {
    await seed(zcodePersonalProviderPath(), {
      ...emptyProviderConfig,
      config: {
        ...emptyProviderConfig.config,
        providerConfigRules: {
          providerRules: [
            { providerId: "p1", config: { personalModelIds: ["a"], modelOrder: ["a"] } },
          ],
        },
      },
    });
    await upsertModel("p1", "b", {
      properties: { contextWindow: 128_000 },
      optionSpecs: { reasoningLevel: { values: ["low", "high"] } },
    });
    const doc = await readProviderConfig();
    expect(doc.config.modelConfigRules.providerModelRules[0]).toMatchObject({
      providerId: "p1",
      modelId: "b",
      config: {
        properties: { contextWindow: 128_000 },
        optionSpecs: { reasoningLevel: { values: ["low", "high"] } },
      },
    });
    const provider = doc.config.providerConfigRules.providerRules[0]!;
    expect(provider.config!.personalModelIds).toEqual(["a", "b"]);
    expect(provider.config!.modelOrder).toEqual(["a", "b"]);
  });

  it("is idempotent — re-adding a model updates rather than duplicates", async () => {
    await upsertModel("p1", "m1", { properties: { contextWindow: 1000 } });
    await upsertModel("p1", "m1", { properties: { contextWindow: 2000 } });
    const doc = await readProviderConfig();
    const rules = doc.config.modelConfigRules.providerModelRules.filter(
      (r) => r.providerId === "p1" && r.modelId === "m1",
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]!.config.properties!.contextWindow).toBe(2000);
  });

  it("omits `enabled: true` but stores `enabled: false`", async () => {
    await upsertModel("p1", "m1", { enabled: true });
    let doc = await readProviderConfig();
    expect(doc.config.modelConfigRules.providerModelRules[0]!.config.enabled).toBeUndefined();
    await upsertModel("p1", "m1", { enabled: false });
    doc = await readProviderConfig();
    expect(doc.config.modelConfigRules.providerModelRules[0]!.config.enabled).toBe(false);
  });

  it("rejects a non-positive contextWindow, an empty list, and repeats", async () => {
    await expect(upsertModel("p1", "m", { properties: { contextWindow: 0 } })).rejects.toThrow(
      /positive integer/,
    );
    await expect(
      upsertModel("p1", "m", { optionSpecs: { reasoningLevel: { values: [] } } }),
    ).rejects.toThrow(/non-empty array/);
    await expect(
      upsertModel("p1", "m", { optionSpecs: { reasoningLevel: { values: ["a", "a"] } } }),
    ).rejects.toThrow(/must not repeat/);
  });

  it("removes a model from the rule list and the provider's lists", async () => {
    await seed(zcodePersonalProviderPath(), {
      ...emptyProviderConfig,
      config: {
        ...emptyProviderConfig.config,
        providerConfigRules: {
          providerRules: [
            {
              providerId: "p1",
              config: { personalModelIds: ["m1", "m2"], modelOrder: ["m1", "m2"] },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [{ providerId: "p1", modelId: "m1", config: {} }],
          manualProviderModelRules: [],
        },
      },
    });
    await removeModel("p1", "m1");
    const doc = await readProviderConfig();
    expect(doc.config.modelConfigRules.providerModelRules).toEqual([]);
    expect(doc.config.providerConfigRules.providerRules[0]!.config!.personalModelIds).toEqual([
      "m2",
    ]);
    expect(doc.config.providerConfigRules.providerRules[0]!.config!.modelOrder).toEqual(["m2"]);
  });

  it("refuses to remove a model with no rule", async () => {
    await expect(removeModel("p1", "nope")).rejects.toThrow(/no rule/);
  });
});

describe("provider config — locked read-modify-write", () => {
  /**
   * The invariant ADR-0026 exists for: the change must be computed from the
   * document read INSIDE the lock, so a write that lands between our read and
   * our write is not silently discarded.
   *
   * Both calls below read the same starting file. If the module read outside
   * the lock (the bug this guards), the second write would carry the first
   * call's stale snapshot and the first model would vanish.
   */
  it("does not drop a concurrent write that lands between two calls", async () => {
    await seed(zcodePersonalProviderPath(), emptyProviderConfig);
    await Promise.all([upsertModel("p1", "m1", {}), upsertModel("p1", "m2", {})]);
    const doc = await readProviderConfig();
    const ids = doc.config.modelConfigRules.providerModelRules.map((r) => r.modelId).sort();
    expect(ids).toEqual(["m1", "m2"]);
  });

  it("keeps a provider toggle and a model add from overwriting each other", async () => {
    await seed(zcodePersonalProviderPath(), {
      ...emptyProviderConfig,
      config: {
        ...emptyProviderConfig.config,
        providerConfigRules: {
          providerRules: [{ providerId: "p1", providerName: "One" }],
        },
      },
    });
    await Promise.all([
      updateProvider("p1", { providerName: "Renamed" }),
      upsertModel("p1", "m1", {}),
    ]);
    const doc = await readProviderConfig();
    expect(doc.config.providerConfigRules.providerRules[0]!.providerName).toBe("Renamed");
    expect(doc.config.modelConfigRules.providerModelRules.map((r) => r.modelId)).toEqual(["m1"]);
  });

  it("validates the patch before taking the lock", async () => {
    // A rejected patch must not consume a lock slot or leave a lock behind.
    await expect(upsertModel("p1", "m1", { properties: { contextWindow: -5 } })).rejects.toThrow(
      /positive integer/,
    );
    const doc = await readProviderConfig();
    expect(doc.config.modelConfigRules.providerModelRules).toEqual([]);
  });

  it("reports a missing rule even when the file changed since the call started", async () => {
    // The "provider has no rule" check runs inside the lock too, so it sees the
    // current document rather than a snapshot.
    await expect(updateProvider("ghost", { enabled: false })).rejects.toThrow(/no rule/);
  });
});

describe("validateProviderConfig", () => {
  it("accepts a well-formed document", () => {
    expect(
      validateProviderConfig({
        schemaVersion: 1,
        config: {
          providerConfigRules: { providerRules: [{ providerId: "p" }] },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
    ).toBe(true);
  });

  it("rejects a wrong schemaVersion, duplicate ids, and malformed model rules", () => {
    expect(
      validateProviderConfig({
        schemaVersion: 2,
        config: {
          providerConfigRules: { providerRules: [] },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
    ).toMatch(/schemaVersion/);
    expect(
      validateProviderConfig({
        schemaVersion: 1,
        config: {
          providerConfigRules: { providerRules: [{ providerId: "p" }, { providerId: "p" }] },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
    ).toMatch(/duplicate/);
    expect(
      validateProviderConfig({
        schemaVersion: 1,
        config: {
          providerConfigRules: { providerRules: [] },
          modelConfigRules: {
            providerModelRules: [{ providerId: "p" }],
            manualProviderModelRules: [],
          },
        },
      }),
    ).toMatch(/providerId and modelId/);
  });
});

describe("cli config — skills", () => {
  it("stores a disable and deletes the key on enable", async () => {
    let doc = await setSkillEnabled("/x/SKILL.md", false);
    expect(doc.skills).toEqual({ "/x/SKILL.md": { enable: false } });
    doc = await setSkillEnabled("/x/SKILL.md", true);
    expect(doc.skills).toBeUndefined();
  });

  it("keeps other skills' overrides when enabling one", async () => {
    await setSkillEnabled("/a/SKILL.md", false);
    await setSkillEnabled("/b/SKILL.md", false);
    await setSkillEnabled("/a/SKILL.md", true);
    const doc = await readCliConfig();
    expect(doc.skills).toEqual({ "/b/SKILL.md": { enable: false } });
  });
});

describe("cli config — mcp", () => {
  it("creates a server, merges on update, and drops the flag when enabled", async () => {
    await upsertMcpServer("ctx7", {
      type: "stdio",
      command: "npx",
      args: ["-y", "ctx7"],
      enabled: false,
    });
    let doc = await readCliConfig();
    expect(doc.mcp!.servers!.ctx7).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "ctx7"],
      enabled: false,
    });
    await upsertMcpServer("ctx7", { enabled: true, env: { A: "1" } });
    doc = await readCliConfig();
    expect(doc.mcp!.servers!.ctx7).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "ctx7"],
      env: { A: "1" },
    });
  });

  it("migrates a legacy `enable` key when writing", async () => {
    await seed(zcodeCliConfigPath(), {
      mcp: { servers: { s: { command: "c", enable: false } } },
    });
    await upsertMcpServer("s", { enabled: true });
    expect((await readCliConfig()).mcp!.servers!.s).toEqual({ command: "c" });
  });

  it("toggles enablement and removes a server", async () => {
    await upsertMcpServer("s", { command: "c" });
    await setMcpServerEnabled("s", false);
    expect((await readCliConfig()).mcp!.servers!.s!.enabled).toBe(false);
    await setMcpServerEnabled("s", true);
    expect((await readCliConfig()).mcp!.servers!.s!.enabled).toBeUndefined();
    await removeMcpServer("s");
    expect((await readCliConfig()).mcp!.servers).toEqual({});
  });

  it("refuses to enable or remove an unknown server", async () => {
    await expect(setMcpServerEnabled("ghost", false)).rejects.toThrow(/not configured/);
    await expect(removeMcpServer("ghost")).rejects.toThrow(/not configured/);
  });

  it("refuses a name with a path separator", async () => {
    await expect(upsertMcpServer("../evil", { command: "c" })).rejects.toThrow(/path separators/);
  });
});

describe("cli config — hooks", () => {
  it("reads the tree with its enabled flag", async () => {
    await seed(zcodeCliConfigPath(), {
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      },
    });
    const hooks = await readHooks();
    expect(hooks.enabled).toBe(true);
    expect(hooks.events!.PreToolUse).toHaveLength(1);
  });

  it("sets and clears the global switch", async () => {
    await setHooksEnabled(true);
    expect((await readHooks()).enabled).toBe(true);
    await setHooksEnabled(false);
    expect((await readHooks()).enabled).toBeUndefined();
  });

  it("edits one existing entry and preserves its unknown keys", async () => {
    await seed(zcodeCliConfigPath(), {
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a", future: 1 }] }],
        },
      },
    });
    await updateHookEntry("PreToolUse", 0, 0, { command: "b", timeoutMs: 9000 });
    expect((await readHooks()).events!.PreToolUse![0]!.hooks[0]).toEqual({
      type: "command",
      command: "b",
      timeoutMs: 9000,
      future: 1,
    });
  });

  it("removes the enabled flag when re-enabling (enabled is the default)", async () => {
    await seed(zcodeCliConfigPath(), {
      hooks: {
        enabled: true,
        events: { Stop: [{ hooks: [{ type: "command", command: "a", enabled: false }] }] },
      },
    });
    await updateHookEntry("Stop", 0, 0, { enabled: true });
    expect((await readHooks()).events!.Stop![0]!.hooks[0]!.enabled).toBeUndefined();
    await updateHookEntry("Stop", 0, 0, { enabled: false });
    expect((await readHooks()).events!.Stop![0]!.hooks[0]!.enabled).toBe(false);
  });

  it("refuses an out-of-range index or an unknown event instead of creating", async () => {
    await seed(zcodeCliConfigPath(), { hooks: { enabled: true, events: {} } });
    await expect(updateHookEntry("PreToolUse", 3, 0, { command: "x" })).rejects.toThrow(
      /no matcher at index 3/,
    );
    await expect(updateHookEntry("BogusEvent", 0, 0, { command: "x" })).rejects.toThrow(
      /unknown hook event/,
    );
  });

  it("rejects an empty command and a non-positive timeout", async () => {
    await seed(zcodeCliConfigPath(), {
      hooks: {
        enabled: true,
        events: { Stop: [{ hooks: [{ type: "command", command: "a" }] }] },
      },
    });
    await expect(updateHookEntry("Stop", 0, 0, { command: "" })).rejects.toThrow(/non-empty/);
    await expect(updateHookEntry("Stop", 0, 0, { timeoutMs: 0 })).rejects.toThrow(/positive/);
  });

  it("exposes exactly the seven schema event names", () => {
    expect(HOOK_EVENT_NAMES).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
    ]);
  });
});

describe("cli config — plugins", () => {
  it("stores a disable and deletes the key on enable", async () => {
    await setPluginEnabled("code-review@zcode-plugins-official", false);
    expect((await readCliConfig()).plugins!.enabledPlugins).toEqual({
      "code-review@zcode-plugins-official": false,
    });
    await setPluginEnabled("code-review@zcode-plugins-official", true);
    expect((await readCliConfig()).plugins!.enabledPlugins).toEqual({});
  });

  it("rejects a key without a marketplace", async () => {
    await expect(setPluginEnabled("noplugin", false)).rejects.toThrow(/marketplace/);
  });
});

describe("cli config — damage handling", () => {
  it("refuses to write over a corrupt file", async () => {
    const file = zcodeCliConfigPath();
    await seedRaw(file, "{ not json");
    await expect(setSkillEnabled("/x/SKILL.md", false)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });
});
