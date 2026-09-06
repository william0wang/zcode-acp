/**
 * Remote config parsing — file-first precedence (config file > env > default),
 * mandatory token, port/host defaults and fallbacks. parseRemoteConfig takes
 * an explicit env so tests never touch the real process environment; every
 * env carries an XDG_CONFIG_HOME scratch dir so tests never read the
 * developer's real ~/.config/zcode-acp/config.json either.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_HUB_HOST,
  DEFAULT_HUB_PORT,
  parseHubConfig,
  parseRemoteConfig,
  remoteEnabledLive,
  remoteTerminalPrefs,
} from "../src/remote/config.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "zacp-cfg-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Hermetic env: XDG pointed at the scratch dir, plus optional extras. */
function env(extra: Record<string, string> = {}): Record<string, string> {
  return { XDG_CONFIG_HOME: scratch, ...extra };
}

/** Write a config file under the scratch XDG root. */
function writeConfig(json: unknown): void {
  mkdirSync(path.join(scratch, "zcode-acp"), { recursive: true });
  writeFileSync(path.join(scratch, "zcode-acp", "config.json"), JSON.stringify(json));
}

function writeRawConfig(text: string): void {
  mkdirSync(path.join(scratch, "zcode-acp"), { recursive: true });
  writeFileSync(path.join(scratch, "zcode-acp", "config.json"), text);
}

const BASE_ENV = {
  ZCODE_ACP_REMOTE: "1",
  ZCODE_ACP_REMOTE_TOKEN: "secret",
};

describe("parseRemoteConfig (env fallback — no config file)", () => {
  it("is disabled when the gate is unset", () => {
    expect(parseRemoteConfig(env())).toBeNull();
  });

  it("is disabled for falsy gate values", () => {
    for (const gate of ["", "0", "false", "off", "nope"]) {
      expect(parseRemoteConfig(env({ ZCODE_ACP_REMOTE: gate }))).toBeNull();
    }
  });

  it("accepts truthy gate spellings", () => {
    for (const gate of ["1", "true", "YES", "on"]) {
      expect(parseRemoteConfig(env({ ...BASE_ENV, ZCODE_ACP_REMOTE: gate }))?.token).toBe("secret");
    }
  });

  it("requires a token when enabled", () => {
    expect(parseRemoteConfig(env({ ZCODE_ACP_REMOTE: "1" }))).toBeNull();
    expect(
      parseRemoteConfig(env({ ZCODE_ACP_REMOTE: "1", ZCODE_ACP_REMOTE_TOKEN: "   " })),
    ).toBeNull();
  });

  it("applies port and host defaults", () => {
    const config = parseRemoteConfig(env(BASE_ENV));
    expect(config).toEqual({
      token: "secret",
      hubPort: DEFAULT_HUB_PORT,
      hubHost: DEFAULT_HUB_HOST,
      bridgePort: DEFAULT_BRIDGE_PORT,
      origin: "editor",
      pinCwd: false,
    });
  });

  it("falls back on invalid ports", () => {
    const config = parseRemoteConfig(
      env({
        ...BASE_ENV,
        ZCODE_ACP_HUB_PORT: "not-a-port",
        ZCODE_ACP_REMOTE_PORT: "99999",
      }),
    );
    expect(config?.hubPort).toBe(DEFAULT_HUB_PORT);
    expect(config?.bridgePort).toBe(DEFAULT_BRIDGE_PORT);
  });

  it("honours explicit ports and host", () => {
    const config = parseRemoteConfig(
      env({
        ...BASE_ENV,
        ZCODE_ACP_HUB_PORT: "9000",
        ZCODE_ACP_HUB_HOST: "0.0.0.0",
        ZCODE_ACP_REMOTE_PORT: "9001",
      }),
    );
    expect(config).toEqual({
      token: "secret",
      hubPort: 9000,
      hubHost: "0.0.0.0",
      bridgePort: 9001,
      origin: "editor",
      pinCwd: false,
    });
  });

  it("reads the hub-incubation overrides (origin, cwd pin) — ADR-0016", () => {
    // A hub-incubated terminal REPL registers as the project's serve bridge
    // and pins its session roots to the process cwd. These are per-process
    // role flags — env only, never file-configurable.
    const config = parseRemoteConfig(
      env({
        ...BASE_ENV,
        ZCODE_ACP_REMOTE_ORIGIN: "serve",
        ZCODE_ACP_REMOTE_PIN_CWD: "1",
      }),
    );
    expect(config?.origin).toBe("serve");
    expect(config?.pinCwd).toBe(true);
    const loose = parseRemoteConfig(env({ ...BASE_ENV, ZCODE_ACP_REMOTE_ORIGIN: "editor" }));
    expect(loose?.origin).toBe("editor");
    expect(loose?.pinCwd).toBe(false);
  });
});

describe("parseRemoteConfig (config file > env)", () => {
  it("enables remote with no env at all — the launch-context-independent path", () => {
    writeConfig({ remote: { enabled: true, token: "filetok" } });
    const config = parseRemoteConfig(env());
    expect(config?.token).toBe("filetok");
    expect(config?.hubPort).toBe(DEFAULT_HUB_PORT);
  });

  it("the file wins over env for every field it sets", () => {
    writeConfig({
      remote: {
        enabled: true,
        token: "filetok",
        hubPort: 9001,
        hubHost: "10.0.0.1",
        bridgePort: 9002,
      },
    });
    const config = parseRemoteConfig(
      env({
        ...BASE_ENV,
        ZCODE_ACP_HUB_PORT: "9000",
        ZCODE_ACP_HUB_HOST: "0.0.0.0",
        ZCODE_ACP_REMOTE_PORT: "9003",
      }),
    );
    expect(config).toEqual({
      token: "filetok",
      hubPort: 9001,
      hubHost: "10.0.0.1",
      bridgePort: 9002,
      origin: "editor",
      pinCwd: false,
    });
  });

  it("env fills the fields the file leaves unset", () => {
    writeConfig({ remote: { enabled: true } });
    const config = parseRemoteConfig(env({ ...BASE_ENV, ZCODE_ACP_HUB_PORT: "9000" }));
    expect(config?.token).toBe("secret");
    expect(config?.hubPort).toBe(9000);
  });

  it("an explicit enabled:false in the file disables remote even with env =1", () => {
    writeConfig({ remote: { enabled: false } });
    expect(parseRemoteConfig(env(BASE_ENV))).toBeNull();
  });

  it("a malformed file warns and reads as absent — env keeps working", () => {
    writeRawConfig("{ not json");
    const config = parseRemoteConfig(env(BASE_ENV));
    expect(config?.token).toBe("secret");
  });

  it("a file token enables remote even when env has none", () => {
    writeConfig({ remote: { enabled: true, token: "filetok" } });
    const config = parseRemoteConfig(env({ ZCODE_ACP_HUB_PORT: "8500" }));
    expect(config?.token).toBe("filetok");
    expect(config?.hubPort).toBe(8500);
  });
});

describe("parseHubConfig", () => {
  it("refuses to start without a token", () => {
    expect(parseHubConfig(env())).toBeNull();
  });

  it("uses hub host/port from env", () => {
    const config = parseHubConfig(
      env({
        ZCODE_ACP_REMOTE_TOKEN: "t",
        ZCODE_ACP_HUB_PORT: "8400",
        ZCODE_ACP_HUB_HOST: "0.0.0.0",
      }),
    );
    expect(config?.hubPort).toBe(8400);
    expect(config?.hubHost).toBe("0.0.0.0");
  });

  it("reads token and ports from the config file (GUI-born hub path)", () => {
    // The hub is spawned by whichever bridge needs it; without a file its
    // birth env may carry no remote config at all.
    writeConfig({ remote: { token: "hubtok", hubPort: 8500 } });
    const config = parseHubConfig(env());
    expect(config?.token).toBe("hubtok");
    expect(config?.hubPort).toBe(8500);
  });
});

describe("remoteTerminalPrefs (file > env, live-read)", () => {
  it("defaults to enabled with no app or command", () => {
    expect(remoteTerminalPrefs(env())).toEqual({ enabled: true });
  });

  it("reads the legacy env vars when no file exists", () => {
    const prefs = remoteTerminalPrefs(
      env({ ZCODE_ACP_HUB_TERMINAL_APP: "iTerm", ZCODE_ACP_HUB_TERMINAL_COMMAND: "" }),
    );
    expect(prefs).toEqual({ enabled: true, app: "iTerm" });
  });

  it("the env gate disables incubation when the file is silent", () => {
    expect(remoteTerminalPrefs(env({ ZCODE_ACP_HUB_TERMINAL: "0" })).enabled).toBe(false);
  });

  it("the file wins: app/command/enabled override env", () => {
    writeConfig({
      remote: { terminal: { app: "ghostty", enabled: false } },
    });
    const prefs = remoteTerminalPrefs(
      env({ ZCODE_ACP_HUB_TERMINAL_APP: "iTerm", ZCODE_ACP_HUB_TERMINAL: "1" }),
    );
    expect(prefs).toEqual({ enabled: false, app: "ghostty" });
  });

  it("the file command beats the file app", () => {
    writeConfig({
      remote: { terminal: { app: "iTerm", command: "my-term {script}" } },
    });
    expect(remoteTerminalPrefs(env())).toEqual({
      enabled: true,
      app: "iTerm",
      command: "my-term {script}",
    });
  });
});

describe("remoteEnabledLive (hub idle stay-alive check)", () => {
  it("follows the env with no config file", () => {
    expect(remoteEnabledLive(env(BASE_ENV))).toBe(true);
    expect(remoteEnabledLive(env({ ...BASE_ENV, ZCODE_ACP_REMOTE: "0" }))).toBe(false);
    expect(remoteEnabledLive(env())).toBe(false);
  });

  it("an explicit file `enabled` wins over env (both directions)", () => {
    writeConfig({ remote: { enabled: false } });
    expect(remoteEnabledLive(env(BASE_ENV))).toBe(false);
    writeConfig({ remote: { enabled: true } });
    expect(remoteEnabledLive(env({ ...BASE_ENV, ZCODE_ACP_REMOTE: "0" }))).toBe(true);
  });

  it("a malformed config file reads as absent (env decides)", () => {
    writeRawConfig("not json");
    expect(remoteEnabledLive(env(BASE_ENV))).toBe(true);
    expect(remoteEnabledLive(env({ ...BASE_ENV, ZCODE_ACP_REMOTE: "0" }))).toBe(false);
  });
});
