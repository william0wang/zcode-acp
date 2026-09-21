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

import {
  autoCompactThreshold,
  debugEnabled,
  globalSandboxEnabled,
  goalMaxTurns,
  goalModeIsBackend,
  initialSessionMode,
  interactionTimeoutMs,
  languageOverride,
  tuiStatsSegments,
} from "../src/config/settings.js";

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

describe("autoCompactThreshold", () => {
  it("defaults to 0 (disabled) with no file and no env", () => {
    expect(autoCompactThreshold(envOf())).toBe(0);
  });

  it("reads the env fallback (invalid values stay disabled)", () => {
    expect(autoCompactThreshold(envOf({ ZCODE_ACP_AUTO_COMPACT_THRESHOLD: "100000" }))).toBe(
      100_000,
    );
    expect(autoCompactThreshold(envOf({ ZCODE_ACP_AUTO_COMPACT_THRESHOLD: "abc" }))).toBe(0);
    expect(autoCompactThreshold(envOf({ ZCODE_ACP_AUTO_COMPACT_THRESHOLD: "-5" }))).toBe(0);
  });

  it("file threshold wins over env", () => {
    writeConfig({ autoCompact: { threshold: 240_000 } });
    expect(autoCompactThreshold(envOf({ ZCODE_ACP_AUTO_COMPACT_THRESHOLD: "100000" }))).toBe(
      240_000,
    );
  });
});

describe("goalMaxTurns", () => {
  it("defaults to 100; env fallback applies", () => {
    expect(goalMaxTurns(envOf())).toBe(100);
    expect(goalMaxTurns(envOf({ ZCODE_ACP_GOAL_MAX_TURNS: "7" }))).toBe(7);
    expect(goalMaxTurns(envOf({ ZCODE_ACP_GOAL_MAX_TURNS: "abc" }))).toBe(100);
  });

  it("file maxTurns wins over env", () => {
    writeConfig({ goal: { maxTurns: 5 } });
    expect(goalMaxTurns(envOf({ ZCODE_ACP_GOAL_MAX_TURNS: "7" }))).toBe(5);
  });
});

describe("goalModeIsBackend", () => {
  it("defaults to false; env escape hatch applies", () => {
    expect(goalModeIsBackend(envOf())).toBe(false);
    expect(goalModeIsBackend(envOf({ ZCODE_ACP_GOAL_MODE: "backend" }))).toBe(true);
  });

  it("file mode wins over env; an invalid file mode falls back to env", () => {
    writeConfig({ goal: { mode: "backend" } });
    expect(goalModeIsBackend(envOf())).toBe(true);
    // "driver" is dropped at parse time → the env fallback decides.
    writeConfig({ goal: { mode: "driver" } });
    expect(goalModeIsBackend(envOf({ ZCODE_ACP_GOAL_MODE: "backend" }))).toBe(true);
    expect(goalModeIsBackend(envOf())).toBe(false);
  });
});

describe("initialSessionMode", () => {
  it("defaults to yolo; env fallback applies (empty string included)", () => {
    expect(initialSessionMode(envOf())).toBe("yolo");
    expect(initialSessionMode(envOf({ ZCODE_ACP_MODE: "edit" }))).toBe("edit");
    expect(initialSessionMode(envOf({ ZCODE_ACP_MODE: "" }))).toBe("yolo");
  });

  it("file session.mode wins over env", () => {
    writeConfig({ session: { mode: "plan" } });
    expect(initialSessionMode(envOf({ ZCODE_ACP_MODE: "edit" }))).toBe("plan");
  });
});

describe("interactionTimeoutMs", () => {
  it("defaults to 0 (wait forever); env fallback applies", () => {
    expect(interactionTimeoutMs(envOf())).toBe(0);
    expect(interactionTimeoutMs(envOf({ ZCODE_ACP_INTERACTION_TIMEOUT_MS: "5000" }))).toBe(5000);
    expect(interactionTimeoutMs(envOf({ ZCODE_ACP_INTERACTION_TIMEOUT_MS: "0" }))).toBe(0);
    expect(interactionTimeoutMs(envOf({ ZCODE_ACP_INTERACTION_TIMEOUT_MS: "junk" }))).toBe(0);
  });

  it("file timeoutMs wins over env — including an explicit 0 disarming the env", () => {
    writeConfig({ interaction: { timeoutMs: 300_000 } });
    expect(interactionTimeoutMs(envOf({ ZCODE_ACP_INTERACTION_TIMEOUT_MS: "5000" }))).toBe(300_000);
    writeConfig({ interaction: { timeoutMs: 0 } });
    expect(interactionTimeoutMs(envOf({ ZCODE_ACP_INTERACTION_TIMEOUT_MS: "5000" }))).toBe(0);
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

describe("debugEnabled", () => {
  it("defaults to false; env fallback applies", () => {
    expect(debugEnabled(envOf())).toBe(false);
    expect(debugEnabled(envOf({ ZCODE_ACP_DEBUG: "1" }))).toBe(true);
    expect(debugEnabled(envOf({ ZCODE_ACP_DEBUG: "0" }))).toBe(false);
  });

  it("file debug wins in both directions", () => {
    writeConfig({ debug: true });
    expect(debugEnabled(envOf())).toBe(true);
    writeConfig({ debug: false });
    expect(debugEnabled(envOf({ ZCODE_ACP_DEBUG: "1" }))).toBe(false);
  });
});

describe("languageOverride", () => {
  it("defaults to undefined; env pick is prefix-tolerant", () => {
    expect(languageOverride(envOf())).toBeUndefined();
    expect(languageOverride(envOf({ ZCODE_ACP_LANG: "zh_CN.UTF-8" }))).toBe("zh");
    expect(languageOverride(envOf({ ZCODE_ACP_LANG: "EN" }))).toBe("en");
    expect(languageOverride(envOf({ ZCODE_ACP_LANG: "fr" }))).toBeUndefined();
  });

  it("file lang wins over env; an invalid file lang falls back to env", () => {
    writeConfig({ lang: "zh-CN" });
    expect(languageOverride(envOf({ ZCODE_ACP_LANG: "en" }))).toBe("zh");
    writeConfig({ lang: "fr" });
    expect(languageOverride(envOf({ ZCODE_ACP_LANG: "en" }))).toBe("en");
  });
});

describe("tuiStatsSegments", () => {
  it("undefined with no file and no env (martty renders the full dock)", () => {
    expect(tuiStatsSegments(envOf())).toBeUndefined();
  });

  it("reads the env fallback (martty's own DSH_TUI_STATS vocabulary)", () => {
    expect(tuiStatsSegments(envOf({ DSH_TUI_STATS: "tokens,context" }))).toBe("tokens,context");
    // An empty string is a VALUE (hide every segment), not "absent".
    expect(tuiStatsSegments(envOf({ DSH_TUI_STATS: "" }))).toBe("");
  });

  it("file tui.stats wins over env — the hub reads the file live per incubation", () => {
    // The detached hub daemon's birth env predates most shell exports, so
    // the file must win or an env-only preference goes stale for every
    // window the hub opens afterwards.
    writeConfig({ tui: { stats: "context,tokens" } });
    expect(tuiStatsSegments(envOf({ DSH_TUI_STATS: "speed" }))).toBe("context,tokens");
  });

  it("a file empty string hides the dock even when env asks for segments", () => {
    writeConfig({ tui: { stats: "" } });
    expect(tuiStatsSegments(envOf({ DSH_TUI_STATS: "tokens" }))).toBe("");
  });
});
