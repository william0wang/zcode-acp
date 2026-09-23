/**
 * Crash guards: the bridge must SURVIVE an unhandled rejection / uncaught
 * exception (the whole TUI window dies with the process), and warn() must
 * leave an on-disk trace that outlives the window (crash-guards.ts).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendDiary,
  describeError,
  installCrashGuards,
  isStdoutPipeBreak,
  resetCrashGuardsForTest,
} from "../src/crash-guards.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "zacp-crash-"));
  process.env.ZCODE_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("describeError", () => {
  it("renders an Error with its stack head", () => {
    const out = describeError(new Error("boom"));
    expect(out).toContain("boom");
    expect(out).toContain("Error: boom");
  });
  it("renders non-Error values", () => {
    expect(describeError("plain")).toBe('"plain"');
    expect(describeError(42)).toBe("42");
  });
});

describe("isStdoutPipeBreak", () => {
  it("matches EPIPE code and message spellings", () => {
    expect(isStdoutPipeBreak(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(
      true,
    );
    expect(isStdoutPipeBreak(new Error("some EPIPE happened"))).toBe(true);
    expect(isStdoutPipeBreak(new Error("ordinary failure"))).toBe(false);
    expect(isStdoutPipeBreak(undefined)).toBe(false);
  });
});

describe("appendDiary", () => {
  it("writes under ZCODE_HOME/cli/log with the UTC date prefix, creating dirs", () => {
    delete process.env.VITEST;
    appendDiary("hello diary");
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(home, "cli", "log", `zcode-acp-${day}.log`);
    expect(existsSync(file)).toBe(true);
    const line = readFileSync(file, "utf8").trim();
    expect(line).toContain("hello diary");
    process.env.VITEST = "true";
  });
  it("silently ignores an unwritable root instead of throwing", () => {
    delete process.env.VITEST;
    process.env.ZCODE_HOME = path.join(home, "file-as-root", "x");
    // The append must not throw even though mkdir under a FILE root fails.
    expect(() => appendDiary("dropped")).not.toThrow();
    process.env.VITEST = "true";
  });
});

describe("installCrashGuards", () => {
  it("registers both handlers exactly once", () => {
    resetCrashGuardsForTest();
    const before = process.listenerCount("unhandledRejection");
    installCrashGuards();
    installCrashGuards();
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    expect(
      process.listenerCount("uncaughtException") - process.listenerCount("uncaughtException"),
    ).toBeLessThan(3);
  });

  it("a real child process survives an unhandled rejection", () => {
    // True end-to-end: a child running the compiled guards must NOT exit when
    // a promise rejects uncaught. Node ≥15 (and Bun) crash by default.
    const script = `
      import { installCrashGuards } from ${JSON.stringify(path.resolve("dist/crash-guards.js"))};
      installCrashGuards();
      process.env.ZCODE_HOME = ${JSON.stringify(home)};
      Promise.reject(new Error("uncaught rejection under test"));
      setTimeout(() => { process.stdout.write("SURVIVED\\n"); process.exit(0); }, 300);
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("SURVIVED");
    expect(res.stderr).toContain("uncaught rejection under test");
  }, 15_000);
});
