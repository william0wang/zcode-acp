/**
 * Directory-watch liveness for the workflow lists (desktop hub parity: the
 * desktop host watches the workflow dirs and refreshes its panel; headless,
 * the bridge IS the host, so it watches and broadcasts). One debounced
 * `$/zcode/workflowListChanged` notification fans out to every attached ACP
 * client on ANY change source — the save tool, a settings-route write, an
 * editor editing the file directly. Instance-scoped by design: clients of
 * THIS bridge hear THIS project's dir plus the machine-global dir; other
 * instances' lists still refresh through the management page's own poll.
 */
import { watch } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ZcodeAcpServer } from "../server.js";
import { log } from "../utils.js";

export const WORKFLOW_LIST_CHANGED = "$/zcode/workflowListChanged";

/** Save bursts (write + rename + meta) collapse into one notification. */
const DEBOUNCE_MS = 1_500;

/** Dirs a watcher is already bound to; a missing dir is retried on re-arm. */
const watched = new Set<string>();

let timer: NodeJS.Timeout | null = null;

function ping(server: ZcodeAcpServer): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    server.clients
      .broadcast()
      .notify(WORKFLOW_LIST_CHANGED, {})
      .catch(() => undefined);
  }, DEBOUNCE_MS);
  timer.unref?.();
}

/**
 * Bind watchers for the project and global workflow dirs. Idempotent per
 * dir; a dir that does not exist yet (no workflow ever saved) is retried on
 * the next arm — the workflow routes re-arm on every read, so the watcher
 * converges within one poll after the first save creates the dir. Watchers
 * are unref'd: they never keep the process alive.
 */
export function armWorkflowListWatch(server: ZcodeAcpServer): void {
  const dirs = [
    path.join(server.projectCwd(), ".zcode", "workflows"),
    path.join(homedir(), ".zcode", "workflows"),
  ];
  let bound = false;
  for (const dir of dirs) {
    if (watched.has(dir)) continue;
    try {
      const watcher = watch(dir, { persistent: false }, () => ping(server));
      // An FSWatcher 'error' with no listener THROWS (e.g. the dir vanished);
      // drop the binding instead and let the next arm re-bind.
      watcher.on("error", () => {
        watched.delete(dir);
        watcher.close();
      });
      watcher.unref();
      watched.add(dir);
      bound = true;
    } catch {
      // Absent dir — retried on the next arm call.
    }
  }
  if (bound) log(`workflow list watch armed over ${dirs.length} candidate dirs`);
}
