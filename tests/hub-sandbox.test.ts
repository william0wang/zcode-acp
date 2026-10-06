import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  buildHubRelaunchPlist,
  HUB_LAUNCH_LABEL,
  SANDBOX_ACTIVE_ENV,
  sandboxBorn,
  selfRelaunchOutsideSandbox,
} from "../src/remote/hub-sandbox.js";

describe("hub sandbox self-relaunch", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  // selfRelaunchOutsideSandbox writes real files (mkdtemp plist + sentinel)
  // even with launchctl mocked — leave the machine as we found it.
  afterEach(() => {
    try {
      const sentinel = path.join(tmpdir(), "zcode-hub-relaunch-last");
      const dir = readFileSync(sentinel, "utf8").trim();
      if (dir) rmSync(dir, { recursive: true, force: true });
      rmSync(sentinel, { force: true });
    } catch {
      // nothing was written — nothing to clean
    }
  });

  it("detects the birth marker (darwin only)", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(sandboxBorn({ [SANDBOX_ACTIVE_ENV]: "1" })).toBe(true);
      expect(sandboxBorn({})).toBe(false);
      // The marker alone means nothing where Seatbelt does not exist.
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(sandboxBorn({ [SANDBOX_ACTIVE_ENV]: "1" })).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("builds a plist with the hub argv, the allowlisted env (marker and secrets stripped), and XML escaping", () => {
    const plist = buildHubRelaunchPlist({
      interpreter: ["/usr/bin/node"],
      hubJs: "/opt/acp/dist/bin/hub.js",
      env: {
        ZCODE_ACP_REMOTE_TOKEN: "to&k<'s>",
        [SANDBOX_ACTIVE_ENV]: "1",
        ZCODE_ACP_HUB_PORT: "18377",
        HOME: "/Users/william",
        PATH: "/usr/bin:/bin",
        GITHUB_TOKEN: "ghp_secret_should_not_travel",
        BIFROST_API_KEY: "sk-bf-secret",
        npm_lifecycle_event: "test",
      },
      logPath: "/tmp/hub.log",
    });
    expect(plist).toContain(`<string>${HUB_LAUNCH_LABEL}</string>`);
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>/opt/acp/dist/bin/hub.js</string>");
    expect(plist).toContain("<string>hub</string>");
    expect(plist).toContain("<string>to&amp;k&lt;'s&gt;</string>");
    // The birth marker never travels with the relaunch (no re-trigger loop).
    expect(plist).not.toContain(SANDBOX_ACTIVE_ENV);
    expect(plist).toContain("<string>18377</string>");
    // Identity, paths, locale and ZCODE_* settings survive the allowlist...
    expect(plist).toContain("<string>/Users/william</string>");
    expect(plist).toContain("<string>/usr/bin:/bin</string>");
    // ...shell secrets and build-tool noise never do.
    expect(plist).not.toContain("GITHUB_TOKEN");
    expect(plist).not.toContain("ghp_secret_should_not_travel");
    expect(plist).not.toContain("BIFROST_API_KEY");
    expect(plist).not.toContain("sk-bf-secret");
    expect(plist).not.toContain("npm_lifecycle_event");
    // stdout + stderr both go to the log.
    expect((plist.match(/\/tmp\/hub\.log/g) ?? []).length).toBe(2);
    expect(plist).toContain("<false/>");
  });

  it("self-relaunches: bootstrap then kickstart, plist in a fresh temp dir", () => {
    execFileSyncMock.mockReturnValue(Buffer.alloc(0));
    const ok = selfRelaunchOutsideSandbox({
      interpreter: ["/usr/bin/node"],
      hubJs: "/opt/acp/dist/bin/hub.js",
    });
    expect(ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    const [bootstrapCmd, bootstrapArgs] = execFileSyncMock.mock.calls[0]!;
    expect(bootstrapCmd).toBe("launchctl");
    expect(bootstrapArgs[0]).toBe("bootstrap");
    expect(bootstrapArgs[1]).toMatch(/^gui\/\d+$/);
    expect(String(bootstrapArgs[2])).toMatch(/zcode-hub-relaunch-.*hub\.plist$/);
    // Plain kickstart — the job was JUST loaded from the fresh plist; a -k
    // restart would be meaningless here.
    const [, kickArgs] = execFileSyncMock.mock.calls[1]!;
    expect(kickArgs[0]).toBe("kickstart");
    expect(kickArgs[1]).toBe(`gui/${process.getuid()}/${HUB_LAUNCH_LABEL}`);
    // The on-disk plist carries the hub env (token incl.): owner-only perms,
    // and shell secrets from this worker's env never land in the file.
    const dir = readFileSync(path.join(tmpdir(), "zcode-hub-relaunch-last"), "utf8").trim();
    const plistPath = path.join(dir, "hub.plist");
    expect(statSync(plistPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(plistPath, "utf8")).not.toContain("GITHUB_TOKEN");
  });

  it("swaps a stale definition: bootout the old label, bootstrap the fresh plist", () => {
    // First bootstrap fails (label already loaded from an earlier relaunch);
    // bootout clears it, the retried bootstrap loads the FRESH definition.
    let bootstraps = 0;
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "bootstrap") {
        bootstraps++;
        if (bootstraps === 1) throw new Error("already bootstrapped");
      }
      return Buffer.alloc(0);
    });
    expect(
      selfRelaunchOutsideSandbox({
        interpreter: ["/usr/bin/node"],
        hubJs: "/opt/acp/dist/bin/hub.js",
      }),
    ).toBe(true);
    expect(execFileSyncMock.mock.calls.map((c) => c[1][0])).toEqual([
      "bootstrap",
      "bootout",
      "bootstrap",
      "kickstart",
    ]);
  });

  it("never kickstarts an unreplaced definition, and fails after the retries", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "bootstrap") throw new Error("no gui domain for this user");
      return Buffer.alloc(0);
    });
    expect(
      selfRelaunchOutsideSandbox({
        interpreter: ["/usr/bin/node"],
        hubJs: "/opt/acp/dist/bin/hub.js",
      }),
    ).toBe(false);
    // 3 bootstrap attempts (with bootout between), never a blind kickstart —
    // that would revive the stale job definition.
    expect(execFileSyncMock.mock.calls.filter((c) => c[1][0] === "bootstrap")).toHaveLength(3);
    expect(execFileSyncMock.mock.calls.filter((c) => c[1][0] === "kickstart")).toHaveLength(0);
  });
});
