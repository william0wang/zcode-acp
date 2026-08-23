#!/usr/bin/env node

/**
 * Standalone zcode-acp-hub daemon entry.
 *
 * Usually spawned detached by the first bridge that enables remote access
 * (see src/remote/endpoint.ts); running it manually is also fine, e.g. under
 * launchd/systemd or directly for debugging:
 *
 *   ZCODE_ACP_REMOTE_TOKEN=<secret> zcode-acp-hub
 *
 * Refuses to start without ZCODE_ACP_REMOTE_TOKEN — the hub is the only public
 * entry point and never runs unauthenticated. Exits 0 on EADDRINUSE: another
 * hub already owns the port, which is the desired machine-singleton behaviour.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseHubConfig } from "../remote/config.js";
import { startHub } from "../remote/hub-server.js";
import { log, warn } from "../utils.js";

/**
 * Re-exec the hub from the on-disk dist (the freshest build) and exit. Runs
 * after close() released the port, so the child binds cleanly; bridges racing
 * to re-spawn the hub lose politely via the EADDRINUSE singleton behaviour.
 * stdio is fully ignored — the parent exits immediately, and a piped stderr
 * would EPIPE the child on its first log line.
 */
function respawnSelf(): void {
  try {
    // bin/hub.js → ../bin/hub.js is itself (this file's compiled location).
    const hubJs = fileURLToPath(new URL("../bin/hub.js", import.meta.url));
    const child = spawn(process.execPath, [hubJs], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    log(`hub: respawned from ${hubJs} (pid ${child.pid})`);
  } catch (e) {
    warn(
      `hub: respawn failed (${e instanceof Error ? e.message : String(e)})` +
        " — bridges will re-spawn the hub on their next heartbeat",
    );
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const config = parseHubConfig();
  if (!config) process.exit(1);
  const hub = await startHub({
    port: config.hubPort,
    host: config.hubHost,
    token: config.token,
    onIdleExit: () => process.exit(0),
    onRestart: respawnSelf,
  });
  process.on("SIGTERM", () => void hub.close().then(() => process.exit(0)));
  process.on("SIGINT", () => void hub.close().then(() => process.exit(0)));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    // Another hub already listens on this port — nothing to do.
    process.exit(0);
  }
  warn(`hub: fatal: ${message}`);
  process.exit(1);
});
