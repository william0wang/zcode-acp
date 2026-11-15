/**
 * settings.ts tests — the file > env > default merge for every accessor.
 *
 * Uses a scratch XDG dir (real fs, no mocks) and per-case env objects, so
 * process.env is never touched. A file value that is PRESENT always wins,
 * even when it disables something (file `sandbox.enabled: false` beats
 * ZCODE_ACP_SANDBOX=1) — that is the documented precedence, same as the
 * remote prefs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { globalSandboxEnabled, quotaAutoResumeEnabled } from "../src/config/settings.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "zacp-settings-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeConfig(cfg: unknown): void {
  mkdirSync(path.join(scratch, "zcode-acp"), { recursive: true });
  writeFileSync(path.join(scratch, "zcode-acp", "config.json"), JSON.stringify(cfg));
}

const envOf = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  XDG_CONFIG_HOME: scratch,
  ...vars,
});

describe("quotaAutoResumeEnabled", () => {
  it("defaults to true; only explicit off spellings disable", () => {
    expect(quotaAutoResumeEnabled(envOf())).toBe(true);
    expect(quotaAutoResumeEnabled(envOf({ ZCODE_ACP_QUOTA_AUTO_RESUME: "" }))).toBe(true);
    expect(quotaAutoResumeEnabled(envOf({ ZCODE_ACP_QUOTA_AUTO_RESUME: "1" }))).toBe(true);
    expect(quotaAutoResumeEnabled(envOf({ ZCODE_ACP_QUOTA_AUTO_RESUME: "0" }))).toBe(false);
    expect(quotaAutoResumeEnabled(envOf({ ZCODE_ACP_QUOTA_AUTO_RESUME: "false" }))).toBe(false);
  });

  it("file quota.autoResume wins over env — an explicit true re-arms a disabled env", () => {
    writeConfig({ quota: { autoResume: false } });
    expect(quotaAutoResumeEnabled(envOf({ ZCODE_ACP_QUOTA_AUTO_RESUME: "1" }))).toBe(false);
    writeConfig({ quota: { autoResume: true } });
    expect(quotaAutoResumeEnabled(envOf({ ZCODE_ACP_QUOTA_AUTO_RESUME: "0" }))).toBe(true);
  });
});

describe("globalSandboxEnabled", () => {
  it("defaults to false; only '1'/'true' env spellings count", () => {
    expect(globalSandboxEnabled(envOf())).toBe(false);
    expect(globalSandboxEnabled(envOf({ ZCODE_ACP_SANDBOX: "1" }))).toBe(true);
    expect(globalSandboxEnabled(envOf({ ZCODE_ACP_SANDBOX: "true" }))).toBe(true);
    expect(globalSandboxEnabled(envOf({ ZCODE_ACP_SANDBOX: "yes" }))).toBe(false);
  });

  it("file enabled wins in BOTH directions — an explicit false beats env=1", () => {
    writeConfig({ sandbox: { enabled: true } });
    expect(globalSandboxEnabled(envOf())).toBe(true);
    writeConfig({ sandbox: { enabled: false } });
    expect(globalSandboxEnabled(envOf({ ZCODE_ACP_SANDBOX: "1" }))).toBe(false);
  });
});
