/**
 * Remote config parsing — env gate, mandatory token, port/host defaults and
 * fallbacks. parseRemoteConfig takes an explicit env so tests never touch the
 * real process environment.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_HUB_HOST,
  DEFAULT_HUB_PORT,
  parseHubConfig,
  parseRemoteConfig,
} from "../src/remote/config.js";

const BASE_ENV = {
  ZCODE_ACP_REMOTE: "1",
  ZCODE_ACP_REMOTE_TOKEN: "secret",
};

describe("parseRemoteConfig", () => {
  it("is disabled when the gate is unset", () => {
    expect(parseRemoteConfig({})).toBeNull();
  });

  it("is disabled for falsy gate values", () => {
    for (const gate of ["", "0", "false", "off", "nope"]) {
      expect(parseRemoteConfig({ ZCODE_ACP_REMOTE: gate })).toBeNull();
    }
  });

  it("accepts truthy gate spellings", () => {
    for (const gate of ["1", "true", "YES", "on"]) {
      expect(parseRemoteConfig({ ...BASE_ENV, ZCODE_ACP_REMOTE: gate })?.token).toBe("secret");
    }
  });

  it("requires a token when enabled", () => {
    expect(parseRemoteConfig({ ZCODE_ACP_REMOTE: "1" })).toBeNull();
    expect(parseRemoteConfig({ ZCODE_ACP_REMOTE: "1", ZCODE_ACP_REMOTE_TOKEN: "   " })).toBeNull();
  });

  it("applies port and host defaults", () => {
    const config = parseRemoteConfig(BASE_ENV);
    expect(config).toEqual({
      token: "secret",
      hubPort: DEFAULT_HUB_PORT,
      hubHost: DEFAULT_HUB_HOST,
      bridgePort: DEFAULT_BRIDGE_PORT,
    });
  });

  it("falls back on invalid ports", () => {
    const config = parseRemoteConfig({
      ...BASE_ENV,
      ZCODE_ACP_HUB_PORT: "not-a-port",
      ZCODE_ACP_REMOTE_PORT: "99999",
    });
    expect(config?.hubPort).toBe(DEFAULT_HUB_PORT);
    expect(config?.bridgePort).toBe(DEFAULT_BRIDGE_PORT);
  });

  it("honours explicit ports and host", () => {
    const config = parseRemoteConfig({
      ...BASE_ENV,
      ZCODE_ACP_HUB_PORT: "9000",
      ZCODE_ACP_HUB_HOST: "0.0.0.0",
      ZCODE_ACP_REMOTE_PORT: "9001",
    });
    expect(config).toEqual({
      token: "secret",
      hubPort: 9000,
      hubHost: "0.0.0.0",
      bridgePort: 9001,
    });
  });
});

describe("parseHubConfig", () => {
  it("refuses to start without a token", () => {
    expect(parseHubConfig({})).toBeNull();
  });

  it("uses hub host/port from env", () => {
    const config = parseHubConfig({
      ZCODE_ACP_REMOTE_TOKEN: "t",
      ZCODE_ACP_HUB_PORT: "8400",
      ZCODE_ACP_HUB_HOST: "0.0.0.0",
    });
    expect(config?.hubPort).toBe(8400);
    expect(config?.hubHost).toBe("0.0.0.0");
  });
});
