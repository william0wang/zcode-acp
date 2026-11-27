/**
 * The global user config loader (~/.config/zcode-acp/config.json): path
 * resolution (XDG aware), best-effort parsing (missing/malformed reads as
 * absent), and per-field validation (invalid values drop with a warn).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hardDeleteArmed, loadUserConfig, projectMemoryEnabled } from "../src/config/user-config.js";

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

describe("loadUserConfig", () => {
  it("validates the session pin preference (boolean only)", () => {
    writeConfig(JSON.stringify({ session: { pinDefaultModel: false } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      session: { pinDefaultModel: false },
    });
    writeConfig(JSON.stringify({ session: { pinDefaultModel: "false" } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });

  it("validates the default thought level (non-empty string only)", () => {
    writeConfig(JSON.stringify({ session: { defaultThoughtLevel: " high " } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      session: { defaultThoughtLevel: "high" },
    });
    writeConfig(JSON.stringify({ session: { defaultThoughtLevel: "   " } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
    writeConfig(JSON.stringify({ session: { defaultThoughtLevel: 3 } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });

  it("malformed JSON reads as empty", () => {
    writeConfig("{ nope");
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
          webDir: "dist", // relative → ignored (hub cwd is unpredictable)
          terminal: { app: "  ", enabled: "yes" }, // blank app + wrong type
        },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ remote: { enabled: true } });
  });

  it("unknown keys are ignored (forward compatible)", () => {
    writeConfig(JSON.stringify({ remote: { enabled: true, futureField: "x" }, other: 1 }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ remote: { enabled: true } });
  });

  it("validates the subagents background posture (boolean only)", () => {
    writeConfig(JSON.stringify({ subagents: { alwaysBackground: false } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      subagents: { alwaysBackground: false },
    });
    writeConfig(JSON.stringify({ subagents: { alwaysBackground: "true" } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });

  it("validates the memory opt-in (boolean only)", () => {
    writeConfig(JSON.stringify({ memory: { enabled: true } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      memory: { enabled: true },
    });
    writeConfig(JSON.stringify({ memory: { enabled: "yes" } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });
});

describe("hardDeleteArmed", () => {
  it("config file wins, env is the fallback, default false", () => {
    // No file, no env — disarmed.
    expect(hardDeleteArmed({ XDG_CONFIG_HOME: scratch })).toBe(false);

    // Env arms it (file absent).
    expect(hardDeleteArmed({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_DELETE_PURGE: "1" })).toBe(true);
    expect(hardDeleteArmed({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_DELETE_PURGE: "true" })).toBe(
      true,
    );
    expect(hardDeleteArmed({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_DELETE_PURGE: "0" })).toBe(false);

    // The file outranks the env in BOTH directions.
    writeConfig(JSON.stringify({ delete: { purge: true } }));
    expect(hardDeleteArmed({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_DELETE_PURGE: "0" })).toBe(true);
    writeConfig(JSON.stringify({ delete: { purge: false } }));
    expect(hardDeleteArmed({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_DELETE_PURGE: "1" })).toBe(false);
  });
});

describe("projectMemoryEnabled", () => {
  it("config file wins, env is the fallback, default false (#423)", () => {
    // No file, no env — off (the desktop's own posture decides nothing here;
    // an editor bridge must not change every session's prompt uninvited).
    expect(projectMemoryEnabled({ XDG_CONFIG_HOME: scratch })).toBe(false);

    // Env opts in (file absent).
    expect(projectMemoryEnabled({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_MEMORY_ENABLED: "1" })).toBe(
      true,
    );
    expect(
      projectMemoryEnabled({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_MEMORY_ENABLED: "true" }),
    ).toBe(true);
    expect(projectMemoryEnabled({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_MEMORY_ENABLED: "0" })).toBe(
      false,
    );

    // The file outranks the env in BOTH directions.
    writeConfig(JSON.stringify({ memory: { enabled: true } }));
    expect(projectMemoryEnabled({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_MEMORY_ENABLED: "0" })).toBe(
      true,
    );
    writeConfig(JSON.stringify({ memory: { enabled: false } }));
    expect(projectMemoryEnabled({ XDG_CONFIG_HOME: scratch, ZCODE_ACP_MEMORY_ENABLED: "1" })).toBe(
      false,
    );
  });
});
