// @vitest-environment node
// Login-shell environment completion for remotely-spawned processes.
//
// The bug these pin down: a bridge started from an editor GUI inherits
// launchd's environment — a bare PATH with no version managers in it. The hub
// is spawned by that bridge and is detached, so it inherits the same, and every
// process it spawns (a terminal TUI window, a serve bridge, the zcode backend)
// inherits it again. A session opened from a phone then cannot find `pnpm`,
// `cargo` or `java` even though the same command works in the user's terminal.
//
// The observable symptom is a bare "command not found" from a tool that is
// plainly installed, which is why nothing in the bridge reports an error.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import { envWithLoginShell, resetLoginShellEnvForTest } from "../src/remote/login-shell-env";

/** A `zsh -ilc 'env -0'` answer, as the shell would print it. */
function shellEnv(entries: Record<string, string>): Buffer {
  return Buffer.from(
    Object.entries(entries)
      .map(([k, v]) => `${k}=${v}`)
      .join("\0") + "\0",
    "utf8",
  );
}

beforeEach(() => {
  resetLoginShellEnvForTest();
  spawnSyncMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLoginShellEnvForTest();
});

describe("envWithLoginShell", () => {
  test("brings in a var the caller does not have", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: shellEnv({ PATH: "/opt/mise/shims:/usr/bin:/bin", JAVA_HOME: "/jdk/17" }),
    });
    vi.stubEnv("JAVA_HOME", undefined as unknown as string);

    // The caller passes NO PATH of its own — the realistic editor case, where
    // the bridge inherited launchd's bare environment and has nothing worth
    // keeping. A tool that only exists in the login shell's PATH is now
    // reachable from a process that could not see it before.
    const env = envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/opt/mise/shims:/usr/bin:/bin");
    expect(env.JAVA_HOME).toBe("/jdk/17");
  });

  test("the caller's own value always wins over the shell's", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: shellEnv({ PATH: "/shell/bin", ZCODE_ACP_HUB_PORT: "9999" }),
    });
    const env = envWithLoginShell({
      PATH: "/caller/bin",
      ZCODE_ACP_HUB_PORT: "7777",
    } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/caller/bin");
    expect(env.ZCODE_ACP_HUB_PORT).toBe("7777");
  });

  test("process-plumbing vars from the shell never leak into the spawn", () => {
    // A stale ZCODE_ACP_REMOTE_TOKEN in the user's rc would point a spawned
    // session at the wrong hub; DSH_TUI_* would hijack martty's boot.
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: shellEnv({
        PATH: "/shell/bin",
        ZCODE_ACP_REMOTE_TOKEN: "stale",
        ZCODE_ACP_REMOTE_ORIGIN: "serve",
        DSH_TUI_STATS: "tokens",
        MARTTY_PASSTHROUGH_ENV: "x",
      }),
    });
    const env = envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/shell/bin");
    expect(env.ZCODE_ACP_REMOTE_TOKEN).toBeUndefined();
    expect(env.ZCODE_ACP_REMOTE_ORIGIN).toBeUndefined();
    expect(env.DSH_TUI_STATS).toBeUndefined();
    expect(env.MARTTY_PASSTHROUGH_ENV).toBeUndefined();
  });

  test("a plumbing var the CALLER set survives the shell's copy", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: shellEnv({ ZCODE_ACP_HUB_PORT: "9999", PATH: "/shell/bin" }),
    });
    const env = envWithLoginShell({ ZCODE_ACP_HUB_PORT: "7777" } as NodeJS.ProcessEnv);
    expect(env.ZCODE_ACP_HUB_PORT).toBe("7777");
  });

  test("cwd-ish vars are never copied", () => {
    // PWD from the probing shell is the directory the shell happened to start
    // in — carrying it would make the spawn think it is already somewhere else.
    // TMPDIR too: the live process's own temp dir is authoritative (a harness
    // or a launchd plist may set it deliberately), and a shell's copy would
    // send spawned children to a different temp tree than their parent uses.
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: shellEnv({
        PATH: "/shell/bin",
        PWD: "/tmp/probe",
        SHLVL: "3",
        TMPDIR: "/var/folders/xx/T",
      }),
    });
    const env = envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/shell/bin");
    expect(env.PWD).toBeUndefined();
    expect(env.SHLVL).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
  });

  test("a shell that fails leaves the caller's env untouched", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: Buffer.alloc(0) });
    const caller = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    expect(envWithLoginShell(caller)).toEqual({ PATH: "/usr/bin" });
  });

  test("a shell that throws is swallowed, not propagated", () => {
    // A hang, a missing binary, an EPERM — none of it may break a spawn.
    spawnSyncMock.mockImplementation(() => {
      throw new Error("spawn EPERM");
    });
    const caller = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    expect(() => envWithLoginShell(caller)).not.toThrow();
    expect(envWithLoginShell(caller)).toEqual({ PATH: "/usr/bin" });
  });

  test("an empty shell env reads as no completion", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: shellEnv({}) });
    const caller = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    expect(envWithLoginShell(caller)).toEqual({ PATH: "/usr/bin" });
  });

  test("values containing a newline survive the NUL framing", () => {
    // This is why `env -0` and not `env`: a multi-line value (a MOTD-ish var, a
    // script) would otherwise split into two bogus records.
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: shellEnv({ PATH: "/shell/bin", MULTI: "line1\nline2" }),
    });
    const env = envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.MULTI).toBe("line1\nline2");
  });

  test("the shell is probed once, not per call", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: shellEnv({ PATH: "/shell/bin" }) });
    envWithLoginShell({} as NodeJS.ProcessEnv);
    envWithLoginShell({} as NodeJS.ProcessEnv);
    envWithLoginShell({} as NodeJS.ProcessEnv);
    // The hub incubates repeatedly; re-running a login shell each time would
    // add ~200ms to every remote session-create for an unchanging value.
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  test("the probe uses an interactive login shell", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: shellEnv({ PATH: "/shell/bin" }) });
    vi.stubEnv("SHELL", "/bin/zsh");
    envWithLoginShell({} as NodeJS.ProcessEnv);
    const [shell, args] = spawnSyncMock.mock.calls[0] as [string, string[]];
    expect(shell).toBe("/bin/zsh");
    // -i sources the rc file (where mise/nvm install their PATH), -l the profile.
    expect(args).toEqual(["-ilc", "env -0"]);
  });

  test("a failed probe is retried on the next call", () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0) });
    envWithLoginShell({} as NodeJS.ProcessEnv);
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: shellEnv({ PATH: "/shell/bin" }) });
    // A transient failure (a shell that timed out) must not be remembered as
    // permanent for the life of this long-lived daemon.
    const env = envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/shell/bin");
  });
});
