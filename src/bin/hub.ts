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

import process from "node:process";

import { parseHubConfig } from "../remote/config.js";
import { startHub } from "../remote/hub-server.js";
import { warn } from "../utils.js";

async function main(): Promise<void> {
  const config = parseHubConfig();
  if (!config) process.exit(1);
  const hub = await startHub({
    port: config.hubPort,
    host: config.hubHost,
    token: config.token,
    onIdleExit: () => process.exit(0),
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
