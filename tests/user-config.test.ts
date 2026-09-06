/**
 * The global user config loader (~/.config/zcode-acp/config.json): path
 * resolution (XDG aware), best-effort parsing (missing/malformed reads as
 * absent), and per-field validation (invalid values drop with a warn).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadUserConfig, userConfigPath } from "../src/config/user-config.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "zacp-usercfg-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeConfig(text: string): void {
  mkdirSync(path.join(scratch, "zcode-acp"), { recursive: true });
  writeFileSync(path.join(scratch, "zcode-acp", "config.json"), text);
}

describe("userConfigPath", () => {
  it("honours XDG_CONFIG_HOME when set", () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      path.join("/xdg", "zcode-acp", "config.json"),
    );
  });

  it("falls back to ~/.config", () => {
    const p = userConfigPath({});
    // The conventional layout under the home dir, whatever homedir() is here.
    expect(p.endsWith(path.join(".config", "zcode-acp", "config.json"))).toBe(true);
    expect(path.isAbsolute(p)).toBe(true);
  });
});

describe("loadUserConfig", () => {
  it("missing file reads as empty (the no-file env-only path)", () => {
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });

  it("parses the full remote section", () => {
    writeConfig(
      JSON.stringify({
        remote: {
          enabled: true,
          token: " tok ",
          hubPort: 18377,
          hubHost: "0.0.0.0",
          bridgePort: 18378,
          terminal: { enabled: true, app: "ghostty", command: "gt --run {script}" },
        },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      remote: {
        enabled: true,
        token: "tok",
        hubPort: 18377,
        hubHost: "0.0.0.0",
        bridgePort: 18378,
        terminal: { enabled: true, app: "ghostty", command: "gt --run {script}" },
      },
    });
  });

  it("malformed JSON reads as empty", () => {
    writeConfig("{ nope");
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });

  it("non-object JSON (array/scalar) reads as empty", () => {
    writeConfig("[1,2,3]");
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
    writeConfig('"hello"');
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });

  it("drops invalid ports and wrong-typed fields, keeps the valid rest", () => {
    writeConfig(
      JSON.stringify({
        remote: {
          enabled: true,
          hubPort: 99999,
          bridgePort: "not-a-number",
          token: 42, // wrong type → ignored
          hubHost: "", // blank → ignored
          terminal: { app: "  ", enabled: "yes" }, // blank app + wrong type
        },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ remote: { enabled: true } });
  });

  it("a non-object remote section is ignored wholesale", () => {
    writeConfig(JSON.stringify({ remote: "oops" }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });

  it("unknown keys are ignored (forward compatible)", () => {
    writeConfig(JSON.stringify({ remote: { enabled: true, futureField: "x" }, other: 1 }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ remote: { enabled: true } });
  });
});
