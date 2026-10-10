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
 * Fixtures are real files under hermetic temp trees; nothing writes outside
 * tmpdir.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  builtinProviderEnv,
  BUILTIN_PROVIDER_ENV,
  PERSONAL_PROVIDER_ENV,
} from "../src/backend/resolve.js";

const SAVED = {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
  ZCODE_BIN: process.env.ZCODE_BIN,
  ZCODE_HOME: process.env.ZCODE_HOME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
};

let scratch: string;
let personal: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "zcode-bundle-"));
  process.env.ZCODE_HOME = path.join(scratch, "data");
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
});
