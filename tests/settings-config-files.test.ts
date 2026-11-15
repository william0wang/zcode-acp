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
  updateProvider,
  upsertModel,
} from "../src/settings/provider-config.js";
import { setSkillEnabled, upsertMcpServer } from "../src/settings/cli-config.js";
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

  it("refuses account-managed providers outright", async () => {
    await expect(
      updateProvider("account:bigmodel-individual-coding-plan", { enabled: false }),
    ).rejects.toThrow(/account-managed/);
    await expect(upsertModel("account:zai-start-plan", "GLM-5", {})).rejects.toThrow(
      /account-managed/,
    );
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
});

describe("cli config — mcp", () => {
  it("refuses a name with a path separator", async () => {
    await expect(upsertMcpServer("../evil", { command: "c" })).rejects.toThrow(/path separators/);
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
