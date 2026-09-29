/**
 * The global user config loader (~/.config/zcode-acp/config.json): path
 * resolution (XDG aware), best-effort parsing (missing/malformed reads as
 * absent), and per-field validation (invalid values drop with a warn).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

  it("parses the quota section (all credential fields, trimmed)", () => {
    writeConfig(
      JSON.stringify({
        quota: {
          ollamaApiKey: " sk-123 ",
          opencodeGoWorkspaceId: " wrk_x ",
          opencodeGoAuthCookie: " Fe26.2**y ",
        },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      quota: {
        ollamaApiKey: "sk-123",
        opencodeGoWorkspaceId: "wrk_x",
        opencodeGoAuthCookie: "Fe26.2**y",
      },
    });
  });

  it("quota section alongside remote; blank ollamaApiKey dropped", () => {
    writeConfig(JSON.stringify({ remote: { enabled: true }, quota: { ollamaApiKey: "  " } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ remote: { enabled: true } });
  });

  it("non-object quota section is ignored with the remote section intact", () => {
    writeConfig(JSON.stringify({ remote: { enabled: true }, quota: "nope" }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ remote: { enabled: true } });
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
          webDir: "dist", // relative → ignored (hub cwd is unpredictable)
          terminal: { app: "  ", enabled: "yes" }, // blank app + wrong type
        },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ remote: { enabled: true } });
  });

  it("accepts an absolute webDir, trimmed; blank is dropped", () => {
    writeConfig(
      JSON.stringify({
        remote: { enabled: true, webDir: "  /srv/web-dist  ", hubHost: " " },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      remote: { enabled: true, webDir: "/srv/web-dist" },
    });
  });

  it("expands a leading ~ in webDir to the home dir; ~otheruser stays relative", () => {
    writeConfig(
      JSON.stringify({
        remote: { enabled: true, webDir: "  ~/web-dist  " },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      remote: { enabled: true, webDir: path.join(homedir(), "web-dist") },
    });
    writeConfig(JSON.stringify({ remote: { enabled: true, webDir: "~" } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch }).remote?.webDir).toBe(homedir());
    // Only the CURRENT user's home is knowable without a lookup — rejected.
    writeConfig(JSON.stringify({ remote: { enabled: true, webDir: "~root/dist" } }));
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

  it("parses the behavior sections (lang prefix-normalized, sections trimmed)", () => {
    writeConfig(
      JSON.stringify({
        lang: "zh-CN",
        debug: true,
        session: { mode: "plan" },
        autoCompact: { threshold: 240000 },
        goal: { maxTurns: 7, mode: "backend" },
        interaction: { timeoutMs: 0 },
        sandbox: { enabled: true },
        tui: { stats: "tokens,context" },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      lang: "zh",
      debug: true,
      session: { mode: "plan" },
      autoCompact: { threshold: 240000 },
      goal: { maxTurns: 7, mode: "backend" },
      interaction: { timeoutMs: 0 },
      sandbox: { enabled: true },
      tui: { stats: "tokens,context" },
    });
  });

  it("accepts an empty tui.stats (hide the dock) but drops non-strings", () => {
    writeConfig(JSON.stringify({ tui: { stats: "" } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ tui: { stats: "" } });
    writeConfig(JSON.stringify({ tui: { stats: 7 } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });

  it("drops every invalid behavior value, keeps valid siblings", () => {
    writeConfig(
      JSON.stringify({
        lang: "fr",
        debug: "yes",
        session: { mode: "wat" },
        autoCompact: { threshold: -3 },
        goal: { maxTurns: 0, mode: "driver" },
        interaction: { timeoutMs: -1 },
        sandbox: { enabled: 1 },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({});
  });

  it("non-object sections and empty shells read as absent (sandbox false survives)", () => {
    writeConfig(
      JSON.stringify({
        session: "oops",
        goal: [],
        autoCompact: {},
        interaction: { timeoutMs: 1.5 }, // non-integer → dropped → empty shell
        sandbox: { enabled: false }, // explicit false is a VALUE, not a shell
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ sandbox: { enabled: false } });
  });

  it("parses the push section incl. the relay sub-section (trimmed, blanks dropped)", () => {
    writeConfig(
      JSON.stringify({
        push: {
          enabled: true,
          corpId: " ww-corp ",
          agentId: 1000009,
          secret: " s ",
          toUser: " william ",
          contentDetail: "minimal",
          relay: { url: " https://relay.example.com/wecom/ ", token: " relay-tok ", junk: 1 },
        },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      push: {
        enabled: true,
        corpId: "ww-corp",
        agentId: 1000009,
        secret: "s",
        toUser: "william",
        contentDetail: "minimal",
        relay: { url: "https://relay.example.com/wecom/", token: "relay-tok" },
      },
    });
  });

  it("non-object push.relay drops with the rest of push intact", () => {
    writeConfig(JSON.stringify({ push: { enabled: true, relay: "junk" } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ push: { enabled: true } });
  });

  it("parses push.notify switches; non-booleans drop, siblings survive", () => {
    writeConfig(
      JSON.stringify({
        push: { enabled: true, notify: { turn: false, goal: true, run: "yes", task: false } },
      }),
    );
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({
      push: { enabled: true, notify: { turn: false, goal: true, task: false } },
    });
    writeConfig(JSON.stringify({ push: { enabled: true, notify: "junk" } }));
    expect(loadUserConfig({ XDG_CONFIG_HOME: scratch })).toEqual({ push: { enabled: true } });
  });
});
