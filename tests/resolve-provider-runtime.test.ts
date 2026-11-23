/**
 * builtinProviderEnv tests — the 3.12.3+ provider-table env injection.
 *
 * The desktop app's host resolves zcode-builtin.json at
 * `Resources/config/provider/zcode-builtin.json` and hands it to the CLI via
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (verified in app.asar). The CLI's own
 * fallback lookup only knows the npm/dev layouts, so a bare .app-bundle
 * `zcode.cjs` exits during boot with `无法定位 CLI ZCode Built-in Provider
 * Config` (observed 2026-09: exit 1 within a second, every bridge backend
 * spawn dead until the CLI's runtime sync happened to run). The bridge mirrors
 * the host's injection so bundled CLIs boot the same way they do under the
 * app.
 *
 * The bundled file is only a frozen baseline: the host refreshes the table
 * from the CDN into a runtime copy and boots its own agent on that copy, so
 * the bridge must pick the newer release of the two (observed 2026-11-23: the
 * 3.18.2 bundle is revision 44 while the runtime copy already carried revision
 * 47 with GLM-5.4 — the desktop listed the model, the bridge could not).
 *
 * Fixtures are real files under hermetic temp trees; nothing writes outside
 * tmpdir.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APP_VERSION_ENV,
  builtinProviderEnv,
  BUILTIN_PROVIDER_ENV,
  PERSONAL_PROVIDER_ENV,
} from "../src/backend/resolve.js";

const SAVED = {
  ZCODE_APP_VERSION: process.env.ZCODE_APP_VERSION,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
  ZCODE_BIN: process.env.ZCODE_BIN,
  ZCODE_ENDPOINT_ORIGIN: process.env.ZCODE_ENDPOINT_ORIGIN,
  ZCODE_HOME: process.env.ZCODE_HOME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
};

let scratch: string;
let personal: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "zcode-bundle-"));
  process.env.ZCODE_HOME = path.join(scratch, "data");
  delete process.env.ZCODE_APP_VERSION;
  // The runtime copy's endpoint key derives from the trusted origin; pin the default.
  delete process.env.ZCODE_ENDPOINT_ORIGIN;
  personal = path.join(process.env.ZCODE_HOME, "v2", "provider_config.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Build the broken .app-bundle fixture: <root>/glm/zcode.cjs + <root>/config/provider. */
function makeAppBundle(root: string): string {
  const glm = path.join(root, "glm");
  mkdirSync(glm, { recursive: true });
  writeFileSync(path.join(glm, "zcode.cjs"), "// fake cli");
  const providerDir = path.join(root, "config", "provider");
  mkdirSync(providerDir, { recursive: true });
  writeFileSync(path.join(providerDir, "zcode-builtin.json"), "{}");
  return path.join(glm, "zcode.cjs");
}

/** A valid release envelope — the shape upstream's `decodeZCodeBuiltinRelease` accepts. */
function releaseJson(revision: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: { templateRules: [], providerRules: [] },
      modelConfigRules: {},
    },
  });
}

function writeRelease(file: string, revision: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, releaseJson(revision));
}

/**
 * The host's runtime copy path, derived INDEPENDENTLY the way upstream's
 * `resolveZCodeBuiltinCachePaths` does — a drift in the bridge's derivation
 * (platform spelling, key length, segment order) fails here instead of
 * silently never finding the refreshed table.
 */
function activeTablePath(appVersion: string, origin = "https://zcode.z.ai"): string {
  const target = process.platform === "win32" ? "windows" : process.platform;
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const endpointKey = createHash("sha256").update(origin).digest("hex").slice(0, 32);
  return path.join(
    process.env.ZCODE_HOME!,
    "v2",
    "runtime",
    "provider",
    `${target}-${arch}`,
    appVersion,
    `endpoint-${endpointKey}`,
    "zcode-builtin.json",
  );
}

function writeInfoPlist(contents: string, version: string): void {
  mkdirSync(contents, { recursive: true });
  writeFileSync(
    path.join(contents, "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      "  <key>CFBundleShortVersionString</key>",
      `  <string>${version}</string>`,
      "</dict></plist>",
    ].join("\n"),
  );
}

/** .app fixture for `version` whose bundled table is release `revision`. */
function makeVersionedAppBundle(root: string, version: string, revision: number) {
  const contents = path.join(root, "ZCode.app", "Contents");
  const resources = path.join(contents, "Resources");
  const entry = makeAppBundle(resources);
  writeInfoPlist(contents, version);
  const bundled = path.join(resources, "config", "provider", "zcode-builtin.json");
  writeRelease(bundled, revision);
  return { bundled, entry };
}

describe("builtinProviderEnv", () => {
  it("points at ../config/provider for the .app bundle layout (the host's own path)", () => {
    const root = scratch;
    const entry = makeAppBundle(root);

    expect(builtinProviderEnv(entry)).toEqual({
      [BUILTIN_PROVIDER_ENV]: path.join(root, "config", "provider", "zcode-builtin.json"),
      [PERSONAL_PROVIDER_ENV]: personal,
    });
  });

  it("injects the intended personal path when its file and parent directory are missing", () => {
    const entry = makeAppBundle(scratch);
    expect(existsSync(path.dirname(personal))).toBe(false);
    expect(builtinProviderEnv(entry)[PERSONAL_PROVIDER_ENV]).toBe(personal);
    expect(existsSync(path.dirname(personal))).toBe(false);
    expect(existsSync(personal)).toBe(false);
  });

  it("uses the same path when the personal table exists", () => {
    const entry = makeAppBundle(scratch);
    mkdirSync(path.dirname(personal), { recursive: true });
    writeFileSync(personal, "{}");
    expect(builtinProviderEnv(entry)[PERSONAL_PROVIDER_ENV]).toBe(personal);
  });

  it("prefers a sibling provider/ config (npm/dev layout)", () => {
    const root = scratch;
    const entry = makeAppBundle(root);
    const sibling = path.join(root, "glm", "provider", "zcode-builtin.json");
    mkdirSync(path.dirname(sibling), { recursive: true });
    writeFileSync(sibling, "{}");

    expect(builtinProviderEnv(entry)).toEqual({
      [BUILTIN_PROVIDER_ENV]: sibling,
      [PERSONAL_PROVIDER_ENV]: personal,
    });
  });

  it("honors ZCODE_BIN as the entry when no explicit entry is passed", () => {
    const root = scratch;
    const entry = makeAppBundle(root);
    process.env.ZCODE_BIN = entry;

    expect(builtinProviderEnv()).toEqual({
      [BUILTIN_PROVIDER_ENV]: path.join(root, "config", "provider", "zcode-builtin.json"),
      [PERSONAL_PROVIDER_ENV]: personal,
    });
  });

  it("overrides an inherited ambient value — version-keyed runtime paths go stale across app updates", () => {
    const root = scratch;
    const entry = makeAppBundle(root);
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = "/stale/provider_config.json";
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE =
      "/stale/runtime/provider/3.12.3/endpoint-x/zcode-builtin.json";

    expect(builtinProviderEnv(entry)).toEqual({
      [BUILTIN_PROVIDER_ENV]: path.join(root, "config", "provider", "zcode-builtin.json"),
      [PERSONAL_PROVIDER_ENV]: personal,
    });
  });

  it("returns {} when no provider config exists anywhere (old CLI, PATH install)", () => {
    const root = scratch;
    const entry = path.join(root, "zcode.cjs");
    writeFileSync(entry, "// fake cli");

    expect(builtinProviderEnv(entry)).toEqual({});
  });

  it("returns {} for a non-JS or missing entry", () => {
    expect(builtinProviderEnv("/usr/bin/zcode")).toEqual({});
    expect(builtinProviderEnv("/nonexistent/zcode.cjs")).toEqual({});
  });

  it("injects ZCODE_APP_VERSION from macOS Info.plist when present", () => {
    const contents = path.join(scratch, "ZCode.app", "Contents");
    const resources = path.join(contents, "Resources");
    const entry = makeAppBundle(resources);
    writeInfoPlist(contents, "3.17.2");

    expect(builtinProviderEnv(entry)).toEqual({
      [BUILTIN_PROVIDER_ENV]: path.join(resources, "config", "provider", "zcode-builtin.json"),
      [PERSONAL_PROVIDER_ENV]: personal,
      [APP_VERSION_ENV]: "3.17.2",
    });
  });

  it("injects ZCODE_APP_VERSION from app.asar package.json on Linux/Windows bundle layouts", () => {
    const resources = path.join(scratch, "resources");
    const entry = makeAppBundle(resources);
    const pkgBytes = Buffer.from(JSON.stringify({ name: "@zcode/desktop", version: "3.17.2" }));
    const headerBytes = Buffer.from(
      JSON.stringify({
        files: { "package.json": { size: pkgBytes.length, offset: "0" } },
      }),
    );
    const alignedHeaderLen = Math.ceil(headerBytes.length / 4) * 4;
    const pre = Buffer.alloc(16);
    pre.writeUInt32LE(4, 0);
    pre.writeUInt32LE(8 + alignedHeaderLen, 4);
    pre.writeUInt32LE(4 + alignedHeaderLen, 8);
    pre.writeUInt32LE(headerBytes.length, 12);
    const paddedHeader = Buffer.alloc(alignedHeaderLen);
    headerBytes.copy(paddedHeader);
    writeFileSync(path.join(resources, "app.asar"), Buffer.concat([pre, paddedHeader, pkgBytes]));

    expect(builtinProviderEnv(entry)).toEqual({
      [BUILTIN_PROVIDER_ENV]: path.join(resources, "config", "provider", "zcode-builtin.json"),
      [PERSONAL_PROVIDER_ENV]: personal,
      [APP_VERSION_ENV]: "3.17.2",
    });
  });

  it("does not override an explicit ZCODE_APP_VERSION in process.env", () => {
    const contents = path.join(scratch, "ZCode.app", "Contents");
    const resources = path.join(contents, "Resources");
    const entry = makeAppBundle(resources);
    writeInfoPlist(contents, "3.17.2");
    process.env.ZCODE_APP_VERSION = "9.9.9";

    expect(builtinProviderEnv(entry)).toEqual({
      [BUILTIN_PROVIDER_ENV]: path.join(resources, "config", "provider", "zcode-builtin.json"),
      [PERSONAL_PROVIDER_ENV]: personal,
    });
  });
});

describe("builtinProviderEnv — the host's refreshed runtime copy", () => {
  it("boots on the runtime copy when it carries a newer release than the bundle", () => {
    const { entry } = makeVersionedAppBundle(scratch, "3.18.2", 44);
    const active = activeTablePath("3.18.2");
    writeRelease(active, 47);

    expect(builtinProviderEnv(entry)).toEqual({
      [BUILTIN_PROVIDER_ENV]: active,
      [PERSONAL_PROVIDER_ENV]: personal,
      [APP_VERSION_ENV]: "3.18.2",
    });
  });

  it("keeps the bundle when the runtime copy carries the same release", () => {
    const { bundled, entry } = makeVersionedAppBundle(scratch, "3.18.2", 44);
    writeRelease(activeTablePath("3.18.2"), 44);

    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(bundled);
  });

  it("keeps the bundle when the runtime copy is older (a leftover before an app update)", () => {
    const { bundled, entry } = makeVersionedAppBundle(scratch, "3.18.2", 47);
    writeRelease(activeTablePath("3.18.2"), 44);

    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(bundled);
  });

  it("ignores a runtime copy that is not a valid release", () => {
    const { bundled, entry } = makeVersionedAppBundle(scratch, "3.18.2", 44);
    const active = activeTablePath("3.18.2");
    mkdirSync(path.dirname(active), { recursive: true });
    writeFileSync(active, '{"schemaVersion":1,"revision":47,"config":{"pro');

    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(bundled);
  });

  it("ignores a runtime copy whose envelope upstream's decoder would reject", () => {
    const { bundled, entry } = makeVersionedAppBundle(scratch, "3.18.2", 44);
    const active = activeTablePath("3.18.2");
    mkdirSync(path.dirname(active), { recursive: true });
    // A strict envelope: modelConfigRules is required, an extra key is fatal.
    writeFileSync(
      active,
      JSON.stringify({ schemaVersion: 1, revision: 47, config: { providerConfigRules: {} } }),
    );

    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(bundled);
  });

  it("ignores the runtime copies of another app version", () => {
    const { bundled, entry } = makeVersionedAppBundle(scratch, "3.18.2", 44);
    writeRelease(activeTablePath("3.17.2"), 47);

    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(bundled);
  });

  it("scopes the runtime copy to the trusted endpoint origin", () => {
    const { bundled, entry } = makeVersionedAppBundle(scratch, "3.18.2", 44);
    writeRelease(activeTablePath("3.18.2"), 47);
    process.env.ZCODE_ENDPOINT_ORIGIN = "https://zcode.example.com";

    // The default endpoint's copy belongs to another control plane.
    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(bundled);

    const scoped = activeTablePath("3.18.2", "https://zcode.example.com");
    writeRelease(scoped, 45);
    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(scoped);
  });

  it("follows a refresh that lands after the first lookup (memoized on file identity)", () => {
    const { bundled, entry } = makeVersionedAppBundle(scratch, "3.18.2", 50);
    const active = activeTablePath("3.18.2");
    writeRelease(active, 47);
    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(bundled);

    writeRelease(active, 51);
    // Same byte length as before: move the clock so the stat identity changes.
    utimesSync(active, new Date("2030-01-01T00:00:01Z"), new Date("2030-01-01T00:00:01Z"));
    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(active);
  });

  it("yields to a valid runtime copy when the bundle itself is unreadable", () => {
    const { entry } = makeVersionedAppBundle(scratch, "3.18.2", 44);
    const active = activeTablePath("3.18.2");
    writeRelease(active, 44);
    writeFileSync(
      path.join(
        scratch,
        "ZCode.app",
        "Contents",
        "Resources",
        "config",
        "provider",
        "zcode-builtin.json",
      ),
      "not json",
    );

    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(active);
  });

  it("takes an explicit ZCODE_APP_VERSION as the version segment", () => {
    const { bundled, entry } = makeVersionedAppBundle(scratch, "3.18.2", 44);
    process.env.ZCODE_APP_VERSION = "9.9.9";
    writeRelease(activeTablePath("3.18.2"), 47);
    expect(builtinProviderEnv(entry)[BUILTIN_PROVIDER_ENV]).toBe(bundled);

    const active = activeTablePath("9.9.9");
    writeRelease(active, 45);
    expect(builtinProviderEnv(entry)).toEqual({
      [BUILTIN_PROVIDER_ENV]: active,
      [PERSONAL_PROVIDER_ENV]: personal,
    });
  });
});
