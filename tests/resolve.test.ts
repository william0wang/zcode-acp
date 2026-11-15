/**
 * resolveZcodeCommand argv tests.
 *
 * Regression cover for the Happy Eyeballs flag: #182 disabled Node's
 * `autoSelectFamily` to stop the 250ms connect budget from killing slow IPv4
 * edges, but that also drops the dual-stack fallback. A provider configured as
 * `http://localhost:PORT` where localhost resolves `::1` first and the server
 * listens on IPv4 only then fails hard instead of falling through — every
 * prompt hung. The fix pairs the disable with `--dns-result-order=ipv4first`.
 *
 * These lock the flag pair (and the escape hatch) without spawning the real
 * zcode app-server: ZCODE_BIN points at a nonexistent .cjs (the resolver only
 * needs the extension) and ZCODE_NODE at the running test runner, which is
 * sqlite-capable.
 */

import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { disallowedToolList, resolveZcodeCommand } from "../src/backend/resolve.js";

const SAVED = {
  ZCODE_BIN: process.env.ZCODE_BIN,
  ZCODE_NODE: process.env.ZCODE_NODE,
  ZCODE_KEEP_HAPPY_EYEBALLS: process.env.ZCODE_KEEP_HAPPY_EYEBALLS,
  ZCODE_DISALLOWED_TOOLS: process.env.ZCODE_DISALLOWED_TOOLS,
  ZCODE_ENABLE_AUTOMATION_TOOLS: process.env.ZCODE_ENABLE_AUTOMATION_TOOLS,
};

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function jsLaunchArgs(): string[] {
  process.env.ZCODE_BIN = "/nonexistent/zcode.cjs";
  process.env.ZCODE_NODE = process.execPath;
  delete process.env.ZCODE_DISALLOWED_TOOLS;
  return resolveZcodeCommand();
}

/** Non-JS ZCODE_BIN → the resolver returns the bin plus the backend args. */
function nativeLaunchArgs(): string[] {
  process.env.ZCODE_BIN = "/usr/bin/zcode";
  return resolveZcodeCommand();
}

describe("resolveZcodeCommand Happy Eyeballs args", () => {
  it("does not run Node preloads during catalog probe executable discovery", () => {
    const dir = mkdtempSync(path.join(process.env.HOME!, "resolve-probe-"));
    const marker = path.join(dir, "ran");
    const preload = path.join(dir, "preload.cjs");
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`);
    vi.stubEnv("NODE_OPTIONS", `--require=${preload}`);
    vi.stubEnv("ZCODE_BIN", "/nonexistent/zcode.cjs");
    vi.stubEnv("ZCODE_NODE", process.execPath);
    try {
      expect(resolveZcodeCommand({ catalogProbe: true })[0]).toBe(process.execPath);
      expect(existsSync(marker)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("disables autoSelectFamily AND pins dns order to ipv4first by default", () => {
    delete process.env.ZCODE_KEEP_HAPPY_EYEBALLS;
    const argv = jsLaunchArgs();
    expect(argv).toContain("--no-network-family-autoselection");
    // Without this the single-address lookup picks ::1 first and a
    // localhost-IPv4-only provider is unreachable.
    expect(argv).toContain("--dns-result-order=ipv4first");
    // Flags must precede the script path or node treats them as script args.
    expect(argv.indexOf("--no-network-family-autoselection")).toBeLessThan(
      argv.indexOf("/nonexistent/zcode.cjs"),
    );
    expect(argv.indexOf("--dns-result-order=ipv4first")).toBeLessThan(
      argv.indexOf("/nonexistent/zcode.cjs"),
    );
    expect(argv.slice(-4)).toEqual([
      "app-server",
      "--stdio",
      "--disallowed-tools",
      "CronCreate CronList CronUpdate CronDelete CronPauseSelf",
    ]);
  });
});

describe("resolveZcodeCommand disallowed tools", () => {
  const CRON_DEFAULTS = "CronCreate CronList CronUpdate CronDelete CronPauseSelf";

  it("disallows the Cron* tools by default — the bridge cannot serve automation/* (#192)", () => {
    delete process.env.ZCODE_DISALLOWED_TOOLS;
    expect(nativeLaunchArgs()).toEqual([
      "/usr/bin/zcode",
      "app-server",
      "--stdio",
      "--disallowed-tools",
      CRON_DEFAULTS,
    ]);
  });

  it("merges ZCODE_DISALLOWED_TOOLS with the Cron* defaults (dedup, normalized to spaces)", () => {
    process.env.ZCODE_DISALLOWED_TOOLS = "Bash,Write";
    expect(nativeLaunchArgs()).toEqual([
      "/usr/bin/zcode",
      "app-server",
      "--stdio",
      "--disallowed-tools",
      `Bash Write ${CRON_DEFAULTS}`,
    ]);
  });
});

// The array form feeds the per-session `toolDenylist` param (#340) — the
// argv flag above is parsed but never consumed by the app-server path.
describe("disallowedToolList (array form for session/create·resume toolDenylist)", () => {
  const CRON_DEFAULTS = ["CronCreate", "CronList", "CronUpdate", "CronDelete", "CronPauseSelf"];

  it("is the Cron* defaults when the env var is unset", () => {
    delete process.env.ZCODE_DISALLOWED_TOOLS;
    delete process.env.ZCODE_ENABLE_AUTOMATION_TOOLS;
    expect(disallowedToolList()).toEqual(CRON_DEFAULTS);
  });

  it("is the user list alone (normalized) when automation tools are opted in", () => {
    process.env.ZCODE_DISALLOWED_TOOLS = "Bash,Write,Bash";
    process.env.ZCODE_ENABLE_AUTOMATION_TOOLS = "1";
    expect(disallowedToolList()).toEqual(["Bash", "Write"]);
  });
});

describe("zcodeDataBaseDirEnv (ZCODE_HOME → ZCODE_DATA_BASE_DIR)", () => {
  // The bridge reads the data tree through ZCODE_HOME (it replaces ~/.zcode
  // outright), but the backend's contract is ZCODE_DATA_BASE_DIR — the PARENT
  // of .zcode (packages/services/src/paths.ts:11,33-45). Without the
  // translation both sides read different trees (split-brain discovery).
  const savedHome = process.env.ZCODE_HOME;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = savedHome;
  });

  it("derives the parent directory when the tree is named .zcode", async () => {
    const { zcodeDataBaseDirEnv } = await import("../src/backend/resolve.js");
    process.env.ZCODE_HOME = "/tmp/isolated/.zcode";
    // ZCODE_HOME replaces ~/.zcode OUTRIGHT, and the backend's contract is the
    // PARENT of .zcode — so the translation is a plain dirname. The expected
    // value goes through the same resolve() the implementation uses, so a
    // drive-letter prefix on Windows matches instead of comparing raw POSIX
    // literals ("/tmp/isolated" → "C:\tmp\isolated").
    expect(zcodeDataBaseDirEnv()).toEqual({
      ZCODE_DATA_BASE_DIR: path.dirname(path.resolve("/tmp/isolated/.zcode")),
    });
  });
});
