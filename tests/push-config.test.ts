/**
 * Push config resolution (push-backend-requirements §8): file-over-env merge,
 * the remoteEnabledLive truthy set, and the credential-completeness gate that
 * keeps an enabled-but-incomplete setup inactive with ONE warning.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The user config file is served from memory; every other read falls through
// to the real fs (hermetic HOME, so the real path does not exist).
const { fakeFile } = vi.hoisted(() => ({ fakeFile: { content: null as string | null } }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string, ...rest: unknown[]) => {
      if (fakeFile.content !== null && String(p).endsWith("zcode-acp/config.json")) {
        return fakeFile.content;
      }
      return (actual.readFileSync as unknown as (p: string, ...r: unknown[]) => string)(p, ...rest);
    },
  };
});

const { resolvePushConfig } = await import("../src/push/config.js");

const FULL_ENV = {
  ZCODE_ACP_PUSH_ENABLED: "1",
  ZCODE_ACP_PUSH_CORP_ID: "ww-corp",
  ZCODE_ACP_PUSH_AGENT_ID: "1000002",
  ZCODE_ACP_PUSH_SECRET: "s3cret",
};

beforeEach(() => {
  fakeFile.content = null;
});

describe("resolvePushConfig", () => {
  it("resolves an env-only setup with defaults", () => {
    const cfg = resolvePushConfig(FULL_ENV);
    expect(cfg).toEqual({
      corpId: "ww-corp",
      agentId: 1000002,
      secret: "s3cret",
      toUser: "@all",
      contentDetail: "full",
      notify: { turn: true, goal: true, run: true, task: true, compact: true, ask: true },
      quietMs: 30_000,
      askDelayMs: 120_000,
    });
  });

  it("stays inactive when not enabled, even with full credentials", () => {
    const { ZCODE_ACP_PUSH_ENABLED: _drop, ...rest } = FULL_ENV;
    expect(resolvePushConfig(rest)).toBeNull();
    expect(resolvePushConfig({ ...FULL_ENV, ZCODE_ACP_PUSH_ENABLED: "0" })).toBeNull();
    expect(resolvePushConfig({ ...FULL_ENV, ZCODE_ACP_PUSH_ENABLED: "yes???" })).toBeNull();
  });

  it("accepts the remoteEnabledLive truthy spellings", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
      expect(resolvePushConfig({ ...FULL_ENV, ZCODE_ACP_PUSH_ENABLED: v })).not.toBeNull();
    }
  });

  it("goes inactive with one warning when credentials are incomplete", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(resolvePushConfig({ ...FULL_ENV, ZCODE_ACP_PUSH_SECRET: "" })).toBeNull();
      expect(resolvePushConfig({ ...FULL_ENV, ZCODE_ACP_PUSH_AGENT_ID: "junk" })).toBeNull();
      expect(resolvePushConfig({ ...FULL_ENV, ZCODE_ACP_PUSH_CORP_ID: "" })).toBeNull();
      const warnings = err.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("push:"));
      // exactly one distinct warning message, three occurrences of it
      expect(new Set(warnings).size).toBe(1);
      expect(warnings.length).toBe(3);
    } finally {
      err.mockRestore();
    }
  });

  it("lets the config file override env and carry every field", () => {
    fakeFile.content = JSON.stringify({
      push: {
        enabled: true,
        corpId: "ww-file",
        agentId: 42,
        secret: "file-secret",
        toUser: "william",
        contentDetail: "minimal",
      },
    });
    const cfg = resolvePushConfig({
      ZCODE_ACP_PUSH_ENABLED: "0", // file wins
      ZCODE_ACP_PUSH_CORP_ID: "ww-env",
      ZCODE_ACP_PUSH_SECRET: "env-secret",
    });
    expect(cfg).toEqual({
      corpId: "ww-file",
      agentId: 42,
      secret: "file-secret",
      toUser: "william",
      contentDetail: "minimal",
      notify: { turn: true, goal: true, run: true, task: true, compact: true, ask: true },
      quietMs: 30_000,
      askDelayMs: 120_000,
    });
  });

  it("resolves quietMs from the file; 0 keeps the window off, junk falls back", () => {
    fakeFile.content = JSON.stringify({
      push: {
        enabled: true,
        corpId: "ww-file",
        agentId: 42,
        secret: "file-secret",
        quietMs: 5000,
      },
    });
    expect(resolvePushConfig({})?.quietMs).toBe(5000);

    fakeFile.content = JSON.stringify({
      push: {
        enabled: true,
        corpId: "ww-file",
        agentId: 42,
        secret: "file-secret",
        quietMs: 0,
      },
    });
    expect(resolvePushConfig({})?.quietMs).toBe(0);

    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      fakeFile.content = JSON.stringify({
        push: {
          enabled: true,
          corpId: "ww-file",
          agentId: 42,
          secret: "file-secret",
          quietMs: "soon",
        },
      });
      expect(resolvePushConfig({})?.quietMs).toBe(30_000);
    } finally {
      err.mockRestore();
    }
  });

  it("defaults every notify kind ON; the file switches them individually", () => {
    fakeFile.content = JSON.stringify({
      push: {
        enabled: true,
        corpId: "ww-file",
        agentId: 42,
        secret: "file-secret",
        notify: { turn: false, compact: false, ask: false },
      },
    });
    const cfg = resolvePushConfig({});
    expect(cfg?.notify).toEqual({
      turn: false,
      goal: true,
      run: true,
      task: true,
      compact: false,
      ask: false,
    });
  });

  it("resolves askDelayMs from the file; 0 keeps the watchdog immediate, junk falls back", () => {
    fakeFile.content = JSON.stringify({
      push: {
        enabled: true,
        corpId: "ww-file",
        agentId: 42,
        secret: "file-secret",
        askDelayMs: 5000,
      },
    });
    expect(resolvePushConfig({})?.askDelayMs).toBe(5000);

    fakeFile.content = JSON.stringify({
      push: { enabled: true, corpId: "ww-file", agentId: 42, secret: "file-secret", askDelayMs: 0 },
    });
    expect(resolvePushConfig({})?.askDelayMs).toBe(0);

    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      fakeFile.content = JSON.stringify({
        push: {
          enabled: true,
          corpId: "ww-file",
          agentId: 42,
          secret: "file-secret",
          askDelayMs: -5,
        },
      });
      expect(resolvePushConfig({})?.askDelayMs).toBe(120_000);
    } finally {
      err.mockRestore();
    }
  });

  it("lets env fill fields the file leaves out", () => {
    fakeFile.content = JSON.stringify({ push: { enabled: true, corpId: "ww-file" } });
    const cfg = resolvePushConfig({
      ZCODE_ACP_PUSH_AGENT_ID: "7",
      ZCODE_ACP_PUSH_SECRET: "env-secret",
    });
    expect(cfg).toMatchObject({ corpId: "ww-file", agentId: 7, secret: "env-secret" });
  });

  it("resolves the relay from env with trailing slashes stripped", () => {
    const cfg = resolvePushConfig({
      ...FULL_ENV,
      ZCODE_ACP_PUSH_RELAY_URL: " https://relay.example.com/wecom/ ",
      ZCODE_ACP_PUSH_RELAY_TOKEN: " relay-tok ",
    });
    expect(cfg?.relay).toEqual({ url: "https://relay.example.com/wecom", token: "relay-tok" });
  });

  it("carries the file relay over env (slash-stripped too)", () => {
    fakeFile.content = JSON.stringify({
      push: {
        enabled: true,
        corpId: "ww-file",
        agentId: 42,
        secret: "file-secret",
        relay: { url: "https://r.example.com/x/", token: "file-tok" },
      },
    });
    const cfg = resolvePushConfig({
      ZCODE_ACP_PUSH_RELAY_URL: "https://env-relay.example.com",
      ZCODE_ACP_PUSH_RELAY_TOKEN: "env-tok",
    });
    expect(cfg?.relay).toEqual({ url: "https://r.example.com/x", token: "file-tok" });
  });

  it("warns and pushes direct when only half the relay is present", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const halfUrl = resolvePushConfig({
        ...FULL_ENV,
        ZCODE_ACP_PUSH_RELAY_URL: "https://relay.example.com/w",
      });
      expect(halfUrl?.relay).toBeUndefined();
      const halfToken = resolvePushConfig({ ...FULL_ENV, ZCODE_ACP_PUSH_RELAY_TOKEN: "tok" });
      expect(halfToken?.relay).toBeUndefined();
      const warnings = err.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("relay needs BOTH"));
      expect(warnings.length).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("ignores a non-object push section (loader posture)", () => {
    fakeFile.content = JSON.stringify({ push: "junk" });
    expect(resolvePushConfig(FULL_ENV)).not.toBeNull(); // env fallback keeps it alive
  });
});
