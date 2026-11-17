#!/usr/bin/env node
/**
 * Cross-platform postinstall hook.
 *
 * Runs `dist/remote/hub-upgrade-notify.js` if it exists.
 * Any errors (e.g. unbuilt dist during development or hub unreachable)
 * are completely silent and always exit 0.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distTarget = path.resolve(
  fileURLToPath(import.meta.url),
  "../../dist/remote/hub-upgrade-notify.js",
);

if (existsSync(distTarget)) {
  try {
    await import(pathToFileURL(distTarget).href);
  } catch {
    // Best-effort notification; swallow errors silently.
  }
}
process.exit(0);
