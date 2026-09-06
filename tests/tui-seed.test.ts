/**
 * Martty quota-dock plugin seeding tests (ADR-0021): planQuotaSeed decision
 * table (fresh write, ours-current, ours-old update, user-modified, foreign,
 * unparseable) and the filesystem seeding with a mocked fs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => mockFiles.has(p) || actual.existsSync(p),
    readFileSync: (p: string) => {
      if (mockFiles.has(p)) return mockFiles.get(p)!;
      return actual.readFileSync(p);
    },
    mkdirSync: (p: string) => {
      mockDirs.add(p);
    },
    writeFileSync: (p: string, data: string) => {
      mockFiles.set(p, data);
    },
  };
});

import { planQuotaSeed, resolveMarttyHome, seedMarttyQuotaPlugin } from "../src/tui.js";

const ASSET = JSON.stringify({
  schemaVersion: 0,
  id: "zcode-acp-quota",
  kind: "ui",
  name: "zcode-acp quota dock",
  source: { pluginId: "plugin-zcode-acp-quota", packageId: "pkg-zcode-acp-quota-1" },
  code: { client: "return {}" },
});

const ours = (version: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 0,
    id: "zcode-acp-quota",
    kind: "ui",
    source: { pluginId: "plugin-zcode-acp-quota", packageId: `pkg-zcode-acp-quota-${version}` },
    code: { client: "return {}" },
    ...extra,
  });

const ASSET_PATH = (() => {
  // dist/tui.js layout: ../assets/martty-plugins/quota-dock/plugin.json
  return new URL("../assets/martty-plugins/quota-dock/plugin.json", import.meta.url).pathname;
})();

describe("resolveMarttyHome", () => {
  it("prefers MARTTY_HOME, then $DSH_HOME/.martty, then ~/.martty", () => {
    expect(resolveMarttyHome({ MARTTY_HOME: "/mh" })).toBe("/mh");
    expect(resolveMarttyHome({ DSH_HOME: "/dh" })).toBe("/dh/.martty");
    expect(resolveMarttyHome({})).toContain(".martty");
  });
});

describe("planQuotaSeed", () => {
  it("writes when the plugin is missing", () => {
    expect(planQuotaSeed(null, ASSET)).toEqual({ action: "write", reason: "fresh" });
  });

  it("no-ops on our identical current version", () => {
    expect(planQuotaSeed(ASSET, ASSET)).toEqual({ action: "none", reason: "current" });
  });

  it("updates our provably older version", () => {
    expect(planQuotaSeed(ours(0), ASSET)).toEqual({ action: "write", reason: "update" });
  });

  it("never touches a user-modified current version", () => {
    expect(planQuotaSeed(ours(1, { name: "my fork" }), ASSET)).toEqual({
      action: "skip",
      reason: "modified",
    });
  });

  it("never touches a foreign plugin (other source or newer than us)", () => {
    const foreign = JSON.stringify({
      source: { pluginId: "plugin-someone-else", packageId: "pkg-other-1" },
      code: { client: "return {}" },
    });
    expect(planQuotaSeed(foreign, ASSET)).toEqual({ action: "skip", reason: "foreign" });
    expect(planQuotaSeed(ours(2), ASSET)).toEqual({ action: "skip", reason: "foreign" });
  });

  it("never touches an unparseable file", () => {
    expect(planQuotaSeed("{ not json", ASSET)).toEqual({
      action: "skip",
      reason: "unparseable",
    });
  });
});

describe("seedMarttyQuotaPlugin", () => {
  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
    mockFiles.set(ASSET_PATH, ASSET);
  });

  it("writes the plugin.json into MARTTY_HOME/plugins when absent", () => {
    const home = "/tmp/mhome-seed";
    const target = `${home}/plugins/zcode-acp-quota/plugin.json`;
    expect(seedMarttyQuotaPlugin({ MARTTY_HOME: home })).toBe(true);
    expect(mockFiles.get(target)).toBe(ASSET);
    expect(mockDirs.has(`${home}/plugins/zcode-acp-quota`)).toBe(true);
  });

  it("does not rewrite an already-current plugin", () => {
    const home = "/tmp/mhome-seed";
    const target = `${home}/plugins/zcode-acp-quota/plugin.json`;
    mockFiles.set(target, ASSET);
    expect(seedMarttyQuotaPlugin({ MARTTY_HOME: home })).toBe(false);
    expect(mockFiles.get(target)).toBe(ASSET);
  });

  it("does not overwrite a user-modified plugin", () => {
    const home = "/tmp/mhome-seed";
    const target = `${home}/plugins/zcode-acp-quota/plugin.json`;
    const modified = ours(1, { name: "user fork" });
    mockFiles.set(target, modified);
    expect(seedMarttyQuotaPlugin({ MARTTY_HOME: home })).toBe(false);
    expect(mockFiles.get(target)).toBe(modified);
  });
});
