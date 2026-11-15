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

import { DEFAULT_HUB_PORT, parseRemoteConfig, remoteEnabledLive } from "../src/remote/config.js";

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
  it("requires a token when enabled", () => {
    expect(parseRemoteConfig(env({ ZCODE_ACP_REMOTE: "1" }))).toBeNull();
    expect(
      parseRemoteConfig(env({ ZCODE_ACP_REMOTE: "1", ZCODE_ACP_REMOTE_TOKEN: "   " })),
    ).toBeNull();
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
        webDir: "/srv/file-dist",
      },
    });
    const config = parseRemoteConfig(
      env({
        ...BASE_ENV,
        ZCODE_ACP_HUB_PORT: "9000",
        ZCODE_ACP_HUB_HOST: "0.0.0.0",
        ZCODE_ACP_REMOTE_PORT: "9003",
        ZCODE_ACP_WEB_DIR: "/srv/env-dist",
      }),
    );
    expect(config).toEqual({
      token: "filetok",
      hubPort: 9001,
      hubHost: "10.0.0.1",
      bridgePort: 9002,
      webDir: "/srv/file-dist",
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

describe("remoteEnabledLive (hub idle stay-alive check)", () => {
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
