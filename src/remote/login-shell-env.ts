/**
 * Login-shell environment completion for remotely-spawned processes.
 *
 * A bridge started from an editor (Zed, JetBrains) inherits launchd's
 * environment — a bare PATH with no version managers in it. The hub is a
 * detached daemon spawned by that bridge, so it inherits the same, and every
 * process IT spawns (a terminal TUI window, a serve bridge, the zcode backend)
 * inherits it again. The result is that a session opened from a phone cannot
 * find `pnpm`, `cargo`, `java` or anything else the user's interactive shell
 * provides, even though the same command works perfectly in a terminal.
 *
 * The fix is to ask a LOGIN shell for its environment once and cache it: a
 * login shell sources the user's rc files, which is where mise/nvm/homebrew/rbenv
 * install their PATH entries. `zsh -ilc 'env -0'` prints that environment
 * NUL-separated, which is the only format that survives a value containing a
 * newline.
 *
 * The cache is deliberately process-wide and lazily filled: the hub is
 * long-lived (it idle-exits after ~10 min but is re-spawned for the next
 * session), and re-running a shell per incubation would add ~200ms to every
 * remote session-create for a value that cannot change without the user
 * editing their rc.
 *
 * Failure is silent and non-fatal: a machine with no `zsh`, a shell that hangs,
 * or a user with no rc files all fall back to the inherited environment, which
 * is exactly today's behaviour. Nothing here may throw.
 */

import { spawnSync } from "node:child_process";
import { log, warn } from "../utils.js";

/** Vars we never take from the login shell — they are per-process plumbing. */
const PINNED_PREFIXES = ["ZCODE_ACP_", "DSH_TUI_", "MARTTY_"] as const;

/**
 * Never copy these even if the login shell sets them.
 *
 * `PWD`/`OLDPWD`/`SHLVL` describe the probing shell's own session. `TMPDIR` is
 * here too: the live process's own temp dir is authoritative (a test harness or
 * a launchd-plist may set it deliberately), and a shell's copy would point
 * spawned children at a different temp tree than their parent uses.
 */
const NEVER_COPY = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TMPDIR", "SHELL"]);

let cached: NodeJS.ProcessEnv | null = null;

/**
 * The login shell's environment, or null when it cannot be obtained.
 *
 * Only the "additive" part is returned: variables the login shell has that the
 * caller does not. A login shell also carries the ambient session's own values
 * (e.g. a stale `SSH_AUTH_SOCK` from whoever ran it), and overwriting a live
 * value with a stale one is how a working setup breaks.
 */
function loginShellEnv(): NodeJS.ProcessEnv | null {
  if (cached) return cached;
  try {
    const shell = process.env.SHELL?.trim() || "/bin/zsh";
    // -i (interactive) so the rc file is sourced, -l (login) for the profile,
    // -c for the one command. `env -0` prints NUL-separated records.
    const res = spawnSync(shell, ["-ilc", "env -0"], {
      encoding: "buffer",
      timeout: 10_000,
      // A login shell reads the tty; with no tty it still works, but zsh prints
      // job-control noise to stderr that must not reach the hub's own pipe.
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0 || !res.stdout) {
      // NOT remembered: a shell that timed out or was briefly unavailable must
      // not disable completion for the life of this long-lived daemon. Only a
      // successful probe is cached, so the next call retries.
      log(`env: login shell ${shell} gave no environment (status ${res.status})`);
      return null;
    }
    const out: NodeJS.ProcessEnv = {};
    for (const rec of res.stdout.toString("utf8").split("\0")) {
      if (!rec) continue;
      const eq = rec.indexOf("=");
      if (eq <= 0) continue;
      const key = rec.slice(0, eq);
      const value = rec.slice(eq + 1);
      if (!key || NEVER_COPY.has(key)) continue;
      out[key] = value;
    }
    cached = Object.keys(out).length > 0 ? out : null;
    if (cached) {
      const added = Object.keys(cached).filter((k) => process.env[k] === undefined);
      log(`env: completed from login shell (${added.length} new vars)`);
    }
    return cached;
  } catch (e) {
    warn(`env: login-shell completion failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * `env` plus whatever the login shell knows that it does not.
 *
 * Process-plumbing vars (`ZCODE_ACP_*`, `DSH_TUI_*`, `MARTTY_*`) are never
 * taken from the login shell: they describe THIS process tree, and a stale copy
 * in the user's rc would hijack a spawned session into the wrong origin.
 */
export function envWithLoginShell(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const shell = loginShellEnv();
  if (!shell) return env;
  const merged: NodeJS.ProcessEnv = { ...shell };
  for (const [k, v] of Object.entries(env)) {
    // The caller's own values always win, including a deliberate empty string.
    merged[k] = v;
  }
  for (const key of Object.keys(merged)) {
    if (PINNED_PREFIXES.some((p) => key.startsWith(p)) && env[key] === undefined) {
      delete merged[key];
    }
  }
  return merged;
}

/** Test seam: drop the cache so the next call re-probes. */
export function resetLoginShellEnvForTest(): void {
  cached = null;
}
