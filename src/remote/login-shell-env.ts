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
 * The fix is to ask a LOGIN shell for its environment once and cache it: the
 * user's rc files are where mise/nvm/homebrew/rbenv install their PATH entries,
 * and `env -0` prints that environment NUL-separated — the only format that
 * survives a value containing a newline.
 *
 * The probe shell is deliberately NON-INTERACTIVE. An interactive shell (`-i`)
 * arms interactive-only machinery — job control, zle, prompt setup, terminal
 * modes — inside a process that merely wants a value back, and several of the
 * user's own rc tools (compinit, autosuggestions, syntax-highlighting, orbstack)
 * are written for a terminal it does not have. This probe runs inside a
 * terminal-owning process tree (a martty window's bridge), so an interactive
 * child is exactly the wrong thing to start there. The rc file that carries the
 * toolchain paths (`~/.zshrc`) is sourced EXPLICITLY instead, which is all the
 * paths need and none of the interactive state.
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

/** A POSIX env var name: rejects rc stdout noise glued onto a record. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Never copy these even if the login shell sets them.
 *
 * `PWD`/`OLDPWD`/`SHLVL` describe the probing shell's own session. `TMPDIR` is
 * here too: the live process's own temp dir is authoritative (a test harness or
 * a launchd-plist may set it deliberately), and a shell's copy would point
 * spawned children at a different temp tree than their parent uses. `SHELL` and
 * the prompt vars are interactive-shell state — irrelevant to a spawned
 * non-interactive child, and pointless noise in its environment.
 */
const NEVER_COPY = new Set([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TMPDIR",
  "SHELL",
  "PROMPT",
  "PROMPT2",
  "PROMPT3",
  "PROMPT4",
  "RPROMPT",
  "PS1",
  "PS2",
]);

/**
 * Union two PATH values, login shell first. The shell's entries come first
 * because that is the user's own resolution order — the order a tool would get
 * in their terminal — and the caller's entries are appended so nothing the
 * bridge was launched with is lost. Duplicates are dropped, and empty segments
 * (a leading/trailing `:`, which means "cwd" to some tools) are not carried.
 */
function unionPath(shellPath: string | undefined, callerPath: string | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of `${shellPath ?? ""}:${callerPath ?? ""}`.split(":")) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(":");
}

/**
 * `env` plus whatever the login shell knows that it does not.
 *
 * The caller's own values win for every variable EXCEPT `PATH`, which is
 * unioned: a bridge launched by an editor inherits launchd's bare PATH, and if
 * that bare value simply won, the user's toolchain dirs would never be added —
 * which is the entire point of this probe. Process-plumbing vars
 * (`ZCODE_ACP_*`, `DSH_TUI_*`, `MARTTY_*`) are never taken from the login
 * shell: they describe THIS process tree, and a stale copy in the user's rc
 * would hijack a spawned session into the wrong origin.
 */
export function envWithLoginShell(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const shell = loginShellEnv();
  if (!shell) return env;
  const merged: NodeJS.ProcessEnv = { ...shell };
  for (const [k, v] of Object.entries(env)) {
    // The caller's own values always win, including a deliberate empty string —
    // except PATH, which is merged (see the doc above).
    if (k === "PATH") continue;
    merged[k] = v;
  }
  const path = unionPath(shell.PATH, env.PATH);
  if (path) merged.PATH = path;
  for (const key of Object.keys(merged)) {
    if (PINNED_PREFIXES.some((p) => key.startsWith(p)) && env[key] === undefined) {
      delete merged[key];
    }
  }
  return merged;
}

let cached: NodeJS.ProcessEnv | null = null;

/**
 * The command a non-interactive login shell runs to print its environment.
 *
 * A non-interactive login shell reads `/etc/zshenv` + `~/.zshenv` + the login
 * profile (`~/.zprofile`), but NOT `~/.zshrc` — the file interactive shells read,
 * which is where mise/brew/cargo/bun install their PATH entries. So the
 * interactive rc is sourced explicitly (guarded by `-r`) and then the
 * environment is dumped NUL-separated. bash keeps its interactive rc in
 * `~/.bashrc` (and non-login `~/.bash_profile`), so it is listed too. Any other
 * shell gets a bare dump — the profile still contributes.
 */
function probeCommand(shell: string): string {
  const name = shell.split("/").pop() ?? "";
  const rcFiles =
    name === "zsh"
      ? ['"$HOME/.zshrc"']
      : name === "bash"
        ? ['"$HOME/.bash_profile"', '"$HOME/.bashrc"']
        : [];
  if (rcFiles.length === 0) return "env -0";
  const list = rcFiles.join(" ");
  return `for f in ${list}; do [ -r "$f" ] && . "$f"; done; env -0`;
}

/**
 * The login shell's environment, or null when it cannot be obtained.
 *
 * This is the shell's environment as-is (minus NEVER_COPY) — merging policy
 * lives in `envWithLoginShell`. A login shell also carries the ambient
 * session's own values (e.g. a stale `SSH_AUTH_SOCK` from whoever ran it), so
 * the merge must never blindly let it overwrite a live value.
 */
function loginShellEnv(): NodeJS.ProcessEnv | null {
  if (cached) return cached;
  try {
    const shell = process.env.SHELL?.trim() || "/bin/zsh";
    // -l (login) for the profile, -c for the one command; the interactive rc is
    // sourced by the command itself (see probeCommand). Never -i: the child
    // must not arm interactive/terminal machinery inside a live TUI's process
    // tree. `env -0` prints NUL-separated records.
    const res = spawnSync(shell, ["-l", "-c", probeCommand(shell)], {
      encoding: "buffer",
      timeout: 10_000,
      // A login shell writes job-control noise to stderr that must not reach
      // the hub's own pipe.
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
      // A shell whose rc prints to stdout would prepend that text to the first
      // record (`noise\nPATH=…`) — a name regex rejects it rather than
      // installing a garbage variable. Anything not a plain env name is skipped.
      if (!ENV_NAME_RE.test(key) || NEVER_COPY.has(key)) continue;
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

/** Test seam: drop the cache so the next call re-probes. */
export function resetLoginShellEnvForTest(): void {
  cached = null;
}
