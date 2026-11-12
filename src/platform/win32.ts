/**
 * Windows-specific process helpers.
 *
 * Windows has no POSIX process groups: `process.kill(-pid)` cannot reap a
 * tree. Every backend-group kill funnels through `killTree` here — POSIX
 * keeps the group-signal semantics, Windows uses `taskkill /T /F`.
 */

import { spawn } from "node:child_process";

export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Kill the whole process tree rooted at `pid`.
 *
 * POSIX: group SIGKILL (the caller previously used `process.kill(-pid)`).
 * Windows: `taskkill /T /F` — `/T` walks the tree, `/F` force-terminates
 * (console children ignore graceful WM_CLOSE, so the non-/F form is useless
 * for a Node child with piped stdio).
 */
export function killTree(pid: number): void {
  if (!isWindows()) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // group already gone
    }
    return;
  }
  try {
    const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    // taskkill itself missing (PATH stripped) → last-resort single kill.
    tk.on("error", () => {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    });
  } catch {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
}

/** POSIX group-liveness probe; Windows has no group → falls back to the root pid. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(isWindows() ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}
