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
//
// The probe is async (an event-loop-freezing spawnSync in the hub stalled WS
// proxying and heartbeats for its full timeout), so the mock speaks execFile's
// callback convention and every test awaits.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { envWithLoginShell, resetLoginShellEnvForTest } from "../src/remote/login-shell-env";

/** An `env -0` answer, as the probe shell would print it. */
function shellEnv(entries: Record<string, string>): Buffer {
  return Buffer.from(
    Object.entries(entries)
      .map(([k, v]) => `${k}=${v}`)
      .join("\0") + "\0",
    "utf8",
  );
}

/** Make the mocked execFile answer successfully (asynchronously). */
function execAnswers(stdout: Buffer): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: unknown, result: { stdout: Buffer; stderr: Buffer }) => void,
    ) => {
      setImmediate(() => cb(null, { stdout, stderr: Buffer.alloc(0) }));
    },
  );
}

/** Make the mocked execFile fail (non-zero exit style: an error to the callback). */
function execFails(message = "shell exited 1"): void {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
      setImmediate(() => cb(new Error(message)));
    },
  );
}

beforeEach(() => {
  resetLoginShellEnvForTest();
  execFileMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetLoginShellEnvForTest();
});

describe("envWithLoginShell", () => {
  test("brings in a var the caller does not have", async () => {
    execAnswers(shellEnv({ PATH: "/opt/mise/shims:/usr/bin:/bin", JAVA_HOME: "/jdk/17" }));
    vi.stubEnv("JAVA_HOME", undefined as unknown as string);

    // The caller passes NO PATH of its own — the realistic editor case, where
    // the bridge inherited launchd's bare environment and has nothing worth
    // keeping. A tool that only exists in the login shell's PATH is now
    // reachable from a process that could not see it before.
    const env = await envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/opt/mise/shims:/usr/bin:/bin");
    expect(env.JAVA_HOME).toBe("/jdk/17");
  });

  test("the caller's own value wins over the shell's, except PATH", async () => {
    execAnswers(shellEnv({ PATH: "/shell/bin", ZCODE_ACP_HUB_PORT: "9999" }));
    const env = await envWithLoginShell({
      PATH: "/caller/bin",
      ZCODE_ACP_HUB_PORT: "7777",
    } as NodeJS.ProcessEnv);
    // PATH is a union (shell first): a bare inherited PATH must never *drop*
    // the toolchain dirs the probe exists to add.
    expect(env.PATH).toBe("/shell/bin:/caller/bin");
    expect(env.ZCODE_ACP_HUB_PORT).toBe("7777");
  });

  test("PATH is unioned, shell entries first, deduped", async () => {
    execAnswers(shellEnv({ PATH: "/mise/shims:/usr/bin:/bin" }));
    const env = await envWithLoginShell({ PATH: "/usr/bin:/opt/editor/bin" } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/mise/shims:/usr/bin:/bin:/opt/editor/bin");
  });

  test("a caller with only a bare launchd PATH still gains the toolchain dirs", async () => {
    // The realistic editor case: the inherited PATH is macOS's bare default and
    // contains no version manager. Caller-wins on PATH would discard the whole
    // point of the probe.
    execAnswers(shellEnv({ PATH: "/mise/shims:/opt/homebrew/bin:/usr/bin:/bin" }));
    const env = await envWithLoginShell({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/mise/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  test("an empty PATH segment is not carried into the union", async () => {
    execAnswers(shellEnv({ PATH: "/shell/bin" }));
    const env = await envWithLoginShell({ PATH: "/caller/bin:" } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/shell/bin:/caller/bin");
  });

  test("process-plumbing vars from the shell never leak into the spawn", async () => {
    // A stale ZCODE_ACP_REMOTE_TOKEN in the user's rc would point a spawned
    // session at the wrong hub; DSH_TUI_* would hijack martty's boot.
    execAnswers(
      shellEnv({
        PATH: "/shell/bin",
        ZCODE_ACP_REMOTE_TOKEN: "stale",
        ZCODE_ACP_REMOTE_ORIGIN: "serve",
        DSH_TUI_STATS: "tokens",
        MARTTY_PASSTHROUGH_ENV: "x",
      }),
    );
    const env = await envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/shell/bin");
    expect(env.ZCODE_ACP_REMOTE_TOKEN).toBeUndefined();
    expect(env.ZCODE_ACP_REMOTE_ORIGIN).toBeUndefined();
    expect(env.DSH_TUI_STATS).toBeUndefined();
    expect(env.MARTTY_PASSTHROUGH_ENV).toBeUndefined();
  });

  test("a plumbing var the CALLER set survives the shell's copy", async () => {
    execAnswers(shellEnv({ ZCODE_ACP_HUB_PORT: "9999", PATH: "/shell/bin" }));
    const env = await envWithLoginShell({ ZCODE_ACP_HUB_PORT: "7777" } as NodeJS.ProcessEnv);
    expect(env.ZCODE_ACP_HUB_PORT).toBe("7777");
  });

  test("cwd-ish vars are never copied", async () => {
    // PWD from the probing shell is the directory the shell happened to start
    // in — carrying it would make the spawn think it is already somewhere else.
    // TMPDIR too: the live process's own temp dir is authoritative (a harness
    // or a launchd plist may set it deliberately), and a shell's copy would
    // send spawned children to a different temp tree than their parent uses.
    execAnswers(
      shellEnv({
        PATH: "/shell/bin",
        PWD: "/tmp/probe",
        SHLVL: "3",
        TMPDIR: "/var/folders/xx/T",
      }),
    );
    const env = await envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/shell/bin");
    expect(env.PWD).toBeUndefined();
    expect(env.SHLVL).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
  });

  test("a shell that fails leaves the caller's env untouched", async () => {
    execFails();
    const caller = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    await expect(envWithLoginShell(caller)).resolves.toEqual({ PATH: "/usr/bin" });
  });

  test("a shell that throws is swallowed, not propagated", async () => {
    // A hang, a missing binary, an EPERM — none of it may break a spawn.
    execFileMock.mockImplementation(() => {
      throw new Error("spawn EPERM");
    });
    const caller = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    await expect(envWithLoginShell(caller)).resolves.toEqual({ PATH: "/usr/bin" });
  });

  test("an empty shell env reads as no completion", async () => {
    execAnswers(shellEnv({}));
    const caller = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    await expect(envWithLoginShell(caller)).resolves.toEqual({ PATH: "/usr/bin" });
  });

  test("values containing a newline survive the NUL framing", async () => {
    // This is why `env -0` and not `env`: a multi-line value (a MOTD-ish var, a
    // script) would otherwise split into two bogus records.
    execAnswers(shellEnv({ PATH: "/shell/bin", MULTI: "line1\nline2" }));
    const env = await envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.MULTI).toBe("line1\nline2");
  });

  test("the shell is probed once, not per call", async () => {
    execAnswers(shellEnv({ PATH: "/shell/bin" }));
    await envWithLoginShell({} as NodeJS.ProcessEnv);
    await envWithLoginShell({} as NodeJS.ProcessEnv);
    await envWithLoginShell({} as NodeJS.ProcessEnv);
    // The hub incubates repeatedly; re-running a login shell each time would
    // add ~200ms to every remote session-create for an unchanging value.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("concurrent callers share ONE in-flight probe", async () => {
    // Two awaits landing while the probe is still running must not start a
    // second shell — the in-flight promise is shared.
    execAnswers(shellEnv({ PATH: "/shell/bin" }));
    const [a, b] = await Promise.all([
      envWithLoginShell({ PATH: "/a/bin" } as NodeJS.ProcessEnv),
      envWithLoginShell({ PATH: "/b/bin" } as NodeJS.ProcessEnv),
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(a.PATH).toBe("/shell/bin:/a/bin");
    expect(b.PATH).toBe("/shell/bin:/b/bin");
  });

  test("the probe is a NON-interactive login shell that sources the rc", async () => {
    execAnswers(shellEnv({ PATH: "/shell/bin" }));
    vi.stubEnv("SHELL", "/bin/zsh");
    await envWithLoginShell({} as NodeJS.ProcessEnv);
    const [shell, args] = execFileMock.mock.calls[0] as [string, string[], unknown, unknown];
    expect(shell).toBe("/bin/zsh");
    // -l for the login profile; the interactive rc that carries the toolchain
    // PATHs is sourced explicitly. Never -i: running interactive-armored
    // machinery inside a live TUI's process tree is what broke the window.
    expect(args[0]).toBe("-l");
    expect(args[1]).toBe("-c");
    expect(args[2]).not.toContain("-i");
    expect(args[2]).toContain(".zshrc");
    expect(args[2]).toContain("env -0");
    expect(args.join(" ")).not.toMatch(/(^|\s)-i($|\s)/);
  });

  test("bash sources its own rc files", async () => {
    execAnswers(shellEnv({ PATH: "/shell/bin" }));
    vi.stubEnv("SHELL", "/bin/bash");
    await envWithLoginShell({} as NodeJS.ProcessEnv);
    const [, args] = execFileMock.mock.calls[0] as [string, string[], unknown, unknown];
    expect(args[2]).toContain(".bashrc");
    expect(args.join(" ")).not.toMatch(/(^|\s)-i($|\s)/);
  });

  test("an unknown shell still dumps its login profile env", async () => {
    execAnswers(shellEnv({ PATH: "/shell/bin" }));
    vi.stubEnv("SHELL", "/bin/fish");
    await envWithLoginShell({} as NodeJS.ProcessEnv);
    const [, args] = execFileMock.mock.calls[0] as [string, string[], unknown, unknown];
    expect(args[2]).toBe("env -0");
  });

  test("stdout noise glued onto the first record is rejected", async () => {
    // A shell whose rc prints to stdout prepends that text to the first record.
    // A name regex rejects `noise\nPATH` instead of installing a garbage var —
    // and the records after it are still read.
    execAnswers(Buffer.from("mise: warning\nPATH=/shell/bin\0JAVA_HOME=/jdk\0", "utf8"));
    const env = await envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(env.JAVA_HOME).toBe("/jdk");
    expect(Object.keys(env).some((k) => k.includes("\n"))).toBe(false);
  });

  test("a failed probe is retried only after the cooldown", async () => {
    // A transient failure (a shell that timed out) must not be remembered as
    // permanent for the life of this long-lived daemon — but it must not be
    // re-paid on EVERY call either: the cooldown holds retries back for 60s.
    vi.useFakeTimers({ toFake: ["Date"] });
    execFails("shell timed out");
    await envWithLoginShell({} as NodeJS.ProcessEnv);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Inside the cooldown: no second shell, env passes through unchanged.
    execAnswers(shellEnv({ PATH: "/shell/bin" }));
    const duringCooldown = await envWithLoginShell({ PATH: "/usr/bin" } as NodeJS.ProcessEnv);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(duringCooldown).toEqual({ PATH: "/usr/bin" });

    // Past the cooldown: the next call probes again and completes.
    vi.setSystemTime(Date.now() + 61_000);
    const env = await envWithLoginShell({ PATH: "/usr/bin" } as NodeJS.ProcessEnv);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(env.PATH).toBe("/shell/bin:/usr/bin");
  });
});
